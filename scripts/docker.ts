/**
 * Docker sandbox lifecycle helpers.
 *
 * Shared by docker-sandbox.ts (interactive) and validate-recipes.ts (batch).
 * Manages image building, SSH key generation, container lifecycle, and
 * SSH readiness probing.
 */

import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shell } from "./lib.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKER_IMAGE = "ignition-sandbox"

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Build the Docker image from scripts/docker/Dockerfile. */
export async function ensureImage(): Promise<void> {
  const dockerDir = join(import.meta.dir, "docker")
  console.log("  Building Docker image...")
  const { exitCode, stderr } = await shell(["docker", "build", "-t", DOCKER_IMAGE, dockerDir], {
    quiet: true,
  })
  if (exitCode !== 0) {
    throw new Error(`Failed to build Docker image:\n${stderr}`)
  }
  console.log("  Image ready.")
}

/** Generate an ephemeral ed25519 key pair in a temp directory. */
export async function generateKeyPair(): Promise<{
  keyDir: string
  privateKey: string
  publicKey: string
}> {
  const keyDir = join(tmpdir(), `ignition-sandbox-${Date.now()}`)
  mkdirSync(keyDir, { recursive: true })

  const privateKey = join(keyDir, "id_ed25519")
  const publicKey = join(keyDir, "id_ed25519.pub")

  const { exitCode } = await shell([
    "ssh-keygen",
    "-t",
    "ed25519",
    "-f",
    privateKey,
    "-N",
    "",
    "-q",
  ])
  if (exitCode !== 0) {
    throw new Error("Failed to generate SSH key pair")
  }

  return { keyDir, privateKey, publicKey }
}

/** Start a container with the given public key, return container ID and mapped port. */
export async function startContainer(
  publicKeyPath: string,
): Promise<{ containerId: string; port: number }> {
  const pubKey = await Bun.file(publicKeyPath).text()
  const containerName = `ignition-sandbox-${Date.now()}`

  const { stdout, exitCode } = await shell([
    "docker",
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    "0:22",
    DOCKER_IMAGE,
  ])

  if (exitCode !== 0) {
    throw new Error("Failed to start Docker container")
  }

  const containerId = stdout.trim()

  // Inject the public key
  await shell([
    "docker",
    "exec",
    containerId,
    "bash",
    "-c",
    `echo '${pubKey.trim()}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
  ])

  // Get the mapped port
  const { stdout: portOut } = await shell(["docker", "port", containerName, "22"])
  const portMatch = portOut.match(/:(\d+)/)
  if (!portMatch) {
    throw new Error(`Could not determine mapped port from: ${portOut}`)
  }

  return { containerId, port: parseInt(portMatch[1], 10) }
}

/** Poll SSH until it responds or timeout expires. */
export async function waitForSsh(port: number, keyPath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { exitCode } = await shell(
      [
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=2",
        "-o",
        "IdentitiesOnly=yes",
        "-i",
        keyPath,
        "-p",
        String(port),
        "root@127.0.0.1",
        "true",
      ],
      { quiet: true },
    )
    if (exitCode === 0) return
    await Bun.sleep(500)
  }
  throw new Error(`SSH not ready after ${timeoutMs}ms`)
}

/** Force-remove a container. */
export async function killContainer(containerId: string): Promise<void> {
  await shell(["docker", "rm", "-f", containerId], { quiet: true })
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export interface SandboxInfo {
  containerId: string
  port: number
  keyDir: string
  privateKey: string
  target: string
}

/** One-liner: build image → generate keys → start container → wait for SSH. */
export async function startSandbox(): Promise<SandboxInfo> {
  await ensureImage()
  const { keyDir, privateKey, publicKey } = await generateKeyPair()
  const { containerId, port } = await startContainer(publicKey)

  console.log("  Waiting for SSH...")
  await waitForSsh(port, privateKey)

  return {
    containerId,
    port,
    keyDir,
    privateKey,
    target: `root@127.0.0.1:${port}`,
  }
}

/** Tear down container and clean up temp keys. */
export async function stopSandbox(containerId: string, keyDir: string): Promise<void> {
  await killContainer(containerId)
  rmSync(keyDir, { recursive: true, force: true })
}
