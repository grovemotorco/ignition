import { test, expect } from "bun:test"
import { expectRejection } from "../helpers/expect-error.ts"
import type { ResourceCallMeta } from "../../src/core/types.ts"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource, resolvePolicy, wrapTransport } from "../../src/core/resource.ts"
import { ResourceError, SSHConnectionError, TransferError } from "../../src/core/errors.ts"
import type {
  CheckResult,
  ExecOptions,
  HostContext,
  Reporter,
  ResourceDefinition,
  ResourceResult,
} from "../../src/core/types.ts"
import { DEFAULT_RESOURCE_POLICY } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"
import { EventBus } from "../../src/output/events.ts"
import type {
  LifecycleEvent,
  ResourceFinishedEvent,
  ResourceOutputEvent,
  ResourceRetryEvent,
  ResourceStartedEvent,
} from "../../src/output/events.ts"

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

type ReporterCalls = {
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
  }> = {},
): ExecutionContextImpl {
  const { reporter: r } = trackingReporter()
  return new ExecutionContextImpl({
    connection: stubConnection(),
    mode: overrides.mode ?? "apply",
    errorMode: overrides.errorMode ?? "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: overrides.reporter ?? r,
  })
}

/** A simple resource definition for testing. */
function testResource(opts: {
  inDesiredState: boolean
  applyOutput?: string
  checkError?: Error
  applyError?: Error
}): ResourceDefinition<{ pkg: string }, string> {
  return {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(_ctx, _input): Promise<CheckResult<string>> {
      if (opts.checkError) return Promise.reject(opts.checkError)
      return Promise.resolve({
        inDesiredState: opts.inDesiredState,
        current: { installed: opts.inDesiredState },
        desired: { installed: true },
        output: opts.inDesiredState ? "already-ok" : undefined,
      })
    },
    apply(_ctx, _input): Promise<string> {
      if (opts.applyError) return Promise.reject(opts.applyError)
      return Promise.resolve(opts.applyOutput ?? "applied")
    },
  }
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test("ok — resource already in desired state", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("ok")
  expect(result.type).toEqual("test")
  expect(result.name).toEqual("nginx")
  expect(result.output).toEqual("already-ok")
  expect(result.current).toEqual({ installed: true })
  expect(result.desired).toEqual({ installed: true })
})

test("changed — apply mode, not in desired state", async () => {
  const ctx = makeCtx({ mode: "apply" })
  const def = testResource({ inDesiredState: false, applyOutput: "installed" })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("changed")
  expect(result.output).toEqual("installed")
  expect(result.current).toEqual({ installed: false })
  expect(result.desired).toEqual({ installed: true })
})

test("changed — check mode, not in desired state (no apply called)", async () => {
  let applyCalled = false
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      applyCalled = true
      return Promise.resolve("applied")
    },
  }

  const ctx = makeCtx({ mode: "check" })
  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("changed")
  expect(applyCalled).toEqual(false)
  expect(result.output).toEqual(undefined)
})

test("failed — check() throws", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def = testResource({
    inDesiredState: false,
    checkError: new Error("check boom"),
  })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("failed")
  expect(result.error?.message).toEqual("check boom")
})

test("failed — apply() throws", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def = testResource({
    inDesiredState: false,
    applyError: new Error("apply boom"),
  })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("failed")
  expect(result.error?.message).toEqual("apply boom")
})

// ---------------------------------------------------------------------------
// Error mode handling
// ---------------------------------------------------------------------------

test("fail-fast — re-throws ResourceError on failure", async () => {
  const ctx = makeCtx({ errorMode: "fail-fast" })
  const def = testResource({
    inDesiredState: false,
    applyError: new Error("boom"),
  })

  const err = await expectRejection(() => executeResource(ctx, def, { pkg: "nginx" }))
  expect(err.message).toContain("boom")
  // Result is still pushed before throwing
  expect(ctx.results.length).toEqual(1)
  expect(ctx.results[0].status).toEqual("failed")
})

test("fail-fast — preserves ResourceError if already a ResourceError", async () => {
  const ctx = makeCtx({ errorMode: "fail-fast" })
  const original = new ResourceError("test", "nginx", "original error")
  const def = testResource({
    inDesiredState: false,
    applyError: original,
  })

  const err = await expectRejection(
    () => executeResource(ctx, def, { pkg: "nginx" }),
    ResourceError,
  )
  expect(err).toBe(original)
})

