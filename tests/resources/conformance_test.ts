import { test, expect } from "bun:test"
/**
 * Idempotence conformance tests for all built-in resources.
 *
 * Exercises the shared conformance harness against every built-in resource.
 * Each resource gets "not-in-desired-state" and "in-desired-state"
 * (post-apply convergence) scenarios where applicable.
 */

import { ExecutionContextImpl } from "../../src/core/context.ts"
import { toResourceDiff } from "../../src/core/types.ts"
import type { HostContext, Reporter, ResourceDefinition } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type {
  ExecOptions,
  ExecResult,
  SSHConnection,
  SSHConnectionConfig,
} from "../../src/ssh/types.ts"
import { execDefinition } from "../../src/resources/exec.ts"
import { fileDefinition } from "../../src/resources/file.ts"
import { aptDefinition } from "../../src/resources/apt.ts"
import { serviceDefinition } from "../../src/resources/service.ts"
import { directoryDefinition } from "../../src/resources/directory.ts"
import {
  assertValidCheckResult,
  assertValidFormatName,
  assertValidType,
  runConformanceTests,
} from "./conformance.ts"

// ---------------------------------------------------------------------------
// Shared test helpers (same pattern as existing resource tests)
// ---------------------------------------------------------------------------

function stubConnection(
  execFn?: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>,
  transferFn?: (localPath: string, remotePath: string) => Promise<void>,
): SSHConnection {
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
    exec: execFn ?? (() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
    transfer: transferFn ?? (() => Promise.resolve()),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }
}

function stubHost(): HostContext {
  return { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
}

function silentReporter(): Reporter {
  return {
    resourceStart() {},
    resourceEnd() {},
  }
}

function makeCtx(
  overrides: Partial<{
    mode: "apply" | "check"
    errorMode: "fail-fast" | "fail-at-end" | "ignore"
    execFn: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>
    transferFn: (localPath: string, remotePath: string) => Promise<void>
    vars: Record<string, unknown>
  }> = {},
): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: stubConnection(overrides.execFn, overrides.transferFn),
    mode: overrides.mode ?? "apply",
    errorMode: overrides.errorMode ?? "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
    vars: overrides.vars,
  })
}

// ---------------------------------------------------------------------------
// exec — imperative (always-run), not convergent
// ---------------------------------------------------------------------------

runConformanceTests({
  name: "basic command",
  definition: execDefinition,
  input: { command: "echo hello" },
  makeCtx: () => makeCtx(),
  convergent: false,
})

test("[conformance] exec: check() always returns inDesiredState: false", async () => {
  const ctx = makeCtx()
  const result = await execDefinition.check(ctx, { command: "echo hello" })
  assertValidCheckResult(result)
  expect(result.inDesiredState).toEqual(false)
  expect(result.output).toEqual(undefined)
})

// ---------------------------------------------------------------------------
// file — convergent (declarative state management)
// ---------------------------------------------------------------------------

const fileChecksum = "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e" // sha256('Hello World')

runConformanceTests({
  name: "present with content",
  definition: fileDefinition,
  input: { path: "/etc/app.conf", content: "Hello World" },
  makeCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
    }),
  convergent: true,
  makePostApplyCtx: () => {
    let callCount = 0
    return makeCtx({
      execFn: () => {
        callCount++
        if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
        // sha256sum response
        return Promise.resolve({ exitCode: 0, stdout: fileChecksum + "\n", stderr: "" })
      },
    })
  },
})

runConformanceTests({
  name: "absent (file does not exist)",
  definition: fileDefinition,
  input: { path: "/etc/app.conf", state: "absent" as const },
  makeCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
    }),
  convergent: true,
  makePostApplyCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
    }),
})

// ---------------------------------------------------------------------------
// apt — convergent (declarative package management)
// ---------------------------------------------------------------------------

