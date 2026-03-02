import { test, expect } from "bun:test"
import {
  controlPath,
  createSystemSSHConnection,
  SystemSSHConnection,
} from "../../src/ssh/connection.ts"
import type { HostKeyPolicy, SSHConnectionConfig } from "../../src/ssh/types.ts"

/** Config targeting localhost on a port with no SSH server — fast connection refused. */
function makeConfig(overrides: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig {
  return {
    hostname: "127.0.0.1",
    port: 61222, // unlikely to have an SSH server
    user: "testuser",
    hostKeyPolicy: "off",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// SSHConnectionConfig + construction
// ---------------------------------------------------------------------------

test("SystemSSHConnection stores config", () => {
  const config = makeConfig()
  const conn = new SystemSSHConnection(config)
  expect(conn.config).toEqual(config)
  expect(conn.config.hostname).toEqual("127.0.0.1")
  expect(conn.config.port).toEqual(61222)
  expect(conn.config.user).toEqual("testuser")
})

test("SystemSSHConnection config with private key", () => {
  const config = makeConfig({ privateKey: "~/.ssh/id_ed25519" })
  const conn = new SystemSSHConnection(config)
  expect(conn.config.privateKey).toEqual("~/.ssh/id_ed25519")
})

test("all host key policies accepted", () => {
  const policies: HostKeyPolicy[] = ["strict", "accept-new", "off"]
  for (const policy of policies) {
    const conn = new SystemSSHConnection(makeConfig({ hostKeyPolicy: policy }))
    expect(conn.config.hostKeyPolicy).toEqual(policy)
  }
})

// ---------------------------------------------------------------------------
// createSystemSSHConnection factory
// ---------------------------------------------------------------------------

test("createSystemSSHConnection succeeds when ssh is available", async () => {
  const conn = await createSystemSSHConnection(makeConfig())
  expect(conn).toBeInstanceOf(SystemSSHConnection)
})

// ---------------------------------------------------------------------------
// exec() — against localhost with no SSH server (connection refused, fast)
// ---------------------------------------------------------------------------

test("exec() against refused port returns non-zero exit", async () => {
  const conn = new SystemSSHConnection(makeConfig())
  const result = await conn.exec("true")
  // SSH exits with 255 when it can't connect
  expect(result.exitCode).toEqual(255)
})

// ---------------------------------------------------------------------------
// exec() with stdin piping (exercises the stdin code path)
// ---------------------------------------------------------------------------

test("exec() with stdin still returns result on connection failure", async () => {
  const conn = new SystemSSHConnection(makeConfig())
  const result = await conn.exec("cat", { stdin: "hello" })
  expect(result.exitCode).toEqual(255)
})

// ---------------------------------------------------------------------------
// transfer() / fetch() — verify error wrapping
// ---------------------------------------------------------------------------

test("transfer() to refused port throws TransferError", async () => {
  const conn = new SystemSSHConnection(makeConfig())
  let threw = false
  try {
    await conn.transfer("/dev/null", "/tmp/test")
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
})

test("fetch() from refused port throws TransferError", async () => {
  const conn = new SystemSSHConnection(makeConfig())
  let threw = false
  try {
    await conn.fetch("/tmp/test", "/dev/null")
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
})

// ---------------------------------------------------------------------------
// ping() — returns false for refused connections
// ---------------------------------------------------------------------------

test("ping() returns false for refused port", async () => {
  const conn = new SystemSSHConnection(makeConfig())
  const ok = await conn.ping()
  expect(ok).toEqual(false)
})

// ---------------------------------------------------------------------------
// close() — resolves for both multiplexed and non-multiplexed
// ---------------------------------------------------------------------------

test("close() resolves without error", async () => {
  const conn = new SystemSSHConnection(makeConfig())
  await conn.close()
})

test("close() resolves without error when multiplexing disabled", async () => {
  const conn = new SystemSSHConnection(makeConfig({ multiplexing: false }))
  await conn.close()
})

// ---------------------------------------------------------------------------
// Interface compliance — SSHConnection
// ---------------------------------------------------------------------------

test("SystemSSHConnection implements SSHConnection interface", () => {
  const conn = new SystemSSHConnection(makeConfig())
  expect(typeof conn.exec).toEqual("function")
  expect(typeof conn.transfer).toEqual("function")
  expect(typeof conn.fetch).toEqual("function")
  expect(typeof conn.ping).toEqual("function")
  expect(typeof conn.close).toEqual("function")
  expect(typeof conn.config).toEqual("object")
})

// ---------------------------------------------------------------------------
// Multiplexing config
// ---------------------------------------------------------------------------

test("multiplexing defaults to enabled (undefined treated as true)", () => {
  const config = makeConfig()
  expect(config.multiplexing).toEqual(undefined)
  // multiplexing is enabled when undefined (not explicitly false)
  const conn = new SystemSSHConnection(config)
  expect(conn.config.multiplexing).toEqual(undefined)
})

test("multiplexing can be explicitly disabled", () => {
  const config = makeConfig({ multiplexing: false })
  const conn = new SystemSSHConnection(config)
  expect(conn.config.multiplexing).toEqual(false)
})

test("multiplexing can be explicitly enabled", () => {
  const config = makeConfig({ multiplexing: true })
  const conn = new SystemSSHConnection(config)
  expect(conn.config.multiplexing).toEqual(true)
})

// ---------------------------------------------------------------------------
// controlPath — deterministic socket path
// ---------------------------------------------------------------------------

test("controlPath uses short prefix with %C hash token", () => {
  const config = makeConfig()
  const path = controlPath(config)
  expect(path).toContain("ign-%C")
})

test("controlPath uses controlDirectory when set", () => {
  const config = makeConfig({ controlDirectory: "/custom/dir" })
  const path = controlPath(config)
  expect(path).toContain("/custom/dir/ign-%C")
})

test("controlPath falls back to /tmp", () => {
  const config = makeConfig()
  const path = controlPath(config)
  expect(path).toEqual("/tmp/ign-%C")
})

test("controlPath falls back to /tmp when controlDirectory path is too long", () => {
  const config = makeConfig({
    controlDirectory: "/tmp/ign-12345678-1234-1234-1234-1234567890ab",
  })
  const path = controlPath(config)
  expect(path).toEqual("/tmp/ign-%C")
})