test("fail-at-end — does not throw on failure", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def = testResource({
    inDesiredState: false,
    applyError: new Error("boom"),
  })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("failed")
  expect(ctx.results.length).toEqual(1)
})

test("ignore — does not throw on failure", async () => {
  const ctx = makeCtx({ errorMode: "ignore" })
  const def = testResource({
    inDesiredState: false,
    applyError: new Error("boom"),
  })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("failed")
  expect(ctx.results.length).toEqual(1)
})

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

test("records positive durationMs", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.durationMs).toBeGreaterThan(-1)
  expect(typeof result.durationMs).toEqual("number")
})

// ---------------------------------------------------------------------------
// Results accumulation
// ---------------------------------------------------------------------------

test("pushes results to ctx.results", async () => {
  const ctx = makeCtx()
  const defOk = testResource({ inDesiredState: true })
  const defChanged = testResource({ inDesiredState: false })

  await executeResource(ctx, defOk, { pkg: "curl" })
  await executeResource(ctx, defChanged, { pkg: "nginx" })

  expect(ctx.results.length).toEqual(2)
  expect(ctx.results[0].status).toEqual("ok")
  expect(ctx.results[0].name).toEqual("curl")
  expect(ctx.results[1].status).toEqual("changed")
  expect(ctx.results[1].name).toEqual("nginx")
})

// ---------------------------------------------------------------------------
// Reporter interaction
// ---------------------------------------------------------------------------

test("reports resourceStart and resourceEnd", async () => {
  const { reporter, calls } = trackingReporter()
  const ctx = makeCtx({ reporter })
  const def = testResource({ inDesiredState: true })

  await executeResource(ctx, def, { pkg: "nginx" })

  expect(calls.starts.length).toEqual(1)
  expect(calls.starts[0]).toEqual({ type: "test", name: "nginx" })
  expect(calls.ends.length).toEqual(1)
  expect(calls.ends[0].status).toEqual("ok")
})

test("reports resourceEnd even on failure", async () => {
  const { reporter, calls } = trackingReporter()
  const ctx = makeCtx({ reporter, errorMode: "fail-at-end" })
  const def = testResource({
    inDesiredState: false,
    applyError: new Error("boom"),
  })

  await executeResource(ctx, def, { pkg: "nginx" })

  expect(calls.ends.length).toEqual(1)
  expect(calls.ends[0].status).toEqual("failed")
})

test("reports resourceEnd before throwing in fail-fast", async () => {
  const { reporter, calls } = trackingReporter()
  const ctx = makeCtx({ reporter, errorMode: "fail-fast" })
  const def = testResource({
    inDesiredState: false,
    applyError: new Error("boom"),
  })

  let threw = false
  try {
    await executeResource(ctx, def, { pkg: "nginx" })
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)

  expect(calls.ends.length).toEqual(1)
  expect(calls.ends[0].status).toEqual("failed")
})

// ---------------------------------------------------------------------------
// resolvePolicy
// ---------------------------------------------------------------------------

test("resolvePolicy — returns defaults when no override", () => {
  const policy = resolvePolicy()
  expect(policy).toEqual(DEFAULT_RESOURCE_POLICY)
})

test("resolvePolicy — partial override merges with defaults", () => {
  const policy = resolvePolicy({ timeoutMs: 5000 })
  expect(policy.timeoutMs).toEqual(5000)
  expect(policy.retries).toEqual(DEFAULT_RESOURCE_POLICY.retries)
  expect(policy.retryDelayMs).toEqual(DEFAULT_RESOURCE_POLICY.retryDelayMs)
})

test("resolvePolicy — full override replaces defaults", () => {
  const policy = resolvePolicy({ timeoutMs: 1000, retries: 5, retryDelayMs: 200 })
  expect(policy.timeoutMs).toEqual(1000)
  expect(policy.retries).toEqual(5)
  expect(policy.retryDelayMs).toEqual(200)
})

// ---------------------------------------------------------------------------
// Timeout behavior
// ---------------------------------------------------------------------------

test("timeout — check phase times out", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return new Promise(() => {}) // never resolves
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { timeoutMs: 50, retries: 0 })

  expect(result.status).toEqual("failed")
  expect(result.error?.message.includes("timeout")).toEqual(true)
})

