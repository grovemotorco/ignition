/**
 * Shared sandbox fixture for integration tests.
 *
 * Creates an ephemeral Deno Sandbox microVM with SSH access. Provides both
 * a per-test helper (`withSandbox`) and a per-suite helper (`createSandboxHandle`)
 * for use with `beforeAll`/`afterAll`. Requires DENO_DEPLOY_TOKEN to be set in
 * the environment.
 */

import { Sandbox } from "@deno/sandbox"
import { createSystemSSHConnection } from "../../src/ssh/connection.ts"

/** SSH credentials returned by the sandbox. */
export type SandboxSSH = {
  hostname: string
  username: string
}

/** Handle returned by `createSandboxHandle` for use in beforeAll/afterAll. */
export type SandboxHandle = {
  ssh: SandboxSSH
  conn: Awaited<ReturnType<typeof createSystemSSHConnection>>
  kill(): Promise<void>
}

type CreateSandboxHandleOptions = {
  multiplexing?: boolean | undefined
  controlDirectory?: string | undefined
}

/** Whether the sandbox token is available (integration tests can run). */
export function hasSandboxToken(): boolean {
  const hasToken = !!process.env["DENO_DEPLOY_TOKEN"]
  const enabled = process.env["IGNITION_RUN_SANDBOX_TESTS"] === "1"
  return hasToken && enabled
}

/**
 * Create a sandbox handle for use with `beforeAll`/`afterAll`.
 * Returns the SSH credentials, a shared connection, and a kill function.
 * This avoids spinning up a new VM per test.
 */
export async function createSandboxHandle(
  options: CreateSandboxHandleOptions = {},
): Promise<SandboxHandle> {
  const sandbox = await Sandbox.create({ lifetime: "5m", region: "ord" })
  const ssh = await sandbox.exposeSsh()
  await waitForSshReady({ hostname: ssh.hostname, username: ssh.username })

  const conn = await createSystemSSHConnection({
    hostname: ssh.hostname,
    port: 22,
    user: ssh.username,
    hostKeyPolicy: "off",
    multiplexing: options.multiplexing ?? false,
    controlDirectory: options.controlDirectory,
  })

  return {
    ssh,
    conn,
    async kill() {
      await conn.close().catch(() => {})
      await sandbox.kill().catch(() => {})
    },
  }
}

/**
 * Create an ephemeral sandbox, expose SSH, call `fn` with credentials, then
 * kill the VM. Prefer `createSandboxHandle` + `beforeAll`/`afterAll` for
 * multi-test suites to avoid per-test VM spinup.
 */
export async function withSandbox(fn: (ssh: SandboxSSH) => Promise<void>): Promise<void> {
  const sandbox = await Sandbox.create({ lifetime: "5m", region: "ord" })
  try {
    const ssh = await sandbox.exposeSsh()
    await waitForSshReady({
      hostname: ssh.hostname,
      username: ssh.username,
    })
    await fn({ hostname: ssh.hostname, username: ssh.username })
  } finally {
    await sandbox.kill()
  }
}

async function waitForSshReady(ssh: SandboxSSH): Promise<void> {
  const deadline = Date.now() + 20_000
  let lastError = "unknown error"

  while (Date.now() < deadline) {
    const conn = await createSystemSSHConnection({
      hostname: ssh.hostname,
      port: 22,
      user: ssh.username,
      hostKeyPolicy: "off",
      multiplexing: false,
    })

    try {
      const result = await conn.exec("true", { timeoutMs: 3_000 })
      if (result.exitCode === 0) return
      lastError = `ssh exit ${result.exitCode}: ${result.stderr || result.stdout || "<empty>"}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      await conn.close().catch(() => {})
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Sandbox SSH did not become ready within 20s: ${lastError}`)
}
