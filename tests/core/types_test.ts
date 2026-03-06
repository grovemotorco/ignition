import { test, expect } from "bun:test"
import {
  IgnitionError,
  InventoryError,
  isRetryable,
  RecipeLoadError,
  ResourceError,
  SSHCommandError,
  SSHConnectionError,
  TransferError,
} from "../../src/core/errors.ts"
import type {
  AttemptRecord,
  CheckResult,
  ConcurrencyOptions,
  ErrorMode,
  HostContext,
  ResourceDiff,
  ResourcePolicy,
  ResourceResult,
  ResourceStatus,
  RunMode,
  TemplateContext,
} from "../../src/core/types.ts"
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RESOURCE_POLICY,
  toResourceDiff,
} from "../../src/core/types.ts"

// ---------------------------------------------------------------------------
// Type-level smoke tests (these verify the types compile correctly)
// ---------------------------------------------------------------------------

test("ResourceStatus accepts valid values", () => {
  const statuses: ResourceStatus[] = ["ok", "changed", "failed"]
  expect(statuses.length).toEqual(3)
})

test("RunMode accepts valid values", () => {
  const modes: RunMode[] = ["apply", "check"]
  expect(modes.length).toEqual(2)
})

test("ErrorMode accepts valid values", () => {
  const modes: ErrorMode[] = ["fail-fast", "fail-at-end", "ignore"]
  expect(modes.length).toEqual(3)
})

test("CheckResult shape compiles", () => {
  const result: CheckResult<string> = {
    inDesiredState: true,
    current: { installed: true },
    desired: { installed: true },
    output: "nginx",
  }
  expect(result.inDesiredState).toEqual(true)
  expect(result.output).toEqual("nginx")
})

test("ResourceResult shape compiles", () => {
  const result: ResourceResult<string> = {
    type: "apt",
    name: "nginx",
    status: "ok",
    durationMs: 42,
    output: "nginx",
  }
  expect(result.status).toEqual("ok")
  expect(result.durationMs).toEqual(42)
})

test("HostContext shape compiles", () => {
  const host: HostContext = {
    name: "web-1",
    hostname: "10.0.1.10",
    user: "deploy",
    port: 22,
    vars: { domain: "app.example.com" },
  }
  expect(host.name).toEqual("web-1")
  expect(host.vars.domain).toEqual("app.example.com")
})

test("TemplateContext is a string-keyed record", () => {
  const ctx: TemplateContext = { domain: "example.com", port: 8080 }
  expect(ctx.domain).toEqual("example.com")
})

test("ConcurrencyOptions shape compiles", () => {
  const opts: ConcurrencyOptions = { parallelism: 10, hostTimeout: 30000 }
  expect(opts.parallelism).toEqual(10)
  expect(opts.hostTimeout).toEqual(30000)
})

test("DEFAULT_CONCURRENCY has expected defaults", () => {
  expect(DEFAULT_CONCURRENCY.parallelism).toEqual(5)
  expect(DEFAULT_CONCURRENCY.hostTimeout).toEqual(0)
})

// ---------------------------------------------------------------------------
// Error hierarchy tests
// ---------------------------------------------------------------------------

test("IgnitionError has tag and context", () => {
  const err = new IgnitionError("ResourceError", "something broke", { key: "val" })
  expect(err).toBeInstanceOf(Error)
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("ResourceError")
  expect(err.message).toEqual("something broke")
  expect(err.context.key).toEqual("val")
  expect(err.name).toEqual("ResourceError")
})

test("IgnitionError preserves cause", () => {
  const cause = new Error("root cause")
  const err = new IgnitionError("ResourceError", "wrapper", {}, cause)
  expect(err.cause).toEqual(cause)
})

test("SSHConnectionError", () => {
  const err = new SSHConnectionError("web-1", "connection refused")
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("SSHConnectionError")
  expect(err.context.host).toEqual("web-1")
})

test("SSHCommandError", () => {
  const err = new SSHCommandError("apt update", 1, "", "permission denied")
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("SSHCommandError")
  expect(err.exitCode).toEqual(1)
  expect(err.stderr).toEqual("permission denied")
  expect(err.context.command).toEqual("apt update")
})

test("TransferError", () => {
  const err = new TransferError("/tmp/a", "/etc/b", "scp failed")
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("TransferError")
  expect(err.context.localPath).toEqual("/tmp/a")
  expect(err.context.remotePath).toEqual("/etc/b")
})

test("ResourceError", () => {
  const err = new ResourceError("apt", "nginx", "install failed")
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("ResourceError")
  expect(err.context.resourceType).toEqual("apt")
  expect(err.context.resourceName).toEqual("nginx")
})

test("RecipeLoadError", () => {
  const err = new RecipeLoadError("./recipe.ts", "syntax error")
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("RecipeLoadError")
  expect(err.context.path).toEqual("./recipe.ts")
})

test("InventoryError", () => {
  const err = new InventoryError("./inventory.ts", "missing hosts")
  expect(err).toBeInstanceOf(IgnitionError)
  expect(err.tag).toEqual("InventoryError")
  expect(err.context.path).toEqual("./inventory.ts")
})