test("timeout — apply phase times out", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return new Promise(() => {}) // never resolves
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { timeoutMs: 50, retries: 0 })

  expect(result.status).toEqual("failed")
  expect(result.error?.message.includes("timeout")).toEqual(true)
})

test("timeout — no timeout when timeoutMs is 0", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { timeoutMs: 0, retries: 0 })

  expect(result.status).toEqual("ok")
})

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

test("retry — retries retryable SSHConnectionError in check phase", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      if (checkCalls <= 2) {
        return Promise.reject(new SSHConnectionError("web-1", `attempt ${checkCalls} failed`))
      }
      return Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "ok",
      })
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 2, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("ok")
  expect(checkCalls).toEqual(3)
  expect(result.attempts?.length).toEqual(3)
  expect(result.attempts?.[0].error?.message).toEqual("attempt 1 failed")
  expect(result.attempts?.[1].error?.message).toEqual("attempt 2 failed")
  expect(result.attempts?.[2].error).toEqual(undefined) // success
})

test("retry — retries retryable TransferError in apply phase", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let applyCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      applyCalls++
      if (applyCalls === 1) {
        return Promise.reject(new TransferError("/tmp/a", "/etc/b", "scp reset"))
      }
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 1, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  expect(applyCalls).toEqual(2)
  // Check attempt (1 success) + apply attempts (1 fail + 1 success) = 3
  expect(result.attempts?.length).toEqual(3)
})

test("retry — does NOT retry non-retryable SSHCommandError", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(_ctx, _input) {
      checkCalls++
      return Promise.reject(new ResourceError("test", "nginx", "non-retryable"))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 2, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("failed")
  expect(checkCalls).toEqual(1) // No retries for non-retryable error
  expect(result.attempts).toEqual(undefined) // Only 1 attempt, no metadata attached
})

test("retry — does NOT retry plain Error", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let applyCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      applyCalls++
      return Promise.reject(new Error("plain error"))
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 2, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("failed")
  expect(applyCalls).toEqual(1) // No retries
})

test("retry — exhausts all retries and fails", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.reject(new SSHConnectionError("web-1", `attempt ${checkCalls}`))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 2, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("failed")
  expect(checkCalls).toEqual(3) // 1 initial + 2 retries
  expect(result.attempts?.length).toEqual(3)
  expect(result.error?.message).toEqual("attempt 3")
})

test("retry — no retries when retries=0", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.reject(new SSHConnectionError("web-1", "failed"))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 0, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("failed")
  expect(checkCalls).toEqual(1)
  expect(result.attempts).toEqual(undefined) // Only 1 attempt
})

test("retry — no attempts metadata when single attempt succeeds", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { retries: 2, retryDelayMs: 10, timeoutMs: 0 },
  )

  expect(result.status).toEqual("ok")
  expect(result.attempts).toEqual(undefined) // Only 1 attempt, no metadata
})

// ---------------------------------------------------------------------------
// Policy — per-resource override
// ---------------------------------------------------------------------------

test("per-resource policy override is respected", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return new Promise(() => {}) // never resolves
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  // Use a very short timeout as override
  const result = await executeResource(ctx, def, { pkg: "nginx" }, { timeoutMs: 30, retries: 0 })

  expect(result.status).toEqual("failed")
  expect(result.error?.message.includes("timeout")).toEqual(true)
})

