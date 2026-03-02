import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { createDirectory, directoryDefinition } from "../../src/resources/directory.ts"
import type { HostContext, Reporter } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { ExecResult, SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubConnection(execFn?: (cmd: string) => Promise<ExecResult>): SSHConnection {
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
    transfer: () => Promise.resolve(),
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
    execFn: (cmd: string) => Promise<ExecResult>
  }> = {},
): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: stubConnection(overrides.execFn),
    mode: overrides.mode ?? "apply",
    errorMode: overrides.errorMode ?? "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
}

// ---------------------------------------------------------------------------
// formatName
// ---------------------------------------------------------------------------

test("formatName returns the path", () => {
  expect(directoryDefinition.formatName({ path: "/var/www" })).toEqual("/var/www")
})

// ---------------------------------------------------------------------------
// check() — directory absent, state present (default)
// ---------------------------------------------------------------------------

test("check() returns not in desired state when dir missing and state present", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })

  const result = await directoryDefinition.check(ctx, { path: "/var/www" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.current).toEqual({ exists: false })
})

// ---------------------------------------------------------------------------
// check() — directory present, state present, no attrs
// ---------------------------------------------------------------------------

test("check() returns in desired state when dir exists and no attrs specified", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
  })

  const result = await directoryDefinition.check(ctx, { path: "/var/www" })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.changed).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — directory present, attrs match
// ---------------------------------------------------------------------------

test("check() returns in desired state when attrs match", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "755 deploy staff\n", stderr: "" })
    },
  })

  const result = await directoryDefinition.check(ctx, {
    path: "/var/www",
    mode: "755",
    owner: "deploy",
    group: "staff",
  })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// check() — directory present, attrs mismatch
// ---------------------------------------------------------------------------

test("check() returns not in desired state when mode mismatches", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "644 deploy staff\n", stderr: "" })
    },
  })

  const result = await directoryDefinition.check(ctx, {
    path: "/var/www",
    mode: "755",
  })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ state: "present", mode: "755" })
})

test("check() returns not in desired state when owner mismatches", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "755 root root\n", stderr: "" })
    },
  })

  const result = await directoryDefinition.check(ctx, {
    path: "/var/www",
    owner: "www-data",
  })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ state: "present", owner: "www-data" })
})

// ---------------------------------------------------------------------------
// check() — state absent
// ---------------------------------------------------------------------------

test("check() returns in desired state when dir missing and state absent", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })

  const result = await directoryDefinition.check(ctx, { path: "/var/www", state: "absent" })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.changed).toEqual(false)
})

test("check() returns not in desired state when dir exists and state absent", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
  })

  const result = await directoryDefinition.check(ctx, { path: "/var/www", state: "absent" })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// apply() — create directory (recursive default)
// ---------------------------------------------------------------------------

test("apply() creates directory with mkdir -p by default", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await directoryDefinition.apply(ctx, { path: "/var/www/app" })

  expect(commands[0]).toEqual("mkdir -p '/var/www/app'")
  expect(output.changed).toEqual(true)
  expect(output.path).toEqual("/var/www/app")
})

// ---------------------------------------------------------------------------
// apply() — create directory non-recursive
// ---------------------------------------------------------------------------

test("apply() creates directory with mkdir when recursive: false", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await directoryDefinition.apply(ctx, { path: "/var/www", recursive: false })

  expect(commands[0]).toEqual("mkdir '/var/www'")
})

// ---------------------------------------------------------------------------
// apply() — set attributes
// ---------------------------------------------------------------------------

test("apply() sets mode, owner, and group", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await directoryDefinition.apply(ctx, {
    path: "/var/www",
    mode: "0755",
    owner: "www-data",
    group: "www-data",
  })

  expect(commands.length).toEqual(4)
  expect(commands[0]).toEqual("mkdir -p '/var/www'")
  expect(commands[1]).toEqual("chmod '0755' '/var/www'")
  expect(commands[2]).toEqual("chown 'www-data' '/var/www'")
  expect(commands[3]).toEqual("chgrp 'www-data' '/var/www'")
})

// ---------------------------------------------------------------------------
// apply() — remove directory
// ---------------------------------------------------------------------------

test("apply() removes directory when state absent", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await directoryDefinition.apply(ctx, { path: "/var/www", state: "absent" })

  expect(commands.length).toEqual(1)
  expect(commands[0]).toEqual("rm -rf '/var/www'")
  expect(output.changed).toEqual(true)
})

// ---------------------------------------------------------------------------
// createDirectory() — bound factory
// ---------------------------------------------------------------------------

test("createDirectory() returns bound function producing ResourceResult", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd.includes("test -d")) {
        return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })
  const directory = createDirectory(ctx)

  const result = await directory({ path: "/var/www" })

  expect(result.type).toEqual("directory")
  expect(result.name).toEqual("/var/www")
  expect(result.status).toEqual("changed")
  expect(result.output?.changed).toEqual(true)
})

// ---------------------------------------------------------------------------
// check mode — dry-run skips apply
// ---------------------------------------------------------------------------

test("directory in check mode returns changed without applying", async () => {
  let applyCalled = false
  const ctx = makeCtx({
    mode: "check",
    execFn: (cmd) => {
      if (cmd.includes("test -d")) {
        return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
      }
      applyCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, directoryDefinition, { path: "/var/www" })

  expect(result.status).toEqual("changed")
  expect(applyCalled).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — already in desired state returns ok via executeResource
// ---------------------------------------------------------------------------

test("directory returns ok when already in desired state", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
  })

  const result = await executeResource(ctx, directoryDefinition, { path: "/var/www" })

  expect(result.status).toEqual("ok")
})
