import { test, expect } from "bun:test"
import { createMockHost, createMockSSH, silentReporter } from "./mock_ssh.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { SSHConnection } from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// createMockSSH — default behaviour
// ---------------------------------------------------------------------------

test("createMockSSH returns a valid SSHConnection", () => {
  const { connection } = createMockSSH()
  expect(connection.config.hostname).toEqual("10.0.1.10")
  expect(connection.config.port).toEqual(22)
  expect(connection.config.user).toEqual("deploy")
  expect(connection.config.hostKeyPolicy).toEqual("strict")
})

test("default exec returns exit 0 with empty output", async () => {
  const { connection } = createMockSSH()
  const result = await connection.exec("whoami")
  expect(result.exitCode).toEqual(0)
  expect(result.stdout).toEqual("")
  expect(result.stderr).toEqual("")
})

test("default ping returns true", async () => {
  const { connection } = createMockSSH()
  expect(await connection.ping()).toEqual(true)
})

test("default transfer resolves", async () => {
  const { connection } = createMockSSH()
  await connection.transfer("/local/file", "/remote/file")
})

test("default fetch resolves", async () => {
  const { connection } = createMockSSH()
  await connection.fetch("/remote/file", "/local/file")
})

test("default close resolves", async () => {
  const { connection } = createMockSSH()
  await connection.close()
})

// ---------------------------------------------------------------------------
// createMockSSH — call recording
// ---------------------------------------------------------------------------

test("records exec calls", async () => {
  const { connection, calls } = createMockSSH()

  await connection.exec("uname -a")
  await connection.exec("whoami")

  expect(calls.exec.length).toEqual(2)
  expect(calls.exec[0].command).toEqual("uname -a")
  expect(calls.exec[1].command).toEqual("whoami")
})

test("records exec opts", async () => {
  const { connection, calls } = createMockSSH()

  await connection.exec("cat", { stdin: "hello" })

  expect(calls.exec.length).toEqual(1)
  expect(calls.exec[0].opts?.stdin).toEqual("hello")
})

test("records transfer calls", async () => {
  const { connection, calls } = createMockSSH()

  await connection.transfer("/local/a", "/remote/a")
  await connection.transfer("/local/b", "/remote/b")

  expect(calls.transfer.length).toEqual(2)
  expect(calls.transfer[0]).toEqual({ localPath: "/local/a", remotePath: "/remote/a" })
  expect(calls.transfer[1]).toEqual({ localPath: "/local/b", remotePath: "/remote/b" })
})

test("records fetch calls", async () => {
  const { connection, calls } = createMockSSH()

  await connection.fetch("/remote/x", "/local/x")

  expect(calls.fetch.length).toEqual(1)
  expect(calls.fetch[0]).toEqual({ remotePath: "/remote/x", localPath: "/local/x" })
})

test("records ping count", async () => {
  const { connection, calls } = createMockSSH()

  await connection.ping()
  await connection.ping()
  await connection.ping()

  expect(calls.ping).toEqual(3)
})

test("records close count", async () => {
  const { connection, calls } = createMockSSH()

  await connection.close()

  expect(calls.close).toEqual(1)
})

// ---------------------------------------------------------------------------
// createMockSSH — custom overrides
// ---------------------------------------------------------------------------

test("custom exec handler", async () => {
  const { connection } = createMockSSH({
    exec: () => Promise.resolve({ exitCode: 42, stdout: "custom", stderr: "err" }),
  })

  const result = await connection.exec("anything")
  expect(result.exitCode).toEqual(42)
  expect(result.stdout).toEqual("custom")
  expect(result.stderr).toEqual("err")
})

test("custom ping handler", async () => {
  const { connection } = createMockSSH({
    ping: () => Promise.resolve(false),
  })

  expect(await connection.ping()).toEqual(false)
})

test("custom config overrides", () => {
  const { connection } = createMockSSH({
    config: { hostname: "192.168.1.1", port: 2222, user: "admin" },
  })

  expect(connection.config.hostname).toEqual("192.168.1.1")
  expect(connection.config.port).toEqual(2222)
  expect(connection.config.user).toEqual("admin")
  expect(connection.config.hostKeyPolicy).toEqual("strict")
})

// ---------------------------------------------------------------------------
// createMockSSH — capabilities
// ---------------------------------------------------------------------------