test("fail-fast still works with retries — throws after exhausting retries", async () => {
  const ctx = makeCtx({ errorMode: "fail-fast" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.reject(new SSHConnectionError("web-1", `attempt ${checkCalls}`))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  let threw = false
  try {
    await executeResource(
      ctx,
      def,
      { pkg: "nginx" },
      { retries: 1, retryDelayMs: 10, timeoutMs: 0 },
    )
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
  expect(checkCalls).toEqual(2) // 1 initial + 1 retry
  expect(ctx.results.length).toEqual(1)
  expect(ctx.results[0].status).toEqual("failed")
  expect(ctx.results[0].attempts?.length).toEqual(2)
})

// ---------------------------------------------------------------------------
// Event bus decoupled from reporter
// ---------------------------------------------------------------------------

test("wrapper reporter (non-EventReporter) still produces telemetry when ctx.eventBus is set", async () => {
  const bus = new EventBus("test-run")
  const events: LifecycleEvent[] = []
  bus.on((e) => events.push(e))

  // A plain wrapper reporter — NOT an EventReporter instance
  const delegateCalls: string[] = []
  const wrapperReporter: Reporter = {
    resourceStart(type: string, name: string) {
      delegateCalls.push(`start:${type}:${name}`)
    },
    resourceEnd(result: ResourceResult) {
      delegateCalls.push(`end:${result.type}:${result.name}`)
    },
  }

  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: wrapperReporter,
    eventBus: bus,
    hostCorrelationId: bus.nextId(),
  })

  const def = testResource({ inDesiredState: false, applyOutput: "installed" })
  await executeResource(ctx, def, { pkg: "nginx" })

  // Wrapper reporter should still receive calls
  expect(delegateCalls).toEqual(["start:test:nginx", "end:test:nginx"])

  // Event bus should receive resource_started and resource_finished events
  const started = events.find((e) => e.type === "resource_started") as ResourceStartedEvent
  const finished = events.find((e) => e.type === "resource_finished") as ResourceFinishedEvent
  expect(started).toBeDefined()
  expect(finished).toBeDefined()
  expect(started.resourceType).toEqual("test")
  expect(started.resourceName).toEqual("nginx")
  expect(finished.status).toEqual("changed")
  expect(started.correlation.resourceId).toEqual(finished.correlation.resourceId)
})

test("retry telemetry emitted via ctx.eventBus without EventReporter", async () => {
  const bus = new EventBus("test-run")
  const events: LifecycleEvent[] = []
  bus.on((e) => events.push(e))

  // Plain reporter — not EventReporter
  const reporter: Reporter = {
    resourceStart() {},
    resourceEnd() {},
  }

  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter,
    eventBus: bus,
    hostCorrelationId: bus.nextId(),
  })

  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      if (checkCalls === 1) {
        return Promise.reject(new SSHConnectionError("web-1", "transient"))
      }
      return Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "ok",
      })
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 1, retryDelayMs: 0, timeoutMs: 0 })

  const retryEvents = events.filter((e) => e.type === "resource_retry") as ResourceRetryEvent[]
  expect(retryEvents.length).toEqual(1)
  expect(retryEvents[0].resourceType).toEqual("test")
  expect(retryEvents[0].resourceName).toEqual("nginx")
  expect(retryEvents[0].phase).toEqual("check")
})

test("no event bus — executeResource works without telemetry (backward compatible)", async () => {
  const { reporter, calls } = trackingReporter()
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter,
  })

  const def = testResource({ inDesiredState: true })
  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("ok")
  expect(calls.starts.length).toEqual(1)
  expect(calls.ends.length).toEqual(1)
})

// ---------------------------------------------------------------------------
// wrapTransport
// ---------------------------------------------------------------------------

test("wrapTransport — merges defaults into exec opts", async () => {
  const receivedOpts: ExecOptions[] = []
  const conn = stubConnection()
  const original = conn.exec.bind(conn)
  conn.exec = (_cmd: string, opts?: ExecOptions) => {
    receivedOpts.push(opts ?? {})
    return original(_cmd, opts)
  }

  const onStdout = () => {}
  const onStderr = () => {}
  const wrapped = wrapTransport(conn, { onStdout, onStderr })

  await wrapped.exec("whoami")
  expect(receivedOpts.length).toEqual(1)
  expect(receivedOpts[0].onStdout).toEqual(onStdout)
  expect(receivedOpts[0].onStderr).toEqual(onStderr)
})

test("wrapTransport — caller opts override defaults", async () => {
  const receivedOpts: ExecOptions[] = []
  const conn = stubConnection()
  const original = conn.exec.bind(conn)
  conn.exec = (_cmd: string, opts?: ExecOptions) => {
    receivedOpts.push(opts ?? {})
    return original(_cmd, opts)
  }

  const defaultCb = () => {}
  const callerCb = () => {}
  const wrapped = wrapTransport(conn, { onStdout: defaultCb })

  await wrapped.exec("whoami", { onStdout: callerCb })
  expect(receivedOpts[0].onStdout).toEqual(callerCb)
})

test("wrapTransport — delegates non-exec methods unchanged", async () => {
  const conn = stubConnection()
  let pingCalled = false
  conn.ping = () => {
    pingCalled = true
    return Promise.resolve(true)
  }

  const wrapped = wrapTransport(conn, { onStdout: () => {} })
  await wrapped.ping()
  expect(pingCalled).toEqual(true)
  expect(wrapped.config).toEqual(conn.config)
  expect([...wrapped.capabilities()]).toEqual([...conn.capabilities()])
})

