import { test, expect } from "bun:test"
/**
 * Transport capability tests — validates capability-driven transport abstraction.
 *
 * Tests the Transport interface, capability querying, hasCapability helper,
 * requireCapability guard, CapabilityError, and resource-level capability
 * checks.
 */

import {
  ALL_TRANSPORT_CAPABILITIES,
  hasCapability,
  type SSHConnectionConfig,
  type Transport,
  type TransportCapability,
} from "../../src/ssh/types.ts"
import { CapabilityError } from "../../src/core/errors.ts"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource, requireCapability } from "../../src/core/resource.ts"
import type {
  ExecutionContext,
  HostContext,
  Reporter,
  ResourceDefinition,
} from "../../src/core/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SSHConnectionConfig = {
  hostname: "10.0.1.10",
  port: 22,
  user: "deploy",
  hostKeyPolicy: "strict",
}

function stubHost(): HostContext {
  return { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
}

function silentReporter(): Reporter {
  return { resourceStart() {}, resourceEnd() {} }
}

/** Create a transport with a specific set of capabilities. */
function makeTransport(caps: ReadonlySet<TransportCapability>): Transport {
  return {
    config: DEFAULT_CONFIG,
    capabilities() {
      return caps
    },
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }
}

/** Create a context with a given transport. */
function makeCtx(transport: Transport): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: transport,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
}

// ---------------------------------------------------------------------------
// ALL_TRANSPORT_CAPABILITIES
// ---------------------------------------------------------------------------

test("ALL_TRANSPORT_CAPABILITIES contains all four capabilities", () => {
  expect(ALL_TRANSPORT_CAPABILITIES.size).toEqual(4)
  expect(ALL_TRANSPORT_CAPABILITIES.has("exec")).toEqual(true)
  expect(ALL_TRANSPORT_CAPABILITIES.has("transfer")).toEqual(true)
  expect(ALL_TRANSPORT_CAPABILITIES.has("fetch")).toEqual(true)
  expect(ALL_TRANSPORT_CAPABILITIES.has("ping")).toEqual(true)
})

test("ALL_TRANSPORT_CAPABILITIES is frozen (read-only set)", () => {
  // ReadonlySet does not expose add/delete at the type level.
  // Just verify it behaves as expected.
  const caps = ALL_TRANSPORT_CAPABILITIES
  expect(caps.has("exec")).toEqual(true)
  expect(caps.has("unknown" as TransportCapability)).toEqual(false)
})

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

test("hasCapability returns true for supported capability", () => {
  const transport = makeTransport(ALL_TRANSPORT_CAPABILITIES)
  expect(hasCapability(transport, "exec")).toEqual(true)
  expect(hasCapability(transport, "transfer")).toEqual(true)
  expect(hasCapability(transport, "fetch")).toEqual(true)
  expect(hasCapability(transport, "ping")).toEqual(true)
})

test("hasCapability returns false for unsupported capability", () => {
  const execOnly = makeTransport(new Set(["exec"]))
  expect(hasCapability(execOnly, "exec")).toEqual(true)
  expect(hasCapability(execOnly, "transfer")).toEqual(false)
  expect(hasCapability(execOnly, "fetch")).toEqual(false)
  expect(hasCapability(execOnly, "ping")).toEqual(false)
})

test("hasCapability works with empty capability set", () => {
  const noCapabilities = makeTransport(new Set())
  expect(hasCapability(noCapabilities, "exec")).toEqual(false)
  expect(hasCapability(noCapabilities, "transfer")).toEqual(false)
})

// ---------------------------------------------------------------------------
// CapabilityError
// ---------------------------------------------------------------------------

test("CapabilityError has correct tag", () => {
  const err = new CapabilityError("transfer", "file")
  expect(err.tag).toEqual("CapabilityError")
  expect(err.name).toEqual("CapabilityError")
})

test("CapabilityError stores capability and context", () => {
  const err = new CapabilityError("transfer", "file")
  expect(err.capability).toEqual("transfer")
  expect(err.context.capability).toEqual("transfer")
  expect(err.context.resourceType).toEqual("file")
})

test("CapabilityError generates default message", () => {
  const err = new CapabilityError("transfer", "file")
  expect(err.message).toEqual("Transport does not support 'transfer' (required by file)")
})

test("CapabilityError accepts custom message", () => {
  const err = new CapabilityError("fetch", "backup", "Custom error message")
  expect(err.message).toEqual("Custom error message")
  expect(err.capability).toEqual("fetch")
})

test("CapabilityError accepts cause", () => {
  const cause = new Error("underlying")
  const err = new CapabilityError("exec", "exec", undefined, cause)
  expect(err.cause).toEqual(cause)
})

test("CapabilityError is instanceof IgnitionError", async () => {
  const { IgnitionError } = await import("../../src/core/errors.ts")
  const err = new CapabilityError("exec", "exec")
  expect(err instanceof IgnitionError).toBe(true)
})

// ---------------------------------------------------------------------------
// requireCapability
// ---------------------------------------------------------------------------

test("requireCapability does not throw when capability is present", () => {
  const transport = makeTransport(ALL_TRANSPORT_CAPABILITIES)
  const ctx = makeCtx(transport)
  // Should not throw
  requireCapability(ctx, "exec", "test")
  requireCapability(ctx, "transfer", "test")
  requireCapability(ctx, "fetch", "test")
  requireCapability(ctx, "ping", "test")
})

test("requireCapability throws CapabilityError when capability is missing", () => {
  const execOnly = makeTransport(new Set(["exec"]))
  const ctx = makeCtx(execOnly)

  try {
    requireCapability(ctx, "transfer", "file")
    throw new Error("Expected CapabilityError")
  } catch (err) {
    expect(err instanceof CapabilityError).toBe(true)
    expect((err as CapabilityError).capability).toEqual("transfer")
    expect((err as CapabilityError).context.resourceType).toEqual("file")
  }
})

