import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FileCheckResultCache, MemoryCheckResultCache } from "../../src/core/cache.ts"
import { buildCacheKey } from "../../src/core/cache.ts"
import type { CacheKeyParts } from "../../src/core/cache.ts"
import { DEFAULT_CACHE_TTL_MS } from "../../src/core/cache.ts"
import type { CheckResult } from "../../src/core/types.ts"
import { FakeTime } from "../helpers/time.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sampleKeyParts(overrides?: Partial<CacheKeyParts>): CacheKeyParts {
  return {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    resourceType: "apt",
    resourceName: "nginx",
    inputJson: '{"pkg":"nginx"}',
    ...overrides,
  }
}

function sampleCheckResult(inDesiredState = true): CheckResult<string> {
  return {
    inDesiredState,
    current: { installed: inDesiredState },
    desired: { installed: true },
    output: inDesiredState ? "already-ok" : undefined,
  }
}

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

test("buildCacheKey — includes all components", () => {
  const key = buildCacheKey(sampleKeyParts())

  expect(key.includes("10.0.1.10")).toEqual(true)
  expect(key.includes("22")).toEqual(true)
  expect(key.includes("deploy")).toEqual(true)
  expect(key.includes("apt")).toEqual(true)
  expect(key.includes("nginx")).toEqual(true)
  expect(key.includes('{"pkg":"nginx"}')).toEqual(true)
})

test("buildCacheKey — different inputs produce different keys", () => {
  const key1 = buildCacheKey(sampleKeyParts({ resourceName: "nginx" }))
  const key2 = buildCacheKey(sampleKeyParts({ resourceName: "curl" }))

  expect(key1 !== key2).toEqual(true)
})

test("buildCacheKey — different hosts produce different keys", () => {
  const key1 = buildCacheKey(sampleKeyParts({ hostname: "10.0.1.10" }))
  const key2 = buildCacheKey(sampleKeyParts({ hostname: "10.0.1.20" }))

  expect(key1 !== key2).toEqual(true)
})

test("buildCacheKey — different ports produce different keys", () => {
  const key1 = buildCacheKey(sampleKeyParts({ port: 22 }))
  const key2 = buildCacheKey(sampleKeyParts({ port: 2222 }))

  expect(key1 !== key2).toEqual(true)
})

test("buildCacheKey — different users produce different keys", () => {
  const key1 = buildCacheKey(sampleKeyParts({ user: "deploy" }))
  const key2 = buildCacheKey(sampleKeyParts({ user: "root" }))

  expect(key1 !== key2).toEqual(true)
})

test("buildCacheKey — same inputs produce same key", () => {
  const key1 = buildCacheKey(sampleKeyParts())
  const key2 = buildCacheKey(sampleKeyParts())

  expect(key1).toEqual(key2)
})

// ---------------------------------------------------------------------------
// MemoryCheckResultCache — basic operations
// ---------------------------------------------------------------------------

test("get returns miss for unknown key", () => {
  const cache = new MemoryCheckResultCache()
  const lookup = cache.get("unknown-key")

  expect(lookup.hit).toEqual(false)
  expect(lookup.result).toEqual(undefined)
  expect(lookup.ageMs).toEqual(undefined)
})

test("set then get returns hit with result", () => {
  const cache = new MemoryCheckResultCache()
  const result = sampleCheckResult()
  const key = "test-key"

  cache.set(key, result)
  const lookup = cache.get(key)

  expect(lookup.hit).toEqual(true)
  expect(lookup.result?.inDesiredState).toEqual(true)
  expect(lookup.result?.current).toEqual({ installed: true })
  expect(lookup.result?.desired).toEqual({ installed: true })
  expect(typeof lookup.ageMs).toEqual("number")
})

test("set overwrites existing entry", () => {
  const cache = new MemoryCheckResultCache()
  const key = "test-key"

  cache.set(key, sampleCheckResult(true))
  cache.set(key, sampleCheckResult(false))

  const lookup = cache.get(key)
  expect(lookup.hit).toEqual(true)
  expect(lookup.result?.inDesiredState).toEqual(false)
})

test("clear removes all entries", () => {
  const cache = new MemoryCheckResultCache()

  cache.set("key-1", sampleCheckResult())
  cache.set("key-2", sampleCheckResult())
  expect(cache.size).toEqual(2)

  cache.clear()

  expect(cache.size).toEqual(0)
  expect(cache.get("key-1").hit).toEqual(false)
  expect(cache.get("key-2").hit).toEqual(false)
})

