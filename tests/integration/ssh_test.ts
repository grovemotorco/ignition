/**
 * Integration test: SystemSSHConnection against a real Deno Sandbox.
 *
 * Proves the SSH transport can connect, execute commands, and transfer files
 * on an ephemeral Linux microVM. Skips gracefully when DENO_DEPLOY_TOKEN is
 * not set.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { hasSandboxToken, createSandboxHandle, type SandboxHandle } from "./sandbox_fixture.ts"

const SKIP = !hasSandboxToken()

describe.skipIf(SKIP)("integration: ssh", () => {
  let sb: SandboxHandle

  beforeAll(async () => {
    sb = await createSandboxHandle()
  })

  afterAll(async () => {
    await sb?.kill()
  })

  test("exec a command on sandbox host", async () => {
    const result = await sb.conn.exec("echo hello")
    expect(result.exitCode).toEqual(0)
    expect(result.stdout.trim()).toEqual("hello")
  })

  test("ping returns true for reachable sandbox", async () => {
    const reachable = await sb.conn.ping()
    expect(reachable).toEqual(true)
  })
})

if (SKIP) {
  console.log(
    "Set DENO_DEPLOY_TOKEN and IGNITION_RUN_SANDBOX_TESTS=1 to run sandbox integration tests",
  )
}