test("wrapTransport — applies default signal to transfer/fetch when omitted", async () => {
  const controller = new AbortController()
  let transferSignal: AbortSignal | undefined
  let fetchSignal: AbortSignal | undefined

  const conn = stubConnection()
  conn.transfer = (_localPath: string, _remotePath: string, signal?: AbortSignal) => {
    transferSignal = signal
    return Promise.resolve()
  }
  conn.fetch = (_remotePath: string, _localPath: string, signal?: AbortSignal) => {
    fetchSignal = signal
    return Promise.resolve()
  }

  const wrapped = wrapTransport(conn, {}, controller.signal)
  await wrapped.transfer("/tmp/a", "/tmp/b")
  await wrapped.fetch("/tmp/b", "/tmp/a")

  expect(transferSignal).toEqual(controller.signal)
  expect(fetchSignal).toEqual(controller.signal)
})

// ---------------------------------------------------------------------------
// Verbose streaming wiring
// ---------------------------------------------------------------------------

test("verbose=true — wires onStdout/onStderr callbacks via reporter", async () => {
  const outputCalls: Array<{ type: string; name: string; stream: string; chunk: string }> = []
  const reporter: Reporter = {
    resourceStart() {},
    resourceEnd() {},
    resourceOutput(type: string, name: string, stream: "stdout" | "stderr", chunk: string) {
      outputCalls.push({ type, name, stream, chunk })
    },
  }

  // Mock connection that invokes callbacks from opts
  const conn = stubConnection()
  conn.exec = (_cmd: string, opts?: ExecOptions) => {
    opts?.onStdout?.("hello stdout\n")
    opts?.onStderr?.("hello stderr\n")
    return Promise.resolve({ exitCode: 0, stdout: "hello stdout\n", stderr: "hello stderr\n" })
  }

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: true,
    host: stubHost(),
    reporter,
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(ctx, _input) {
      return ctx.connection.exec("check cmd").then(() => ({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      }))
    },
    apply(ctx, _input) {
      return ctx.connection.exec("apply cmd").then(() => "applied")
    },
  }

  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  // Both check and apply phases should have triggered output callbacks
  expect(outputCalls.length).toEqual(4)
  expect(outputCalls[0]).toEqual({
    type: "test",
    name: "nginx",
    stream: "stdout",
    chunk: "hello stdout\n",
  })
  expect(outputCalls[1]).toEqual({
    type: "test",
    name: "nginx",
    stream: "stderr",
    chunk: "hello stderr\n",
  })
})

test("verbose=true — preserves ExecutionContext prototype accessors", async () => {
  let observedHasFailed: boolean | undefined

  const conn = stubConnection()
  conn.exec = () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "check",
    errorMode: "fail-fast",
    verbose: true,
    host: stubHost(),
    reporter: { resourceStart() {}, resourceEnd() {} },
  })

  const def: ResourceDefinition<{ name: string }, string> = {
    type: "test",
    formatName(input) {
      return input.name
    },
    check(innerCtx, _input) {
      observedHasFailed = innerCtx.hasFailed
      return innerCtx.connection.exec("check").then(() => ({
        inDesiredState: true,
        current: {},
        desired: {},
      }))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  await executeResource(ctx, def, { name: "demo" }, { retries: 0, timeoutMs: 0 })
  expect(observedHasFailed).toEqual(false)
})

test("verbose=false — no callbacks wired", async () => {
  const outputCalls: string[] = []
  const reporter: Reporter = {
    resourceStart() {},
    resourceEnd() {},
    resourceOutput() {
      outputCalls.push("called")
    },
  }

  const receivedOpts: ExecOptions[] = []
  const conn = stubConnection()
  conn.exec = (_cmd: string, opts?: ExecOptions) => {
    receivedOpts.push(opts ?? {})
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
  }

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter,
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(ctx, _input) {
      return ctx.connection.exec("check cmd").then(() => ({
        inDesiredState: false,
        current: {},
        desired: {},
      }))
    },
    apply(ctx, _input) {
      return ctx.connection.exec("apply cmd").then(() => "applied")
    },
  }

  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  // No callbacks should have been wired
  expect(outputCalls.length).toEqual(0)
  for (const opts of receivedOpts) {
    expect(opts.onStdout).toEqual(undefined)
    expect(opts.onStderr).toEqual(undefined)
  }
})

