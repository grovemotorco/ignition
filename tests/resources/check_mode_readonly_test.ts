import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { aptDefinition } from "../../src/resources/apt.ts"
import { directoryDefinition } from "../../src/resources/directory.ts"
import { execDefinition } from "../../src/resources/exec.ts"
import { fileDefinition } from "../../src/resources/file.ts"
import { serviceDefinition } from "../../src/resources/service.ts"
import type { HostContext, Reporter } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { ExecResult, SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"

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
  overrides: {
    execFn?: (cmd: string) => Promise<ExecResult>
    transferFn?: (localPath: string, remotePath: string) => Promise<void>
  } = {},
): ExecutionContextImpl {
  const config: SSHConnectionConfig = {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    hostKeyPolicy: "strict",
  }

  const connection: SSHConnection = {
    config,
    capabilities() {
      return ALL_TRANSPORT_CAPABILITIES
    },
    exec: overrides.execFn ?? (() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
    transfer: overrides.transferFn ?? (() => Promise.resolve()),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }

  return new ExecutionContextImpl({
    connection,
    mode: "check",
    errorMode: "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
}

test("apt check mode only uses read-only package queries", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "\n", stderr: "" })
    },
  })

  const result = await executeResource(ctx, aptDefinition, { name: "nginx" })

  expect(result.status).toEqual("changed")
  expect(commands).toEqual([
    "dpkg-query -W -f='${Package}\\t${Status}\\t${Version}\\n' 'nginx' 2>/dev/null; true",
  ])
  expect(commands.some((cmd) => cmd.includes("apt-get"))).toEqual(false)
})

test("file check mode does not transfer or rewrite files", async () => {
  const commands: string[] = []
  let transferred = false
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
    },
    transferFn: () => {
      transferred = true
      return Promise.resolve()
    },
  })

  const result = await executeResource(ctx, fileDefinition, {
    path: "/etc/app.conf",
    source: "./fixtures/app.conf",
  })

  expect(result.status).toEqual("changed")
  expect(commands).toEqual(["test -f '/etc/app.conf' && echo EXISTS || echo MISSING"])
  expect(transferred).toEqual(false)
})

test("directory check mode only inspects the filesystem", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
    },
  })

  const result = await executeResource(ctx, directoryDefinition, { path: "/var/www/app" })

  expect(result.status).toEqual("changed")
  expect(commands).toEqual(["test -d '/var/www/app' && echo EXISTS || echo MISSING"])
  expect(commands.some((cmd) => cmd.includes("mkdir"))).toEqual(false)
  expect(commands.some((cmd) => cmd.includes("rm -rf"))).toEqual(false)
})

test("service check mode only inspects systemd state", async () => {
  const commands: string[] = []
  let callCount = 0
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      callCount++
      if (callCount === 1) {
        return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await executeResource(ctx, serviceDefinition, {
    name: "nginx",
    state: "started",
    enabled: true,
  })

  expect(result.status).toEqual("changed")
  expect(commands).toEqual([
    "systemctl is-active 'nginx' 2>/dev/null || true",
    "systemctl is-enabled 'nginx' 2>/dev/null || true",
  ])
  expect(commands.some((cmd) => cmd.includes("sudo systemctl start"))).toEqual(false)
  expect(commands.some((cmd) => cmd.includes("sudo systemctl restart"))).toEqual(false)
})

test("exec check mode with apply-time unless is fully read-only by default", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, execDefinition, {
    command: "npm install -g pm2",
    unless: "command -v pm2",
  })

  expect(result.status).toEqual("changed")
  expect(commands).toEqual([])
})

test("exec unsafeCheckUnless remains an explicit opt-in escape hatch", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, execDefinition, {
    command: "npm install -g pm2",
    unsafeCheckUnless: "command -v pm2",
  })

  expect(result.status).toEqual("ok")
  expect(commands).toEqual(["command -v pm2"])
})