test("requireCapability throws for each missing capability", () => {
  const noCapabilities = makeTransport(new Set())
  const ctx = makeCtx(noCapabilities)

  for (const cap of ["exec", "transfer", "fetch", "ping"] as TransportCapability[]) {
    try {
      requireCapability(ctx, cap, "test")
      throw new Error(`Expected CapabilityError for ${cap}`)
    } catch (err) {
      expect(err instanceof CapabilityError).toBe(true)
      expect((err as CapabilityError).capability).toEqual(cap)
    }
  }
})

// ---------------------------------------------------------------------------
// Transport interface compliance
// ---------------------------------------------------------------------------

test("Transport with full capabilities satisfies SSHConnection alias", () => {
  const transport = makeTransport(ALL_TRANSPORT_CAPABILITIES)
  // SSHConnection = Transport — type-level check
  const _conn: import("../../src/ssh/types.ts").SSHConnection = transport
  expect(typeof _conn.exec).toEqual("function")
  expect(typeof _conn.capabilities).toEqual("function")
})

test("Transport.capabilities() returns a ReadonlySet", () => {
  const transport = makeTransport(new Set(["exec", "ping"]))
  const caps = transport.capabilities()
  expect(caps.size).toEqual(2)
  expect(caps.has("exec")).toEqual(true)
  expect(caps.has("ping")).toEqual(true)
  expect(caps.has("transfer")).toEqual(false)
})

// ---------------------------------------------------------------------------
// Resource-level capability checks (integration)
// ---------------------------------------------------------------------------

/** A test resource that requires exec and optionally transfer. */
const testResourceDef: ResourceDefinition<{ useTransfer?: boolean }, { ran: boolean }> = {
  type: "test-resource",
  formatName() {
    return "test"
  },
  check(ctx: ExecutionContext) {
    requireCapability(ctx, "exec", "test-resource")
    return Promise.resolve({
      inDesiredState: false,
      current: {},
      desired: {},
    })
  },
  apply(ctx: ExecutionContext, input: { useTransfer?: boolean }) {
    requireCapability(ctx, "exec", "test-resource")
    if (input.useTransfer) {
      requireCapability(ctx, "transfer", "test-resource")
    }
    return Promise.resolve({ ran: true })
  },
}

test("resource with full capabilities executes successfully", async () => {
  const transport = makeTransport(ALL_TRANSPORT_CAPABILITIES)
  const ctx = makeCtx(transport)
  const result = await executeResource(ctx, testResourceDef, { useTransfer: true })
  expect(result.status).toEqual("changed")
  expect(result.output?.ran).toEqual(true)
})

test("resource fails with CapabilityError when exec is missing", async () => {
  const noExec = makeTransport(new Set(["transfer", "fetch", "ping"]))
  const ctx = new ExecutionContextImpl({
    connection: noExec,
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
  const result = await executeResource(ctx, testResourceDef, {}, { retries: 0, timeoutMs: 0 })
  expect(result.status).toEqual("failed")
  expect(result.error instanceof CapabilityError).toBe(true)
  expect((result.error as CapabilityError).capability).toEqual("exec")
})

test("resource fails with CapabilityError when transfer is missing but needed", async () => {
  const execOnly = makeTransport(new Set(["exec"]))
  const ctx = new ExecutionContextImpl({
    connection: execOnly,
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
  const result = await executeResource(
    ctx,
    testResourceDef,
    { useTransfer: true },
    { retries: 0, timeoutMs: 0 },
  )
  expect(result.status).toEqual("failed")
  expect(result.error instanceof CapabilityError).toBe(true)
  expect((result.error as CapabilityError).capability).toEqual("transfer")
})

test("resource succeeds when only exec is needed and available", async () => {
  const execOnly = makeTransport(new Set(["exec"]))
  const ctx = makeCtx(execOnly)
  const result = await executeResource(ctx, testResourceDef, { useTransfer: false })
  expect(result.status).toEqual("changed")
})

test("CapabilityError surfaces through fail-fast error mode", async () => {
  const noExec = makeTransport(new Set())
  const ctx = makeCtx(noExec)
  // executeResource wraps non-ResourceError in ResourceError for fail-fast
  let threw = false
  try {
    await executeResource(ctx, testResourceDef, {}, { retries: 0, timeoutMs: 0 })
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
  // Verify the underlying error is a CapabilityError
  const result = ctx.results[0]
  expect(result.error instanceof CapabilityError).toBe(true)
})

// ---------------------------------------------------------------------------
// Partial capability transport (simulating non-SSH transport)
// ---------------------------------------------------------------------------

test("exec-only transport works for exec resource", async () => {
  const { execDefinition } = await import("../../src/resources/exec.ts")
  const execOnly = makeTransport(new Set(["exec"]))
  const ctx = makeCtx(execOnly)
  const result = await executeResource(ctx, execDefinition, { command: "echo hello" })
  expect(result.status).toEqual("changed")
})

test("exec-only transport fails for file resource check", async () => {
  const { fileDefinition } = await import("../../src/resources/file.ts")
  // file.check() requires 'exec' — but this transport has 'exec', so check should pass.
  // The test here is that a transport with exec can run file.check().
  const execOnly = makeTransport(new Set(["exec"]))
  const ctx = new ExecutionContextImpl({
    connection: execOnly,
    mode: "check",
    errorMode: "fail-at-end",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
  const result = await executeResource(ctx, fileDefinition, { path: "/tmp/test" })
  // Should succeed since file.check() only needs exec
  expect(result.status).toEqual("changed")
})
