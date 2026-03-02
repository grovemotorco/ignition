import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { createFile, fileDefinition } from "../../src/resources/file.ts"
import type { HostContext, Reporter } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type {
  ExecOptions,
  ExecResult,
  SSHConnection,
  SSHConnectionConfig,
} from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest (same as the resource does internally). */
async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

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
// formatName
// ---------------------------------------------------------------------------

test("formatName returns the path", () => {
  expect(fileDefinition.formatName({ path: "/etc/nginx/nginx.conf" })).toEqual(
    "/etc/nginx/nginx.conf",
  )
})

// ---------------------------------------------------------------------------
// check() — file missing, state present
// ---------------------------------------------------------------------------

test("check() returns not in desired state when file missing and state present", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })

  const result = await fileDefinition.check(ctx, { path: "/etc/app.conf", content: "hello" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.current).toEqual({ exists: false })
})

// ---------------------------------------------------------------------------
// check() — file exists, content matches
// ---------------------------------------------------------------------------

test("check() returns in desired state when content checksum matches", async () => {
  const content = "server { listen 80; }"
  const checksum = await sha256(content)
  let callCount = 0

  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: checksum + "\n", stderr: "" })
    },
  })

  const result = await fileDefinition.check(ctx, { path: "/etc/nginx.conf", content })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.changed).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — file exists, content differs
// ---------------------------------------------------------------------------

test("check() returns not in desired state when content checksum differs", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "abc123\n", stderr: "" })
    },
  })

  const result = await fileDefinition.check(ctx, {
    path: "/etc/nginx.conf",
    content: "new content",
  })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — file exists, attrs mismatch
// ---------------------------------------------------------------------------

test("check() returns not in desired state when mode mismatches", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "644 root root\n", stderr: "" })
    },
  })

  const result = await fileDefinition.check(ctx, { path: "/etc/app.conf", mode: "0755" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ state: "present", mode: "0755" })
})

// ---------------------------------------------------------------------------
// check() — state absent, file missing
// ---------------------------------------------------------------------------

test("check() returns in desired state when file missing and state absent", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" }),
  })

  const result = await fileDefinition.check(ctx, { path: "/etc/app.conf", state: "absent" })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.changed).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — state absent, file exists
// ---------------------------------------------------------------------------

test("check() returns not in desired state when file exists and state absent", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
  })

  const result = await fileDefinition.check(ctx, { path: "/etc/app.conf", state: "absent" })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — template mode
// ---------------------------------------------------------------------------

test("check() uses template function to resolve content", async () => {
  const content = "Hello world"
  const checksum = await sha256(content)
  let callCount = 0

  const ctx = makeCtx({
    vars: { greeting: "world" },
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: checksum + "\n", stderr: "" })
    },
  })

  const result = await fileDefinition.check(ctx, {
    path: "/etc/app.conf",
    template: (vars) => `Hello ${String(vars.greeting)}`,
  })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// apply() — write content via stdin
// ---------------------------------------------------------------------------