test("verbose=true — emits resource_output events to event bus", async () => {
  const bus = new EventBus("test-run")
  const events: LifecycleEvent[] = []
  bus.on((e) => events.push(e))

  const conn = stubConnection()
  conn.exec = (_cmd: string, opts?: ExecOptions) => {
    opts?.onStdout?.("bus output\n")
    return Promise.resolve({ exitCode: 0, stdout: "bus output\n", stderr: "" })
  }

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: true,
    host: stubHost(),
    reporter: { resourceStart() {}, resourceEnd() {} },
    eventBus: bus,
    hostCorrelationId: bus.nextId(),
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(ctx, _input) {
      return ctx.connection.exec("check").then(() => ({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      }))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  const outputEvents = events.filter((e) => e.type === "resource_output") as ResourceOutputEvent[]
  expect(outputEvents.length).toEqual(1)
  expect(outputEvents[0].stream).toEqual("stdout")
  expect(outputEvents[0].chunk).toEqual("bus output\n")
  expect(outputEvents[0].resourceType).toEqual("test")
  expect(outputEvents[0].resourceName).toEqual("nginx")
})

// ---------------------------------------------------------------------------
// ResourceCallMeta — tag filtering + meta passthrough
// ---------------------------------------------------------------------------

test("meta — preserved on ResourceResult", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: true })
  const meta: ResourceCallMeta = {
    tags: ["web"],
    notify: ["reload-nginx"],
    id: "install-nginx",
    sensitivePaths: ["password"],
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, undefined, meta)

  expect(result.status).toEqual("ok")
  expect(result.meta).toEqual(meta)
})

test("meta — absent when no meta provided", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: true })

  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("ok")
  expect(result.meta).toEqual(undefined)
})

test("tag filter — skips execution when tags do not match", async () => {
  let checkCalled = false
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalled = true
      return Promise.resolve({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      })
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
    resourceTags: ["db"],
  })

  const result = await executeResource(ctx, def, { pkg: "nginx" }, undefined, { tags: ["web"] })

  expect(result.status).toEqual("ok")
  expect(result.durationMs).toEqual(0)
  expect(result.meta?.tags).toEqual(["web"])
  expect(checkCalled).toEqual(false)
  expect(ctx.results.length).toEqual(1)
})

test("tag filter — executes when tags match", async () => {
  let checkCalled = false
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalled = true
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
    resourceTags: ["web", "db"],
  })

  const result = await executeResource(ctx, def, { pkg: "nginx" }, undefined, { tags: ["web"] })

  expect(result.status).toEqual("changed")
  expect(checkCalled).toEqual(true)
  expect(result.meta?.tags).toEqual(["web"])
})

test("tag filter — no filter set, resource with tags executes normally", async () => {
  const ctx = makeCtx()
  const def = testResource({ inDesiredState: false, applyOutput: "installed" })

  const result = await executeResource(ctx, def, { pkg: "nginx" }, undefined, { tags: ["web"] })

  expect(result.status).toEqual("changed")
  expect(result.meta?.tags).toEqual(["web"])
})

test("tag filter — filter set but resource has no tags, executes normally", async () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
    resourceTags: ["web"],
  })

  const def = testResource({ inDesiredState: false, applyOutput: "installed" })
  const result = await executeResource(ctx, def, { pkg: "nginx" })

  expect(result.status).toEqual("changed")
  expect(result.meta).toEqual(undefined)
})

test("tag filter — filter set, resource has no meta, executes normally", async () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
    resourceTags: ["web"],
  })

  const def = testResource({ inDesiredState: true })
  const result = await executeResource(ctx, def, { pkg: "nginx" }, undefined, {
    notify: ["reload"],
  })

  expect(result.status).toEqual("ok")
  expect(result.meta?.notify).toEqual(["reload"])
})

test("tag filter — emits event bus events for filtered-out resources", async () => {
  const bus = new EventBus("test-run")
  const events: LifecycleEvent[] = []
  bus.on((e) => events.push(e))

  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
    resourceTags: ["db"],
    eventBus: bus,
    hostCorrelationId: bus.nextId(),
  })

  const def = testResource({ inDesiredState: true })
  await executeResource(ctx, def, { pkg: "nginx" }, undefined, { tags: ["web"] })

  const started = events.find((e) => e.type === "resource_started") as ResourceStartedEvent
  const finished = events.find((e) => e.type === "resource_finished") as ResourceFinishedEvent
  expect(started).toBeDefined()
  expect(finished).toBeDefined()
  expect(started.resourceType).toEqual("test")
  expect(finished.status).toEqual("ok")
  expect(started.correlation.resourceId).toEqual(finished.correlation.resourceId)
})

