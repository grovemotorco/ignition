import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { MemoryCheckResultCache } from "../../src/core/cache.ts"
import type {
  CheckResult,
  CheckResultCache,
  HostContext,
  Reporter,
  ResourceDefinition,
  ResourceResult,
} from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubConnection(): SSHConnection {
  const config: SSHConnectionConfig = {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    hostKeyPolicy: "strict",
  }
  return {
    config,
    capabilities() {
      return ALL_TRANSPORT_CAPABILITIES
    },
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }
}

function stubHost(): HostContext {
  return {
    name: "web-1",
    hostname: "10.0.1.10",
    user: "deploy",
    port: 22,
    vars: {},
  }
}

interface ReporterCalls {
  starts: Array<{ type: string; name: string }>
  ends: ResourceResult[]
}

function trackingReporter(): { reporter: Reporter; calls: ReporterCalls } {
  const calls: ReporterCalls = { starts: [], ends: [] }
  return {
    reporter: {
      resourceStart(type: string, name: string) {
        calls.starts.push({ type, name })
      },
      resourceEnd(result: ResourceResult) {
        calls.ends.push(result)
      },
    },
    calls,
  }
}

function makeCtx(
  overrides: Partial<{
    mode: "apply" | "check"
    errorMode: "fail-fast" | "fail-at-end" | "ignore"
    reporter: Reporter
    cache: CheckResultCache
  }> = {},
): ExecutionContextImpl {
  const { reporter: r } = trackingReporter()
  return new ExecutionContextImpl({
    connection: stubConnection(),
    mode: overrides.mode ?? "check",
    errorMode: overrides.errorMode ?? "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: overrides.reporter ?? r,
    cache: overrides.cache,
  })
}

function testResource(opts: {
  inDesiredState: boolean
}): ResourceDefinition<{ pkg: string }, string> {
  return {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(_ctx, _input): Promise<CheckResult<string>> {
      return Promise.resolve({
        inDesiredState: opts.inDesiredState,
        current: { installed: opts.inDesiredState },
        desired: { installed: true },
        output: opts.inDesiredState ? "already-ok" : undefined,
      })
    },
    apply(_ctx, _input): Promise<string> {
      return Promise.resolve("applied")
    },
  }
}

function countingResource(): {
  def: ResourceDefinition<{ pkg: string }, string>
  checkCalls: () => number
} {
  let calls = 0
  return {
    def: {
      type: "test",
      formatName(input) {
        return input.pkg
      },
      check(_ctx, _input): Promise<CheckResult<string>> {
        calls++
        return Promise.resolve({
          inDesiredState: true,
          current: { installed: true },
          desired: { installed: true },
          output: "ok",
        })
      },
      apply(_ctx, _input): Promise<string> {
        return Promise.resolve("applied")
      },
    },
    checkCalls: () => calls,
  }
}

// ---------------------------------------------------------------------------
// Cache integration — check mode
// ---------------------------------------------------------------------------

test("cache miss — stores result and marks cacheHit=false", async () => {
  const cache = new MemoryCheckResultCache()
  const ctx = makeCtx({ mode: "check", cache })
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("ok")
  expect(result.cacheHit).toEqual(false)
  expect(result.cacheAgeMs).toEqual(undefined)
  expect(cache.size).toEqual(1)
})

test("cache hit — returns cached result without calling check()", async () => {
  const cache = new MemoryCheckResultCache()
  const { def, checkCalls } = countingResource()

  // First call: cache miss, populates cache
  const ctx1 = makeCtx({ mode: "check", cache })
  await executeResource(ctx1, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })
  expect(checkCalls()).toEqual(1)

  // Second call: cache hit, skips check()
  const ctx2 = makeCtx({ mode: "check", cache })
  const result = await executeResource(ctx2, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("ok")
  expect(result.cacheHit).toEqual(true)
  expect(typeof result.cacheAgeMs).toEqual("number")
  expect(checkCalls()).toEqual(1) // check() was NOT called again
})