test("apply() writes content via cat stdin", async () => {
  const commands: string[] = []
  const stdinData: (string | undefined)[] = []
  const ctx = makeCtx({
    execFn: (cmd, opts) => {
      commands.push(cmd)
      stdinData.push(opts?.stdin as string | undefined)
      if (cmd.includes("sha256sum")) {
        return Promise.resolve({ exitCode: 0, stdout: "abc123\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await fileDefinition.apply(ctx, { path: "/etc/app.conf", content: "hello world" })

  expect(commands[0]).toEqual("cat > '/etc/app.conf'")
  expect(stdinData[0]).toEqual("hello world")
  expect(output.changed).toEqual(true)
  expect(output.checksum).toEqual("abc123")
})

// ---------------------------------------------------------------------------
// apply() — transfer source file
// ---------------------------------------------------------------------------

test("apply() transfers source file via scp", async () => {
  let transferredFrom = ""
  let transferredTo = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd.includes("sha256sum")) {
        return Promise.resolve({ exitCode: 0, stdout: "def456\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
    transferFn: (local, remote) => {
      transferredFrom = local
      transferredTo = remote
      return Promise.resolve()
    },
  })

  const output = await fileDefinition.apply(ctx, {
    path: "/etc/app.conf",
    source: "/local/app.conf",
  })

  expect(transferredFrom).toEqual("/local/app.conf")
  expect(transferredTo).toEqual("/etc/app.conf")
  expect(output.checksum).toEqual("def456")
})

// ---------------------------------------------------------------------------
// apply() — template mode
// ---------------------------------------------------------------------------

test("apply() resolves template and writes via stdin", async () => {
  const stdinData: (string | undefined)[] = []
  const ctx = makeCtx({
    vars: { port: 8080 },
    execFn: (_cmd, opts) => {
      stdinData.push(opts?.stdin as string | undefined)
      return Promise.resolve({ exitCode: 0, stdout: "abc\n", stderr: "" })
    },
  })

  await fileDefinition.apply(ctx, {
    path: "/etc/app.conf",
    template: (vars) => `listen ${String(vars.port)}`,
  })

  expect(stdinData[0]).toEqual("listen 8080")
})

// ---------------------------------------------------------------------------
// apply() — set attributes
// ---------------------------------------------------------------------------

test("apply() sets mode, owner, and group", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("sha256sum")) {
        return Promise.resolve({ exitCode: 0, stdout: "abc\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await fileDefinition.apply(ctx, {
    path: "/etc/app.conf",
    content: "test",
    mode: "0644",
    owner: "www-data",
    group: "www-data",
  })

  expect(commands[0]).toEqual("cat > '/etc/app.conf'")
  expect(commands[1]).toEqual("chmod '0644' '/etc/app.conf'")
  expect(commands[2]).toEqual("chown 'www-data' '/etc/app.conf'")
  expect(commands[3]).toEqual("chgrp 'www-data' '/etc/app.conf'")
})

// ---------------------------------------------------------------------------
// apply() — remove file
// ---------------------------------------------------------------------------

test("apply() removes file when state absent", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await fileDefinition.apply(ctx, { path: "/etc/app.conf", state: "absent" })

  expect(commands[0]).toEqual("rm -f '/etc/app.conf'")
  expect(output.changed).toEqual(true)
  expect(output.checksum).toEqual("")
})

// ---------------------------------------------------------------------------
// createFile() — bound factory
// ---------------------------------------------------------------------------

test("createFile() returns bound function producing ResourceResult", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd.includes("test -f"))
        return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
      if (cmd.includes("sha256sum"))
        return Promise.resolve({ exitCode: 0, stdout: "abc\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })
  const file = createFile(ctx)

  const result = await file({ path: "/etc/app.conf", content: "hello" })

  expect(result.type).toEqual("file")
  expect(result.name).toEqual("/etc/app.conf")
  expect(result.status).toEqual("changed")
  expect(result.output?.changed).toEqual(true)
})

// ---------------------------------------------------------------------------
// check mode — dry-run skips apply
// ---------------------------------------------------------------------------

test("file in check mode returns changed without applying", async () => {
  let applyCalled = false
  const ctx = makeCtx({
    mode: "check",
    execFn: (cmd) => {
      if (cmd.includes("test -f"))
        return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
      applyCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, fileDefinition, {
    path: "/etc/app.conf",
    content: "hello",
  })

  expect(result.status).toEqual("changed")
  expect(applyCalled).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — file exists, no content/source (attrs only)
// ---------------------------------------------------------------------------

test("check() returns in desired state when file exists and no content specified", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "EXISTS\n", stderr: "" }),
  })

  const result = await fileDefinition.check(ctx, { path: "/etc/app.conf" })

  expect(result.inDesiredState).toEqual(true)
})
