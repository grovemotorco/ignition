import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import type {
  ErrorMode,
  ExecutionContext,
  HostContext,
  Reporter,
  ResourceResult,
  RunMode,
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
    vars: { domain: "example.com" },
  }
}

function stubReporter(): Reporter {
  return {
    resourceStart: () => {},
    resourceEnd: () => {},
  }
}

function makeResult(status: "ok" | "changed" | "failed"): ResourceResult {
  return {
    type: "apt",
    name: "nginx",
    status,
    durationMs: 10,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("ExecutionContextImpl implements ExecutionContext interface", () => {
  const ctx: ExecutionContext = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })
  // Type-level check — if this compiles, the interface is satisfied
  expect(ctx.mode).toEqual("apply")
})

test("immutable fields are set from options", () => {
  const conn = stubConnection()
  const host = stubHost()
  const reporter = stubReporter()

  const ctx = new ExecutionContextImpl({
    connection: conn,
    mode: "check",
    errorMode: "fail-at-end",
    verbose: true,
    host,
    reporter,
  })

  expect(ctx.connection).toBe(conn)
  expect(ctx.mode).toEqual("check" satisfies RunMode)
  expect(ctx.errorMode).toEqual("fail-at-end" satisfies ErrorMode)
  expect(ctx.verbose).toEqual(true)
  expect(ctx.host).toBe(host)
  expect(ctx.reporter).toBe(reporter)
})

test("vars default to empty object when not provided", () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })
  expect(ctx.vars).toEqual({})
})

test("vars are shallow-copied from options", () => {
  const inputVars = { key: "value" }
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
    vars: inputVars,
  })

  expect(ctx.vars).toEqual({ key: "value" })
  // Mutating the original should not affect the context
  inputVars.key = "changed"
  expect(ctx.vars.key).toEqual("value")
})

test("vars are mutable for recipe-scoped state", () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })

  ctx.vars.newKey = "newValue"
  expect(ctx.vars.newKey).toEqual("newValue")
})

test("results starts empty", () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })
  expect(ctx.results.length).toEqual(0)
})

test("hasFailed is false when no results", () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })
  expect(ctx.hasFailed).toEqual(false)
})

test("hasFailed is false when all results are ok/changed", () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })

  ctx.results.push(makeResult("ok"))
  ctx.results.push(makeResult("changed"))
  expect(ctx.hasFailed).toEqual(false)
})

test("hasFailed is true when any result is failed", () => {
  const ctx = new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
  })

  ctx.results.push(makeResult("ok"))
  ctx.results.push(makeResult("failed"))
  ctx.results.push(makeResult("changed"))
  expect(ctx.hasFailed).toEqual(true)
})

// ---------------------------------------------------------------------------
// Scoped variables (ISSUE-0035)
// ---------------------------------------------------------------------------

function makeCtx(vars?: Record<string, unknown>): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: stubReporter(),
    vars,
  })
}

test("setVar writes to current scope", () => {
  const ctx = makeCtx({ a: 1 })
  ctx.setVar("b", 2)
  expect(ctx.vars.a).toEqual(1)
  expect(ctx.vars.b).toEqual(2)
})

test("withVars provides overridden vars inside the scope", async () => {
  const ctx = makeCtx({ a: 1, b: 2 })

  await ctx.withVars({ b: "overridden", c: 3 }, () => {
    expect(ctx.vars.a).toEqual(1)
    expect(ctx.vars.b).toEqual("overridden")
    expect(ctx.vars.c).toEqual(3)
    return Promise.resolve()
  })
})

test("withVars restores parent vars after completion", async () => {
  const ctx = makeCtx({ a: 1, b: 2 })

  await ctx.withVars({ b: "overridden", c: 3 }, () => Promise.resolve())

  expect(ctx.vars.a).toEqual(1)
  expect(ctx.vars.b).toEqual(2)
  expect(ctx.vars.c).toEqual(undefined)
})

test("withVars restores parent vars on error", async () => {
  const ctx = makeCtx({ a: 1 })

  let threw = false
  try {
    await ctx.withVars({ a: "overridden" }, () => Promise.reject(new Error("boom")))
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("boom")
  }
  expect(threw).toEqual(true)

  // Parent scope is restored
  expect(ctx.vars.a).toEqual(1)
})

test("setVar inside withVars does not leak to parent", async () => {
  const ctx = makeCtx({ a: 1 })

  await ctx.withVars({}, () => {
    ctx.setVar("leaked", "nope")
    expect(ctx.vars.leaked).toEqual("nope")
    return Promise.resolve()
  })

  expect(ctx.vars.leaked).toEqual(undefined)
})

test("nested withVars (3+ scopes) stacks correctly", async () => {
  const ctx = makeCtx({ level: "root", shared: "root" })

  await ctx.withVars({ level: "mid", mid: true }, async () => {
    expect(ctx.vars.level).toEqual("mid")
    expect(ctx.vars.shared).toEqual("root")
    expect(ctx.vars.mid).toEqual(true)

    await ctx.withVars({ level: "inner", inner: true }, () => {
      expect(ctx.vars.level).toEqual("inner")
      expect(ctx.vars.shared).toEqual("root")
      expect(ctx.vars.mid).toEqual(true)
      expect(ctx.vars.inner).toEqual(true)
      return Promise.resolve()
    })

    // inner scope popped
    expect(ctx.vars.level).toEqual("mid")
    expect(ctx.vars.inner).toEqual(undefined)
  })

  // all scopes popped
  expect(ctx.vars.level).toEqual("root")
  expect(ctx.vars.mid).toEqual(undefined)
})

test("withVars returns the value from the function", async () => {
  const ctx = makeCtx()
  const result = await ctx.withVars({ x: 42 }, () => {
    return Promise.resolve((ctx.vars.x as number) * 2)
  })
  expect(result).toEqual(84)
})

test("backward compat: ctx.vars.foo = x delegates to setVar", () => {
  const ctx = makeCtx()
  ctx.vars.foo = "bar"
  expect(ctx.vars.foo).toEqual("bar")
})

test("backward compat: ctx.vars.foo = x inside withVars writes to child scope", async () => {
  const ctx = makeCtx({ existing: "root" })

  await ctx.withVars({}, () => {
    ctx.vars.existing = "child"
    expect(ctx.vars.existing).toEqual("child")
    return Promise.resolve()
  })

  // parent unmodified
  expect(ctx.vars.existing).toEqual("root")
})

test('vars proxy supports "in" operator', () => {
  const ctx = makeCtx({ present: 1 })
  expect("present" in ctx.vars).toEqual(true)
  expect("absent" in ctx.vars).toEqual(false)
})

test("vars proxy supports Object.keys()", () => {
  const ctx = makeCtx({ a: 1, b: 2 })
  ctx.setVar("c", 3)
  const keys = Object.keys(ctx.vars)
  expect(keys.sort()).toEqual(["a", "b", "c"])
})

test("vars proxy Object.keys() merges across scopes without duplicates", async () => {
  const ctx = makeCtx({ a: 1, b: 2 })

  await ctx.withVars({ b: "overridden", c: 3 }, () => {
    const keys = Object.keys(ctx.vars)
    expect(keys.sort()).toEqual(["a", "b", "c"])
    return Promise.resolve()
  })
})

test("vars proxy spreads into plain object", () => {
  const ctx = makeCtx({ a: 1, b: 2 })
  const snapshot = { ...ctx.vars }
  expect(snapshot).toEqual({ a: 1, b: 2 })
})