test("cache hit preserves status from cached check result", async () => {
  const cache = new MemoryCheckResultCache()
  const def = testResource({ inDesiredState: false })

  // First call: populates cache with inDesiredState=false (status=changed)
  const ctx1 = makeCtx({ mode: "check", cache })
  const r1 = await executeResource(ctx1, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })
  expect(r1.status).toEqual("changed")
  expect(r1.cacheHit).toEqual(false)

  // Second call: cache hit with status=changed
  const ctx2 = makeCtx({ mode: "check", cache })
  const r2 = await executeResource(ctx2, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })
  expect(r2.status).toEqual("changed")
  expect(r2.cacheHit).toEqual(true)
})

// ---------------------------------------------------------------------------
// Cache integration — apply mode bypasses cache
// ---------------------------------------------------------------------------

test("apply mode — never uses cache even when available", async () => {
  const cache = new MemoryCheckResultCache()
  const { def, checkCalls } = countingResource()

  // Populate cache in check mode
  const ctx1 = makeCtx({ mode: "check", cache })
  await executeResource(ctx1, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })
  expect(checkCalls()).toEqual(1)

  // Apply mode should always call check() live
  const ctx2 = makeCtx({ mode: "apply", cache })
  const result = await executeResource(ctx2, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("ok")
  expect(result.cacheHit).toEqual(undefined) // no cache metadata in apply mode
  expect(checkCalls()).toEqual(2) // check() WAS called again
})

test("apply mode — does not populate cache", async () => {
  const cache = new MemoryCheckResultCache()
  const def = testResource({ inDesiredState: true })

  const ctx = makeCtx({ mode: "apply", cache })
  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(cache.size).toEqual(0)
})

// ---------------------------------------------------------------------------
// Cache integration — no cache (default behavior)
// ---------------------------------------------------------------------------

test("no cache — result has no cacheHit field", async () => {
  const ctx = makeCtx({ mode: "check" })
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("ok")
  expect(result.cacheHit).toEqual(undefined)
  expect(result.cacheAgeMs).toEqual(undefined)
})

// ---------------------------------------------------------------------------
// Cache integration — different inputs use different keys
// ---------------------------------------------------------------------------

test("different inputs are cached separately", async () => {
  const cache = new MemoryCheckResultCache()
  const { def, checkCalls } = countingResource()

  const ctx1 = makeCtx({ mode: "check", cache })
  await executeResource(ctx1, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  const ctx2 = makeCtx({ mode: "check", cache })
  await executeResource(ctx2, def, { pkg: "curl" }, { retries: 0, timeoutMs: 0 })

  expect(checkCalls()).toEqual(2) // both called check() independently
  expect(cache.size).toEqual(2)
})

// ---------------------------------------------------------------------------
// Cache integration — result accumulation
// ---------------------------------------------------------------------------

test("cache hit result is pushed to ctx.results", async () => {
  const cache = new MemoryCheckResultCache()
  const def = testResource({ inDesiredState: true })

  // Populate
  const ctx1 = makeCtx({ mode: "check", cache })
  await executeResource(ctx1, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  // Cache hit
  const ctx2 = makeCtx({ mode: "check", cache })
  await executeResource(ctx2, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(ctx2.results.length).toEqual(1)
  expect(ctx2.results[0].cacheHit).toEqual(true)
})

test("cache hit result is reported via reporter", async () => {
  const cache = new MemoryCheckResultCache()
  const def = testResource({ inDesiredState: true })

  // Populate
  const ctx1 = makeCtx({ mode: "check", cache })
  await executeResource(ctx1, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  // Cache hit with tracking reporter
  const { reporter, calls } = trackingReporter()
  const ctx2 = makeCtx({ mode: "check", cache, reporter })
  await executeResource(ctx2, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(calls.starts.length).toEqual(1)
  expect(calls.ends.length).toEqual(1)
  expect(calls.ends[0].cacheHit).toEqual(true)
})
