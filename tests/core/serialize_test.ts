import { test, expect } from "bun:test"
/** Unit tests for stableStringify() and redact(). */

import { redact, stableStringify } from "../../src/core/serialize.ts"
import { buildCacheKey } from "../../src/core/cache.ts"
import type { CacheKeyParts } from "../../src/core/cache.ts"

// ---------------------------------------------------------------------------
// stableStringify — key ordering
// ---------------------------------------------------------------------------

test("stableStringify — sorts top-level keys", () => {
  const result = stableStringify({ b: 2, a: 1 })
  expect(result).toEqual('{"a":1,"b":2}')
})

test("stableStringify — sorts nested object keys", () => {
  const result = stableStringify({ z: { b: 2, a: 1 }, a: 0 })
  expect(result).toEqual('{"a":0,"z":{"a":1,"b":2}}')
})

test("stableStringify — deeply nested objects sort at every level", () => {
  const result = stableStringify({ c: { b: { z: 1, a: 2 }, a: 0 }, a: "top" })
  expect(result).toEqual('{"a":"top","c":{"a":0,"b":{"a":2,"z":1}}}')
})

test("stableStringify — different key order produces identical output", () => {
  const a = stableStringify({ x: 1, y: 2, z: 3 })
  const b = stableStringify({ z: 3, x: 1, y: 2 })
  expect(a).toEqual(b)
})

// ---------------------------------------------------------------------------
// stableStringify — arrays
// ---------------------------------------------------------------------------

test("stableStringify — preserves array element order", () => {
  const result = stableStringify([3, 1, 2])
  expect(result).toEqual("[3,1,2]")
})

test("stableStringify — sorts keys within array elements", () => {
  const result = stableStringify([
    { b: 2, a: 1 },
    { d: 4, c: 3 },
  ])
  expect(result).toEqual('[{"a":1,"b":2},{"c":3,"d":4}]')
})

test("stableStringify — handles mixed arrays", () => {
  const result = stableStringify([1, "two", null, { b: 2, a: 1 }])
  expect(result).toEqual('[1,"two",null,{"a":1,"b":2}]')
})

// ---------------------------------------------------------------------------
// stableStringify — edge cases
// ---------------------------------------------------------------------------

test("stableStringify — handles null", () => {
  expect(stableStringify(null)).toEqual("null")
})

test("stableStringify — handles undefined", () => {
  // JSON.stringify(undefined) returns undefined, but our function wraps it
  expect(stableStringify(undefined)).toBeUndefined()
})

test("stableStringify — handles primitives", () => {
  expect(stableStringify(42)).toEqual("42")
  expect(stableStringify("hello")).toEqual('"hello"')
  expect(stableStringify(true)).toEqual("true")
})

test("stableStringify — handles empty object", () => {
  expect(stableStringify({})).toEqual("{}")
})

test("stableStringify — handles empty array", () => {
  expect(stableStringify([])).toEqual("[]")
})

test("stableStringify — handles undefined values in objects", () => {
  // JSON.stringify omits undefined values
  const result = stableStringify({ a: 1, b: undefined, c: 3 })
  expect(result).toEqual('{"a":1,"c":3}')
})

test("stableStringify — circular reference guard", () => {
  const obj: Record<string, unknown> = { a: 1 }
  obj.self = obj
  const result = stableStringify(obj)
  expect(result).toEqual('{"a":1,"self":"[Circular]"}')
})

test("stableStringify — handles Date objects", () => {
  const date = new Date("2024-01-01T00:00:00.000Z")
  const result = stableStringify({ date })
  expect(result).toEqual(`{"date":"2024-01-01T00:00:00.000Z"}`)
})

// ---------------------------------------------------------------------------
// redact — no-op cases
// ---------------------------------------------------------------------------

test("redact — returns value unchanged with no policy", () => {
  const obj = { password: "secret", user: "admin" }
  const result = redact(obj)
  expect(result).toEqual(obj)
})

test("redact — returns value unchanged with empty patterns", () => {
  const obj = { password: "secret", user: "admin" }
  const result = redact(obj, { patterns: [] })
  expect(result).toEqual(obj)
})

// ---------------------------------------------------------------------------
// redact — simple paths
// ---------------------------------------------------------------------------

test("redact — redacts top-level field by name", () => {
  const obj = { password: "secret", user: "admin" }
  const result = redact(obj, { patterns: ["password"] })
  expect(result).toEqual({ password: "[REDACTED]", user: "admin" })
})

test("redact — redacts nested field by full path", () => {
  const obj = { db: { password: "secret", host: "localhost" } }
  const result = redact(obj, { patterns: ["db.password"] })
  expect(result).toEqual({ db: { password: "[REDACTED]", host: "localhost" } })
})

test("redact — does not modify original value", () => {
  const obj = { password: "secret", user: "admin" }
  redact(obj, { patterns: ["password"] })
  expect(obj.password).toEqual("secret")
})

// ---------------------------------------------------------------------------
// redact — glob patterns
// ---------------------------------------------------------------------------

test("redact — wildcard matches any single segment", () => {
  const obj = {
    db: { password: "secret1" },
    api: { password: "secret2" },
    user: "admin",
  }
  const result = redact(obj, { patterns: ["*.password"] })
  expect(result).toEqual({
    db: { password: "[REDACTED]" },
    api: { password: "[REDACTED]" },
    user: "admin",
  })
})