test("default capabilities include all transport capabilities", () => {
  const { connection } = createMockSSH()
  const caps = connection.capabilities()
  expect(caps.size).toEqual(4)
  expect(caps.has("exec")).toEqual(true)
  expect(caps.has("transfer")).toEqual(true)
  expect(caps.has("fetch")).toEqual(true)
  expect(caps.has("ping")).toEqual(true)
})

test("default capabilities returns ALL_TRANSPORT_CAPABILITIES", () => {
  const { connection } = createMockSSH()
  expect(connection.capabilities()).toBe(ALL_TRANSPORT_CAPABILITIES)
})

test("custom capabilities override", () => {
  const execOnly = new Set(["exec"] as const)
  const { connection } = createMockSSH({ capabilities: execOnly })
  const caps = connection.capabilities()
  expect(caps.size).toEqual(1)
  expect(caps.has("exec")).toEqual(true)
  expect(caps.has("transfer")).toEqual(false)
})

test("empty capabilities set", () => {
  const { connection } = createMockSSH({ capabilities: new Set() })
  expect(connection.capabilities().size).toEqual(0)
})

// ---------------------------------------------------------------------------
// createMockSSH — satisfies SSHConnection interface
// ---------------------------------------------------------------------------

test("mock connection satisfies SSHConnection type", () => {
  const { connection } = createMockSSH()
  const _typed: SSHConnection = connection
  expect(typeof _typed.exec).toEqual("function")
  expect(typeof _typed.transfer).toEqual("function")
  expect(typeof _typed.fetch).toEqual("function")
  expect(typeof _typed.ping).toEqual("function")
  expect(typeof _typed.close).toEqual("function")
  expect(typeof _typed.capabilities).toEqual("function")
})

// ---------------------------------------------------------------------------
// createMockHost
// ---------------------------------------------------------------------------

test("createMockHost returns defaults", () => {
  const host = createMockHost()
  expect(host.name).toEqual("web-1")
  expect(host.hostname).toEqual("10.0.1.10")
  expect(host.user).toEqual("deploy")
  expect(host.port).toEqual(22)
  expect(host.vars).toEqual({})
})

test("createMockHost accepts overrides", () => {
  const host = createMockHost({ name: "db-1", hostname: "10.0.2.10", port: 5432 })
  expect(host.name).toEqual("db-1")
  expect(host.hostname).toEqual("10.0.2.10")
  expect(host.port).toEqual(5432)
  expect(host.user).toEqual("deploy")
})

test("createMockHost accepts vars override", () => {
  const host = createMockHost({ vars: { role: "web" } })
  expect(host.vars).toEqual({ role: "web" })
})

// ---------------------------------------------------------------------------
// silentReporter
// ---------------------------------------------------------------------------

test("silentReporter has required methods", () => {
  const r = silentReporter()
  expect(typeof r.resourceStart).toEqual("function")
  expect(typeof r.resourceEnd).toEqual("function")
})

test("silentReporter methods are no-ops", () => {
  const r = silentReporter()
  // Should not throw
  r.resourceStart("test", "name")
  r.resourceEnd({ type: "test", name: "name", status: "ok", durationMs: 0 })
})

// ---------------------------------------------------------------------------
// Integration: mock works with ExecutionContextImpl
// ---------------------------------------------------------------------------

test("mock works with ExecutionContextImpl", async () => {
  const { ExecutionContextImpl } = await import("../../src/core/context.ts")
  const { executeResource } = await import("../../src/core/resource.ts")

  const { connection, calls } = createMockSSH({
    exec: (cmd) => {
      if (cmd.includes("test -f")) {
        return Promise.resolve({ exitCode: 0, stdout: "MISSING\n", stderr: "" })
      }
      if (cmd.includes("sha256sum")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: "abc123  /etc/test.conf\n",
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const ctx = new ExecutionContextImpl({
    connection,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: createMockHost(),
    reporter: silentReporter(),
  })

  const { fileDefinition } = await import("../../src/resources/file.ts")
  const result = await executeResource(ctx, fileDefinition, {
    path: "/etc/test.conf",
    content: "test content",
  })

  expect(result.type).toEqual("file")
  expect(result.status).toEqual("changed")
  expect(calls.exec.length > 0).toBe(true)
})
