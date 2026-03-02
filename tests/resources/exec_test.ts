import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { createExec, execDefinition } from "../../src/resources/exec.ts"
import type { ExecInput } from "../../src/resources/exec.ts"
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
// check() — always not in desired state
// ---------------------------------------------------------------------------

test("check() returns inDesiredState: false", async () => {
  const ctx = makeCtx()
  const input: ExecInput = { command: "echo hello" }

  const result = await execDefinition.check(ctx, input)

  expect(result.inDesiredState).toEqual(false)
  expect(result.current).toEqual({ executed: false })
  expect(result.desired).toEqual({ command: "echo hello" })
})

// ---------------------------------------------------------------------------
// apply() — basic command execution
// ---------------------------------------------------------------------------

test("apply() runs command and returns output", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "hello\n", stderr: "" }),
  })

  const output = await execDefinition.apply(ctx, { command: "echo hello" })

  expect(output.exitCode).toEqual(0)
  expect(output.stdout).toEqual("hello\n")
  expect(output.stderr).toEqual("")
})

// ---------------------------------------------------------------------------
// apply() — sudo wrapping
// ---------------------------------------------------------------------------

test("apply() wraps command with sudo", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.apply(ctx, { command: "apt-get update", sudo: true })

  expect(captured).toEqual("sudo sh -c 'apt-get update'")
})

// ---------------------------------------------------------------------------
// apply() — cwd option
// ---------------------------------------------------------------------------

test("apply() prepends cd when cwd is set", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.apply(ctx, { command: "ls", cwd: "/tmp" })

  expect(captured).toEqual("cd '/tmp' && ls")
})

// ---------------------------------------------------------------------------
// apply() — env option
// ---------------------------------------------------------------------------

test("apply() prepends env vars", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.apply(ctx, { command: "node app.js", env: { NODE_ENV: "production" } })

  expect(captured).toEqual("NODE_ENV='production' node app.js")
})

// ---------------------------------------------------------------------------
// apply() — combined sudo + cwd + env
// ---------------------------------------------------------------------------

test("apply() combines sudo, cwd, and env correctly", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.apply(ctx, {
    command: "make install",
    sudo: true,
    cwd: "/opt/app",
    env: { CC: "gcc" },
  })

  // env → cwd → command, then wrapped with sudo
  expect(captured).toEqual("sudo sh -c 'cd '\\''/opt/app'\\'' && CC='\\''gcc'\\'' make install'")
})

// ---------------------------------------------------------------------------
// apply() — non-zero exit code as failure (default check: true)
// ---------------------------------------------------------------------------

test("apply() throws SSHCommandError on non-zero exit", async () => {
  const ctx = makeCtx({
    errorMode: "fail-at-end",
    execFn: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "not found" }),
  })

  let threw = false
  try {
    await execDefinition.apply(ctx, { command: "false" })
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("Command failed (exit 1): false")
  }
  expect(threw).toEqual(true)
})

// ---------------------------------------------------------------------------
// apply() — check: false tolerates non-zero exit
// ---------------------------------------------------------------------------

test("apply() tolerates non-zero exit when check: false", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "warning" }),
  })

  const output = await execDefinition.apply(ctx, { command: "grep maybe", check: false })

  expect(output.exitCode).toEqual(1)
  expect(output.stderr).toEqual("warning")
})

// ---------------------------------------------------------------------------
// createExec() — bound factory
// ---------------------------------------------------------------------------

test("createExec() returns bound function producing ResourceResult", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" }),
  })
  const exec = createExec(ctx)

  const result = await exec({ command: "echo ok" })

  expect(result.type).toEqual("exec")
  expect(result.name).toEqual("echo ok")
  expect(result.status).toEqual("changed")
  expect(result.output?.exitCode).toEqual(0)
  expect(result.output?.stdout).toEqual("ok")
})

// ---------------------------------------------------------------------------
// Integration with executeResource — check mode
// ---------------------------------------------------------------------------