test("size returns count of entries", () => {
  const cache = new MemoryCheckResultCache()

  expect(cache.size).toEqual(0)

  cache.set("key-1", sampleCheckResult())
  expect(cache.size).toEqual(1)

  cache.set("key-2", sampleCheckResult())
  expect(cache.size).toEqual(2)
})

// ---------------------------------------------------------------------------
// MemoryCheckResultCache — TTL expiration
// ---------------------------------------------------------------------------

test("expired entry returns miss", () => {
  using time = new FakeTime()
  const cache = new MemoryCheckResultCache({ ttlMs: 1000 })

  cache.set("key", sampleCheckResult())

  // Still valid
  time.tick(500)
  expect(cache.get("key").hit).toEqual(true)

  // Expired
  time.tick(501)
  expect(cache.get("key").hit).toEqual(false)
})

test("expired entry is evicted on access", () => {
  using time = new FakeTime()
  const cache = new MemoryCheckResultCache({ ttlMs: 100 })

  cache.set("key", sampleCheckResult())
  time.tick(101)

  // Access evicts the entry
  cache.get("key")
  expect(cache.size).toEqual(0)
})

test("size excludes expired entries", () => {
  using time = new FakeTime()
  const cache = new MemoryCheckResultCache({ ttlMs: 100 })

  cache.set("key-1", sampleCheckResult())
  time.tick(50)
  cache.set("key-2", sampleCheckResult())

  // key-1 is 50ms old, key-2 is 0ms old — both valid
  expect(cache.size).toEqual(2)

  // key-1 expires at 100ms, key-2 at 150ms
  time.tick(51)
  expect(cache.size).toEqual(1) // only key-2 is valid
})

test("ageMs reflects time since storage", () => {
  using time = new FakeTime()
  const cache = new MemoryCheckResultCache({ ttlMs: 10000 })

  cache.set("key", sampleCheckResult())
  time.tick(500)

  const lookup = cache.get("key")
  expect(lookup.hit).toEqual(true)
  expect(lookup.ageMs).toEqual(500)
})

test("default TTL is DEFAULT_CACHE_TTL_MS", () => {
  using time = new FakeTime()
  const cache = new MemoryCheckResultCache()

  cache.set("key", sampleCheckResult())

  // Just before default TTL
  time.tick(DEFAULT_CACHE_TTL_MS - 1)
  expect(cache.get("key").hit).toEqual(true)

  // At default TTL + 1
  time.tick(2)
  expect(cache.get("key").hit).toEqual(false)
})

// ---------------------------------------------------------------------------
// FileCheckResultCache — persistence
// ---------------------------------------------------------------------------

test("file cache persists entries across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  const path = `${dir}/check-cache.json`
  try {
    const key = "persist-key"
    const result = sampleCheckResult(true)

    const first = new FileCheckResultCache({ path, ttlMs: 10_000 })
    first.set(key, result)
    expect(first.get(key).hit).toEqual(true)

    const second = new FileCheckResultCache({ path, ttlMs: 10_000 })
    const lookup = second.get(key)
    expect(lookup.hit).toEqual(true)
    expect(lookup.result?.inDesiredState).toEqual(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file cache clear removes persisted entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  const path = `${dir}/check-cache.json`
  try {
    const cache = new FileCheckResultCache({ path, ttlMs: 10_000 })
    cache.set("k1", sampleCheckResult(true))
    cache.set("k2", sampleCheckResult(false))
    expect(cache.size).toEqual(2)

    cache.clear()
    expect(cache.size).toEqual(0)

    const reloaded = new FileCheckResultCache({ path, ttlMs: 10_000 })
    expect(reloaded.get("k1").hit).toEqual(false)
    expect(reloaded.get("k2").hit).toEqual(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file cache ignores expired entries on load", () => {
  using time = new FakeTime()
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  const path = `${dir}/check-cache.json`
  try {
    const cache = new FileCheckResultCache({ path, ttlMs: 100 })
    cache.set("k1", sampleCheckResult(true))
    time.tick(101)

    const reloaded = new FileCheckResultCache({ path, ttlMs: 100 })
    expect(reloaded.get("k1").hit).toEqual(false)
    expect(reloaded.size).toEqual(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