runConformanceTests({
  name: "present (package not installed)",
  definition: aptDefinition,
  input: { name: "nginx" },
  makeCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "\n", stderr: "" }),
    }),
  convergent: true,
  makePostApplyCtx: () =>
    makeCtx({
      execFn: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
          stderr: "",
        }),
    }),
})

runConformanceTests({
  name: "absent (package installed)",
  definition: aptDefinition,
  input: { name: "nginx", state: "absent" as const },
  makeCtx: () =>
    makeCtx({
      execFn: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
          stderr: "",
        }),
    }),
  convergent: true,
  makePostApplyCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "\n", stderr: "" }),
    }),
})

// ---------------------------------------------------------------------------
// service — convergent for started/stopped, imperative for restarted/reloaded
// ---------------------------------------------------------------------------

runConformanceTests({
  name: "started (currently stopped)",
  definition: serviceDefinition,
  input: { name: "nginx", state: "started" as const },
  makeCtx: () => {
    let callCount = 0
    return makeCtx({
      execFn: () => {
        callCount++
        if (callCount === 1)
          return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      },
    })
  },
  convergent: true,
  makePostApplyCtx: () => {
    let callCount = 0
    return makeCtx({
      execFn: () => {
        callCount++
        if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      },
    })
  },
})

runConformanceTests({
  name: "restarted (imperative, always-run)",
  definition: serviceDefinition,
  input: { name: "nginx", state: "restarted" as const },
  makeCtx: () => {
    let callCount = 0
    return makeCtx({
      execFn: () => {
        callCount++
        if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      },
    })
  },
  convergent: false,
})

// ---------------------------------------------------------------------------
// directory — convergent (declarative directory management)
// ---------------------------------------------------------------------------

runConformanceTests({
  name: "present (directory missing)",
  definition: directoryDefinition,
  input: { path: "/var/www/app" },
  makeCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
    }),
  convergent: true,
  makePostApplyCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
    }),
})

runConformanceTests({
  name: "absent (directory exists)",
  definition: directoryDefinition,
  input: { path: "/var/www/app", state: "absent" as const },
  makeCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
    }),
  convergent: true,
  makePostApplyCtx: () =>
    makeCtx({
      execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
    }),
})

// ---------------------------------------------------------------------------
// Additional contract tests — toResourceDiff()
// ---------------------------------------------------------------------------

test("[conformance] toResourceDiff() produces standardized diff shape", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })

  const checkResult = await fileDefinition.check(ctx, { path: "/etc/app.conf", content: "hello" })
  const diff = toResourceDiff(
    fileDefinition,
    { path: "/etc/app.conf", content: "hello" },
    checkResult,
  )

  expect(diff.type).toEqual("file")
  expect(diff.name).toEqual("/etc/app.conf")
  expect(diff.inDesiredState).toEqual(false)
  expect(diff.current).toBeDefined()
  expect(diff.desired).toBeDefined()
})

test("[conformance] toResourceDiff() for in-desired-state resource", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })

  const input = { path: "/etc/app.conf", state: "absent" as const }
  const checkResult = await fileDefinition.check(ctx, input)
  const diff = toResourceDiff(fileDefinition, input, checkResult)

  expect(diff.type).toEqual("file")
  expect(diff.name).toEqual("/etc/app.conf")
  expect(diff.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// Cross-resource structural contract tests
// ---------------------------------------------------------------------------

test("[conformance] all built-in definitions have unique type fields", () => {
  const definitions = [
    execDefinition,
    fileDefinition,
    aptDefinition,
    serviceDefinition,
    directoryDefinition,
  ]
  const types = definitions.map((d) => d.type)
  const unique = new Set(types)
  expect(unique.size).toEqual(types.length)
})

test("[conformance] all built-in definitions have lowercase type fields", () => {
  const definitions: ResourceDefinition<any, any>[] = [
    execDefinition,
    fileDefinition,
    aptDefinition,
    serviceDefinition,
    directoryDefinition,
  ]
  for (const def of definitions) {
    assertValidType(def)
  }
})

test("[conformance] all built-in definitions produce valid formatName", () => {
  const cases: Array<{ def: ResourceDefinition<any, any>; input: unknown }> = [
    { def: execDefinition, input: { command: "echo hello" } },
    { def: fileDefinition, input: { path: "/etc/app.conf" } },
    { def: aptDefinition, input: { name: "nginx" } },
    { def: serviceDefinition, input: { name: "nginx" } },
    { def: directoryDefinition, input: { path: "/var/www" } },
  ]

  for (const { def, input } of cases) {
    assertValidFormatName(def, input)
  }
})

// ---------------------------------------------------------------------------
// CheckResult structural contract for each resource
// ---------------------------------------------------------------------------

test("[conformance] exec check() has current.executed and desired.command", async () => {
  const ctx = makeCtx()
  const result = await execDefinition.check(ctx, { command: "echo hi" })
  expect(result.current.executed).toBeDefined()
  expect(result.desired.command).toBeDefined()
})

test("[conformance] file check() has current.exists for missing file", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })
  const result = await fileDefinition.check(ctx, { path: "/etc/app.conf", content: "test" })
  expect(result.current.exists).toEqual(false)
})