// ---------------------------------------------------------------------------
// Cancellation via AbortSignal
// ---------------------------------------------------------------------------

test("cancellation — pre-aborted signal returns failed before check", async () => {
  const controller = new AbortController()
  controller.abort()

  const { reporter } = trackingReporter()
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter,
    signal: controller.signal,
  })

  let checkCalled = false
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalled = true
      return Promise.resolve({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      })
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("failed")
  expect(result.error?.message).toEqual("Resource aborted")
  expect(checkCalled).toEqual(false)
})

test("cancellation — signal aborted between check and apply returns failed", async () => {
  const controller = new AbortController()

  const { reporter } = trackingReporter()
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter,
    signal: controller.signal,
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      // Abort after check completes but before apply runs
      controller.abort()
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("failed")
  expect(result.error?.message).toEqual("Resource aborted")
})

test("cancellation — signal propagated to withTimeout aborts in-flight phase", async () => {
  const controller = new AbortController()

  const { reporter } = trackingReporter()
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter,
    signal: controller.signal,
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      // Abort during check — the withTimeout wrapper should reject
      setTimeout(() => controller.abort(), 10)
      return new Promise(() => {}) // never resolves
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("failed")
  expect(result.error?.message).toEqual("Resource aborted")
})

test("cancellation — executeResource injects per-phase signal into exec calls", async () => {
  let observedSignal: AbortSignal | undefined
  let observedInnerCtxSignal: AbortSignal | undefined

  const conn = stubConnection()
  conn.exec = (_cmd: string, opts?: ExecOptions) => {
    observedSignal = opts?.signal
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
  }

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "check",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(innerCtx) {
      observedInnerCtxSignal = innerCtx.signal
      return innerCtx.connection.exec("check").then(() => ({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      }))
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 100 })

  expect(result.status).toEqual("ok")
  expect(observedSignal instanceof AbortSignal).toEqual(true)
  expect(observedInnerCtxSignal === observedSignal).toEqual(true)
  expect(observedSignal?.aborted).toEqual(false)
})

test("cancellation — executeResource injects per-phase signal into transfer calls", async () => {
  let sawTransferAbort = false

  const conn = stubConnection()
  conn.transfer = (_localPath: string, _remotePath: string, signal?: AbortSignal) => {
    return new Promise<void>((_resolve, reject) => {
      // No signal means cancellation is not plumbed; keep pending forever.
      if (!signal) return
      if (signal.aborted) {
        sawTransferAbort = true
        reject(new Error("transfer aborted"))
        return
      }
      signal.addEventListener(
        "abort",
        () => {
          sawTransferAbort = true
          reject(new Error("transfer aborted"))
        },
        { once: true },
      )
    })
  }

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter: trackingReporter().reporter,
  })

  const def: ResourceDefinition<{ path: string }, string> = {
    type: "test-transfer",
    formatName(input) {
      return input.path
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: {},
        desired: {},
      })
    },
    async apply(innerCtx) {
      await innerCtx.connection.transfer("/tmp/source", "/tmp/dest")
      return "done"
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { path: "/tmp/dest" },
    { retries: 0, timeoutMs: 20 },
  )

  expect(result.status).toEqual("failed")
  expect(sawTransferAbort).toEqual(true)
})

test("cancellation — ctx.signal available to resource check/apply", async () => {
  let observedSignal: AbortSignal | undefined

  const controller = new AbortController()
  const { reporter } = trackingReporter()
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter,
    signal: controller.signal,
  })

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(innerCtx) {
      observedSignal = innerCtx.signal
      return Promise.resolve({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      })
    },
    apply() {
      return Promise.resolve("applied")
    },
  }

  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(observedSignal).toBeDefined()
  expect(observedSignal!.aborted).toEqual(false)
})

// ---------------------------------------------------------------------------
// Post-check — reliable changed status
// ---------------------------------------------------------------------------