test("redact — intra-segment wildcard (prefix match)", () => {
  const obj = {
    vars: {
      db_host: "localhost",
      db_pass: "secret",
      app_name: "myapp",
    },
  }
  const result = redact(obj, { patterns: ["vars.db_*"] })
  expect(result).toEqual({
    vars: {
      db_host: "[REDACTED]",
      db_pass: "[REDACTED]",
      app_name: "myapp",
    },
  })
})

test("redact — globstar matches zero or more segments", () => {
  const obj = {
    a: { b: { secret: "deep" } },
    secret: "top",
  }
  const result = redact(obj, { patterns: ["**.secret"] })
  expect(result).toEqual({
    a: { b: { secret: "[REDACTED]" } },
    secret: "[REDACTED]",
  })
})

// ---------------------------------------------------------------------------
// redact — nested objects
// ---------------------------------------------------------------------------

test("redact — handles deeply nested redaction", () => {
  const obj = {
    level1: {
      level2: {
        level3: {
          token: "abc123",
          name: "test",
        },
      },
    },
  }
  const result = redact(obj, { patterns: ["level1.level2.level3.token"] })
  expect(result).toEqual({
    level1: {
      level2: {
        level3: {
          token: "[REDACTED]",
          name: "test",
        },
      },
    },
  })
})

test("redact — multiple patterns applied together", () => {
  const obj = {
    password: "p1",
    token: "tok",
    user: "admin",
    config: { api_key: "key123", host: "localhost" },
  }
  const result = redact(obj, { patterns: ["password", "token", "config.api_key"] })
  expect(result).toEqual({
    password: "[REDACTED]",
    token: "[REDACTED]",
    user: "admin",
    config: { api_key: "[REDACTED]", host: "localhost" },
  })
})

// ---------------------------------------------------------------------------
// redact — custom marker
// ---------------------------------------------------------------------------

test("redact — uses custom marker", () => {
  const obj = { password: "secret", user: "admin" }
  const result = redact(obj, { patterns: ["password"], marker: "***" })
  expect(result).toEqual({ password: "***", user: "admin" })
})

// ---------------------------------------------------------------------------
// redact — arrays
// ---------------------------------------------------------------------------

test("redact — handles arrays of objects", () => {
  const obj = {
    users: [
      { name: "alice", password: "p1" },
      { name: "bob", password: "p2" },
    ],
  }
  const result = redact(obj, { patterns: ["users.*.password"] })
  expect(result).toEqual({
    users: [
      { name: "alice", password: "[REDACTED]" },
      { name: "bob", password: "[REDACTED]" },
    ],
  })
})

// ---------------------------------------------------------------------------
// redact — primitives and nulls
// ---------------------------------------------------------------------------

test("redact — returns null unchanged", () => {
  expect(redact(null, { patterns: ["foo"] })).toEqual(null)
})

test("redact — returns undefined unchanged", () => {
  expect(redact(undefined, { patterns: ["foo"] })).toEqual(undefined)
})

test("redact — returns string unchanged", () => {
  expect(redact("hello", { patterns: ["foo"] })).toEqual("hello")
})

// ---------------------------------------------------------------------------
// redact — Error and Date handling
// ---------------------------------------------------------------------------

test("redact — preserves Error shape and supports message redaction", () => {
  const obj = {
    result: {
      error: new Error("token=secret"),
      status: "failed",
    },
  }

  const result = redact(obj, { patterns: ["**.error.message"] })

  expect(result).toEqual({
    result: {
      error: { message: "[REDACTED]", name: "Error" },
      status: "failed",
    },
  })
})

test("redact — preserves Date objects for JSON serialization", () => {
  const date = new Date("2024-01-01T00:00:00.000Z")
  const result = redact({ date }, { patterns: ["secret"] }) as { date: Date }

  expect(result.date instanceof Date).toEqual(true)
  expect(JSON.stringify(result)).toEqual('{"date":"2024-01-01T00:00:00.000Z"}')
})

// ---------------------------------------------------------------------------
// Cache key stability
// ---------------------------------------------------------------------------

function sampleKeyParts(overrides?: Partial<CacheKeyParts>): CacheKeyParts {
  return {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    resourceType: "apt",
    resourceName: "nginx",
    inputJson: stableStringify({ pkg: "nginx", state: "present" }),
    ...overrides,
  }
}

test("cache key stability — same input with different key order produces identical cache key", () => {
  const key1 = buildCacheKey(
    sampleKeyParts({
      inputJson: stableStringify({ state: "present", pkg: "nginx" }),
    }),
  )
  const key2 = buildCacheKey(
    sampleKeyParts({
      inputJson: stableStringify({ pkg: "nginx", state: "present" }),
    }),
  )
  expect(key1).toEqual(key2)
})

test("cache key stability — nested objects with different key order produce identical key", () => {
  const key1 = buildCacheKey(
    sampleKeyParts({
      inputJson: stableStringify({ opts: { b: 2, a: 1 }, name: "test" }),
    }),
  )
  const key2 = buildCacheKey(
    sampleKeyParts({
      inputJson: stableStringify({ name: "test", opts: { a: 1, b: 2 } }),
    }),
  )
  expect(key1).toEqual(key2)
})

test("cache key stability — different values produce different keys", () => {
  const key1 = buildCacheKey(
    sampleKeyParts({
      inputJson: stableStringify({ pkg: "nginx" }),
    }),
  )
  const key2 = buildCacheKey(
    sampleKeyParts({
      inputJson: stableStringify({ pkg: "curl" }),
    }),
  )
  expect(key1).not.toEqual(key2)
})