test("[conformance] apt check() has current.installed", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "\n", stderr: "" }),
  })
  const result = await aptDefinition.check(ctx, { name: "nginx" })
  expect(result.current.installed).toBeDefined()
})

test("[conformance] service check() has current.active and current.enabled", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })
  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "started" })
  expect(result.current.active).toBeDefined()
  expect(result.current.enabled).toBeDefined()
})

test("[conformance] directory check() has current.exists for missing dir", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })
  const result = await directoryDefinition.check(ctx, { path: "/var/www/app" })
  expect(result.current.exists).toEqual(false)
})

// ---------------------------------------------------------------------------
// Convergence round-trip: file with attributes
// ---------------------------------------------------------------------------

test("[conformance] file: convergent round-trip with mode/owner/group", async () => {
  // Post-apply: file exists with correct checksum and attributes
  const content = "server { listen 80; }"
  const data = new TextEncoder().encode(content)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const checksum = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      if (callCount === 2)
        return Promise.resolve({ exitCode: 0, stdout: checksum + "\n", stderr: "" })
      // stat response
      return Promise.resolve({ exitCode: 0, stdout: "0644 www-data www-data\n", stderr: "" })
    },
  })

  const input = {
    path: "/etc/nginx.conf",
    content,
    mode: "0644",
    owner: "www-data",
    group: "www-data",
  }
  const result = await fileDefinition.check(ctx, input)
  assertValidCheckResult(result)
  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// Convergence round-trip: directory with attributes
// ---------------------------------------------------------------------------

test("[conformance] directory: convergent round-trip with mode/owner/group", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      // stat response
      return Promise.resolve({ exitCode: 0, stdout: "0755 deploy deploy\n", stderr: "" })
    },
  })

  const input = { path: "/var/www/app", mode: "0755", owner: "deploy", group: "deploy" }
  const result = await directoryDefinition.check(ctx, input)
  assertValidCheckResult(result)
  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// Convergence round-trip: apt latest
// ---------------------------------------------------------------------------

test("[conformance] apt: convergent check for state=latest when already latest", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) {
        // dpkg-query response
        return Promise.resolve({
          exitCode: 0,
          stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
          stderr: "",
        })
      }
      // apt-cache policy response
      return Promise.resolve({
        exitCode: 0,
        stdout: "nginx:\n  Installed: 1.18.0-6\n  Candidate: 1.18.0-6\n",
        stderr: "",
      })
    },
  })

  const result = await aptDefinition.check(ctx, { name: "nginx", state: "latest" })
  assertValidCheckResult(result)
  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// Service: convergent for enabled flag
// ---------------------------------------------------------------------------

test("[conformance] service: convergent check for enabled=true when already enabled", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, {
    name: "nginx",
    state: "started",
    enabled: true,
  })
  assertValidCheckResult(result)
  expect(result.inDesiredState).toEqual(true)
})