test("postCheck — confirms change when post-check returns inDesiredState true", async () => {
  const ctx = makeCtx()
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      if (checkCalls === 1) {
        // Initial check: not in desired state
        return Promise.resolve({
          inDesiredState: false,
          current: { installed: false },
          desired: { installed: true },
        })
      }
      // Post-check: now in desired state
      return Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "installed",
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  expect(result.output).toEqual("installed")
  expect(checkCalls).toEqual(2) // initial check + post-check
})

test("postCheck — detects convergence failure when post-check returns inDesiredState false", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      // Both initial and post-check return not in desired state
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("failed")
  expect(result.error?.message.includes("Convergence failure")).toEqual(true)
  expect(checkCalls).toEqual(2)
})

test("postCheck — convergence failure throws ResourceError in fail-fast", async () => {
  const ctx = makeCtx({ errorMode: "fail-fast" })
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const err = await expectRejection(() =>
    executeResource(ctx, def, { pkg: "nginx" }, { postCheck: true, retries: 0, timeoutMs: 0 }),
  )
  expect(err.message).toContain("Convergence failure")
  expect(ctx.results.length).toEqual(1)
  expect(ctx.results[0].status).toEqual("failed")
})

test("postCheck — disabled by default (postCheck absent)", async () => {
  const ctx = makeCtx()
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  expect(result.status).toEqual("changed")
  expect(checkCalls).toEqual(1) // Only initial check, no post-check
})

test("postCheck — disabled when explicitly false", async () => {
  const ctx = makeCtx()
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: false, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  expect(checkCalls).toEqual(1) // Only initial check, no post-check
})

test("postCheck — timing includes post-check in durationMs", async () => {
  const ctx = makeCtx()
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check(_ctx, _input) {
      // Add a small delay to the post-check
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              inDesiredState: false,
              current: { installed: false },
              desired: { installed: true },
            }),
          5,
        ),
      ).then((r) => {
        // On second call (post-check), return in desired state
        if (checkCount++ > 0) {
          return {
            inDesiredState: true,
            current: { installed: true },
            desired: { installed: true },
            output: "ok",
          }
        }
        return r as CheckResult<string>
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }
  let checkCount = 0

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  // durationMs should be positive and include the post-check delay
  expect(result.durationMs).toBeGreaterThan(0)
})

test("postCheck — post-check attempt recorded in attempts[] metadata", async () => {
  const ctx = makeCtx()
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      if (checkCalls === 1) {
        return Promise.resolve({
          inDesiredState: false,
          current: { installed: false },
          desired: { installed: true },
        })
      }
      return Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "installed",
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  // Should have 3 attempts: check, apply, post-check
  expect(result.attempts).toBeDefined()
  expect(result.attempts!.length).toEqual(3)
  expect(result.attempts![0].phase).toEqual("check")
  expect(result.attempts![1].phase).toEqual("apply")
  expect(result.attempts![2].phase).toEqual("post-check")
  expect(result.attempts![2].error).toEqual(undefined) // success
  expect(result.attempts![2].durationMs).toBeGreaterThan(-1)
})

test("postCheck — convergence failure records post-check attempt in attempts[]", async () => {
  const ctx = makeCtx({ errorMode: "fail-at-end" })
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("failed")
  expect(result.error?.message.includes("Convergence failure")).toEqual(true)
  // The post-check call itself succeeded (check() returned without throwing),
  // so the attempt record has no error. The convergence failure is a semantic
  // error thrown after the post-check completes.
  expect(result.attempts).toBeDefined()
  expect(result.attempts!.length).toEqual(3)
  expect(result.attempts![2].phase).toEqual("post-check")
  expect(result.attempts![2].error).toEqual(undefined)
})

test("postCheck — skipped when resource already in desired state (status ok)", async () => {
  const ctx = makeCtx()
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "already-ok",
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("ok")
  expect(checkCalls).toEqual(1) // Only initial check, no post-check (no apply ran)
})

test("postCheck — skipped in check mode (no apply, no post-check)", async () => {
  const ctx = makeCtx({ mode: "check" })
  let checkCalls = 0
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName(input) {
      return input.pkg
    },
    check() {
      checkCalls++
      return Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })
    },
    apply() {
      return Promise.resolve("installed")
    },
  }

  const result = await executeResource(
    ctx,
    def,
    { pkg: "nginx" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  expect(checkCalls).toEqual(1) // Only initial check, no post-check in check mode
})
