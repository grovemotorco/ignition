/**
 * Integration test: SCP transfer & fetch against real Deno Sandbox microVMs.
 *
 * Tests file push/pull via SCP, the file resource's source mode, and SSH
 * multiplexing (ControlMaster). Uses one shared sandbox per suite. Skips
 * gracefully when DENO_DEPLOY_TOKEN is not set. See ADR-0017, ISSUE-0022.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { hasSandboxToken, createSandboxHandle, type SandboxHandle } from "./sandbox_fixture.ts"
import { createSystemSSHConnection } from "../../src/ssh/connection.ts"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { createResources } from "../../src/resources/index.ts"
import type { Reporter } from "../../src/core/types.ts"

const SKIP = !hasSandboxToken()

function silentReporter(): Reporter {
  return {
    resourceStart() {},
    resourceEnd() {},
  }
}

describe.skipIf(SKIP)("integration: transfer", () => {
  let sb: SandboxHandle

  beforeAll(async () => {
    sb = await createSandboxHandle()
  })

  afterAll(async () => {
    await sb?.kill()
  })

  test("push a local file to sandbox, verify content", async () => {
    const content = "scp push integration test content\n"
    const remotePath = "/tmp/ignition-integ-transfer-push.txt"

    const tmpFileDir = await mkdtemp(join(tmpdir(), "ignition-integ-"))
    const localPath = join(tmpFileDir, "file")
    try {
      await writeFile(localPath, content)
      await sb.conn.transfer(localPath, remotePath)

      const catResult = await sb.conn.exec(`cat ${remotePath}`)
      expect(catResult.stdout).toEqual(content)
    } finally {
      await rm(tmpFileDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("pull a remote file to local, verify content", async () => {
    const content = "scp fetch integration test content\n"
    const remotePath = "/tmp/ignition-integ-transfer-fetch.txt"

    await sb.conn.exec(`cat > ${remotePath}`, { stdin: content })

    const tmpFileDir = await mkdtemp(join(tmpdir(), "ignition-integ-"))
    const localPath = join(tmpFileDir, "file")
    try {
      await sb.conn.fetch(remotePath, localPath)

      const localContent = await readFile(localPath, "utf-8")
      expect(localContent).toEqual(content)
    } finally {
      await rm(tmpFileDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("file with source — deploy via SCP, verify content and checksum", async () => {
    const content = "file source deployment test\n"
    const remotePath = "/tmp/ignition-integ-file-source.txt"

    const tmpFileDir = await mkdtemp(join(tmpdir(), "ignition-integ-"))
    const localPath = join(tmpFileDir, "file")
    try {
      await writeFile(localPath, content)

      const ctx = new ExecutionContextImpl({
        connection: sb.conn,
        mode: "apply",
        errorMode: "fail-fast",
        verbose: false,
        host: {
          name: "sandbox",
          hostname: sb.ssh.hostname,
          user: sb.ssh.username,
          port: 22,
          vars: {},
        },
        reporter: silentReporter(),
      })

      const { file } = createResources(ctx)
      const r = await file({ path: remotePath, source: localPath })
      expect(r.status).toEqual("changed")

      const catResult = await sb.conn.exec(`cat ${remotePath}`)
      expect(catResult.stdout).toEqual(content)

      const sumResult = await sb.conn.exec(`sha256sum ${remotePath} | awk '{print $1}'`)
      const data = new TextEncoder().encode(content)
      const hash = await crypto.subtle.digest("SHA-256", data)
      const localChecksum = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      expect(sumResult.stdout.trim()).toEqual(localChecksum)
    } finally {
      await rm(tmpFileDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("multiplexing — connection reuse across commands", async () => {
    // Multiplexing needs its own connection with ControlMaster enabled.
    // Use /tmp as base — macOS $TMPDIR can exceed the 104-byte sun_path limit.
    const controlDir = `/tmp/ign-${crypto.randomUUID().slice(0, 8)}`
    mkdirSync(controlDir, { recursive: true })

    const muxConn = await createSystemSSHConnection({
      hostname: sb.ssh.hostname,
      port: 22,
      user: sb.ssh.username,
      hostKeyPolicy: "off",
      multiplexing: true,
      controlDirectory: controlDir,
    })

    try {
      const r1 = await muxConn.exec("echo one")
      expect(r1.exitCode).toEqual(0)
      expect(r1.stdout.trim()).toEqual("one")

      const r2 = await muxConn.exec("echo two")
      expect(r2.exitCode).toEqual(0)
      expect(r2.stdout.trim()).toEqual("two")

      const r3 = await muxConn.exec("hostname")
      expect(r3.exitCode).toEqual(0)

      const r4 = await muxConn.exec("uname -s")
      expect(r4.exitCode).toEqual(0)
      expect(r4.stdout.trim()).toEqual("Linux")

      const r5 = await muxConn.exec("whoami")
      expect(r5.exitCode).toEqual(0)
    } finally {
      await muxConn.close()
      await rm(controlDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

if (SKIP) {
  console.log(
    "Set DENO_DEPLOY_TOKEN and IGNITION_RUN_SANDBOX_TESTS=1 to run transfer integration tests",
  )
}