test("exec in check mode returns changed without running", async () => {
  let execCalled = false
  const ctx = makeCtx({
    mode: "check",
    execFn: () => {
      execCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, execDefinition, { command: "echo test" })

  expect(result.status).toEqual("changed")
  expect(execCalled).toEqual(false)
})

// ---------------------------------------------------------------------------
// formatName
// ---------------------------------------------------------------------------

test("formatName returns the command string", () => {
  expect(execDefinition.formatName({ command: "systemctl restart nginx" })).toEqual(
    "systemctl restart nginx",
  )
})

// ---------------------------------------------------------------------------
// Shell quoting edge cases
// ---------------------------------------------------------------------------

test("apply() handles single quotes in cwd path", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.apply(ctx, { command: "ls", cwd: "/tmp/it's here" })

  expect(captured).toEqual("cd '/tmp/it'\\''s here' && ls")
})

// ---------------------------------------------------------------------------
// unless / onlyIf guards — validation
// ---------------------------------------------------------------------------

test("check() throws when both unless and onlyIf are provided", async () => {
  const ctx = makeCtx()
  let threw = false
  try {
    await execDefinition.check(ctx, {
      command: "echo hi",
      unless: "true",
      onlyIf: "true",
    })
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("mutually exclusive")
  }
  expect(threw).toEqual(true)
})

// ---------------------------------------------------------------------------
// unless guard — exits 0 (desired state met, skip)
// ---------------------------------------------------------------------------

test("check() with unless: guard exits 0 → inDesiredState: true", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  })

  const result = await execDefinition.check(ctx, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// unless guard — exits non-zero (not in desired state, run apply)
// ---------------------------------------------------------------------------

test("check() with unless: guard exits non-zero → inDesiredState: false", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }),
  })

  const result = await execDefinition.check(ctx, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// onlyIf guard — exits 0 (precondition met, run apply)
// ---------------------------------------------------------------------------

test("check() with onlyIf: guard exits 0 → inDesiredState: false", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  })

  const result = await execDefinition.check(ctx, {
    command: "node migrate.js",
    onlyIf: "test -f /tmp/trigger",
  })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// onlyIf guard — exits non-zero (precondition not met, skip)
// ---------------------------------------------------------------------------

test("check() with onlyIf: guard exits non-zero → inDesiredState: true", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }),
  })

  const result = await execDefinition.check(ctx, {
    command: "node migrate.js",
    onlyIf: "test -f /tmp/trigger",
  })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// Guard inherits sudo
// ---------------------------------------------------------------------------

test("check() guard inherits sudo", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.check(ctx, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
    sudo: true,
  })

  expect(captured).toEqual("sudo sh -c 'command -v pm2'")
})

// ---------------------------------------------------------------------------
// Guard inherits cwd
// ---------------------------------------------------------------------------

test("check() guard inherits cwd", async () => {
  let captured = ""
  const ctx = makeCtx({
    execFn: (cmd) => {
      captured = cmd
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await execDefinition.check(ctx, {
    command: "make install",
    unless: "test -f marker",
    cwd: "/opt/app",
  })

  expect(captured).toEqual("cd '/opt/app' && test -f marker")
})

// ---------------------------------------------------------------------------
// Lifecycle integration: unless guard passes → status "ok"
// ---------------------------------------------------------------------------

test("exec with unless (guard passes) → status ok, command never runs", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      // Guard always succeeds (exit 0)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, execDefinition, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.status).toEqual("ok")
  // Only the guard command should have run, not the actual command
  expect(commands).toEqual(["command -v pm2"])
})

// ---------------------------------------------------------------------------
// Lifecycle integration: unless guard fails → status "changed"
// ---------------------------------------------------------------------------

test("exec with unless (guard fails) → status changed, both run", async () => {
  const commands: string[] = []
  let callCount = 0
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      callCount++
      // First call is the guard (exit 1 = not found), second is the apply (exit 0)
      return Promise.resolve({
        exitCode: callCount === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      })
    },
  })

  const result = await executeResource(ctx, execDefinition, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.status).toEqual("changed")
  expect(commands).toEqual(["command -v pm2", "npm install -g pm2"])
})

// ---------------------------------------------------------------------------
// Check mode with guard: guard runs but command does not
// ---------------------------------------------------------------------------

test("check mode with unless guard: guard runs, command does not", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    mode: "check",
    execFn: (cmd) => {
      commands.push(cmd)
      // Guard fails (exit 1 = would need to run apply)
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, execDefinition, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.status).toEqual("changed")
  // Only guard ran, command skipped due to check mode
  expect(commands).toEqual(["command -v pm2"])
})

// ---------------------------------------------------------------------------
// Check mode with guard that passes: status "ok"
// ---------------------------------------------------------------------------

test("check mode with unless guard that passes: status ok", async () => {
  const ctx = makeCtx({
    mode: "check",
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  })

  const result = await executeResource(ctx, execDefinition, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.status).toEqual("ok")
})