// ---------------------------------------------------------------------------
// ResourcePolicy type tests
// ---------------------------------------------------------------------------

test("ResourcePolicy shape compiles", () => {
  const policy: ResourcePolicy = { timeoutMs: 5000, retries: 3, retryDelayMs: 500 }
  expect(policy.timeoutMs).toEqual(5000)
  expect(policy.retries).toEqual(3)
  expect(policy.retryDelayMs).toEqual(500)
})

test("DEFAULT_RESOURCE_POLICY has expected defaults", () => {
  expect(DEFAULT_RESOURCE_POLICY.timeoutMs).toEqual(30_000)
  expect(DEFAULT_RESOURCE_POLICY.retries).toEqual(2)
  expect(DEFAULT_RESOURCE_POLICY.retryDelayMs).toEqual(1_000)
})

test("AttemptRecord shape compiles", () => {
  const attempt: AttemptRecord = {
    attempt: 1,
    phase: "check",
    durationMs: 100,
  }
  expect(attempt.attempt).toEqual(1)
  expect(attempt.phase).toEqual("check")
})

test("AttemptRecord with error", () => {
  const attempt: AttemptRecord = {
    attempt: 2,
    phase: "apply",
    error: new Error("timeout"),
    durationMs: 5000,
  }
  expect(attempt.error?.message).toEqual("timeout")
})

test("ResourceResult with attempts metadata", () => {
  const result: ResourceResult<string> = {
    type: "apt",
    name: "nginx",
    status: "changed",
    durationMs: 3000,
    output: "installed",
    attempts: [
      { attempt: 1, phase: "check", error: new Error("timeout"), durationMs: 1000 },
      { attempt: 2, phase: "check", durationMs: 500 },
    ],
  }
  expect(result.attempts?.length).toEqual(2)
  expect(result.attempts?.[0].attempt).toEqual(1)
  expect(result.attempts?.[1].attempt).toEqual(2)
})

// ---------------------------------------------------------------------------
// isRetryable tests
// ---------------------------------------------------------------------------

test("isRetryable — SSHConnectionError is retryable", () => {
  const err = new SSHConnectionError("web-1", "connection reset")
  expect(isRetryable(err)).toEqual(true)
})

test("isRetryable — TransferError is retryable", () => {
  const err = new TransferError("/tmp/a", "/etc/b", "scp timeout")
  expect(isRetryable(err)).toEqual(true)
})

test("isRetryable — SSHCommandError is not retryable", () => {
  const err = new SSHCommandError("apt install", 1, "", "failed")
  expect(isRetryable(err)).toEqual(false)
})

test("isRetryable — ResourceError is not retryable", () => {
  const err = new ResourceError("apt", "nginx", "install failed")
  expect(isRetryable(err)).toEqual(false)
})

test("isRetryable — RecipeLoadError is not retryable", () => {
  const err = new RecipeLoadError("./recipe.ts", "syntax error")
  expect(isRetryable(err)).toEqual(false)
})

test("isRetryable — InventoryError is not retryable", () => {
  const err = new InventoryError("./inventory.ts", "bad format")
  expect(isRetryable(err)).toEqual(false)
})

test("isRetryable — plain Error is not retryable", () => {
  expect(isRetryable(new Error("generic"))).toEqual(false)
})

test("isRetryable — non-Error values are not retryable", () => {
  expect(isRetryable("string error")).toEqual(false)
  expect(isRetryable(null)).toEqual(false)
  expect(isRetryable(undefined)).toEqual(false)
})

// ---------------------------------------------------------------------------
// ResourceDiff and toResourceDiff tests
// ---------------------------------------------------------------------------

test("ResourceDiff shape compiles", () => {
  const diff: ResourceDiff = {
    type: "file",
    name: "/etc/app.conf",
    inDesiredState: false,
    current: { exists: false },
    desired: { state: "present" },
  }
  expect(diff.type).toEqual("file")
  expect(diff.name).toEqual("/etc/app.conf")
  expect(diff.inDesiredState).toEqual(false)
})

test("toResourceDiff() extracts diff from definition and check result", () => {
  const def: any = {
    type: "file",
    formatName: (input: { path: string }) => input.path,
  }
  const check: CheckResult<string> = {
    inDesiredState: false,
    current: { exists: false },
    desired: { state: "present" },
  }

  const diff = toResourceDiff(def, { path: "/etc/app.conf" }, check)

  expect(diff.type).toEqual("file")
  expect(diff.name).toEqual("/etc/app.conf")
  expect(diff.inDesiredState).toEqual(false)
  expect(diff.current).toEqual({ exists: false })
  expect(diff.desired).toEqual({ state: "present" })
})

test("toResourceDiff() works for in-desired-state", () => {
  const def: any = {
    type: "apt",
    formatName: (input: { name: string }) => input.name,
  }
  const check: CheckResult<string> = {
    inDesiredState: true,
    current: { installed: { nginx: "1.18.0" } },
    desired: { state: "present" },
    output: "nginx",
  }

  const diff = toResourceDiff(def, { name: "nginx" }, check)

  expect(diff.type).toEqual("apt")
  expect(diff.name).toEqual("nginx")
  expect(diff.inDesiredState).toEqual(true)
})
