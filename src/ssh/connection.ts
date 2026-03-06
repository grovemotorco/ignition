/**
 * SystemSSHConnection — SSH transport via system `ssh` and `scp` binaries.
 *
 * Uses `Bun.spawn` to shell out. Supports OpenSSH multiplexing
 * (ControlMaster/ControlPersist) for connection reuse across commands.
 */

import { SSHConnectionError, TransferError } from "../core/errors.ts"
import {
  ALL_TRANSPORT_CAPABILITIES,
  type ExecOptions,
  type ExecResult,
  type HostKeyPolicy,
  type SSHConnectionConfig,
  type Transport,
  type TransportCapability,
} from "./types.ts"

/** Map our policy names to OpenSSH's StrictHostKeyChecking values. */
function hostKeyFlag(policy: HostKeyPolicy): string {
  switch (policy) {
    case "strict":
      return "yes"
    case "accept-new":
      return "accept-new"
    case "off":
      return "no"
  }
}

/**
 * Build a deterministic ControlPath for a given config.
 *
 * Uses `%C` (a hash of `%l%h%p%r`) to keep the socket path short — macOS
 * limits Unix socket paths to 104 bytes, and `%h-%p-%r` can easily exceed
 * that with long hostnames. Falls back to `/tmp` which is shorter than
 * `$TMPDIR` on macOS (`/var/folders/…` is ~50 chars alone).
 */
export function controlPath(config: SSHConnectionConfig): string {
  const dir = config.controlDirectory ?? "/tmp"
  const candidate = `${dir}/ign-%C`
  if (projectedControlPathLength(candidate) <= 104) {
    return candidate
  }
  return "/tmp/ign-%C"
}

/**
 * Conservative estimate for final Unix socket path length.
 *
 * `%C` expands to a 40-char hash, and OpenSSH may append a temporary suffix
 * like `.XXXXXXXXXXXXXXX` while creating the master socket.
 */
function projectedControlPathLength(template: string): number {
  const expandedHashLength = 40
  const tempSuffixBudget = 17
  return template.replace("%C", "x".repeat(expandedHashLength)).length + tempSuffixBudget
}

/** Build multiplexing SSH args when enabled. */
function multiplexArgs(config: SSHConnectionConfig): string[] {
  if (config.multiplexing === false) return []
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath(config)}`,
    "-o",
    "ControlPersist=60s",
  ]
}

/** Build the base SSH args shared by exec/ping. */
function baseSshArgs(config: SSHConnectionConfig): string[] {
  const args: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${hostKeyFlag(config.hostKeyPolicy)}`,
    "-p",
    String(config.port),
    ...multiplexArgs(config),
  ]
  if (config.privateKey) {
    // IdentitiesOnly prevents SSH from cycling through all agent keys when
    // a key is explicitly provided, avoiding "Too many authentication failures"
    // when the agent has many loaded identities.
    args.push("-i", config.privateKey, "-o", "IdentitiesOnly=yes")
  }
  return args
}

/** Build the user@host destination string. */
function destination(config: SSHConnectionConfig): string {
  return `${config.user}@${config.hostname}`
}

/** Build base SCP args. */
function baseScpArgs(config: SSHConnectionConfig): string[] {
  const args: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    `StrictHostKeyChecking=${hostKeyFlag(config.hostKeyPolicy)}`,
    "-P",
    String(config.port),
    ...multiplexArgs(config),
  ]
  if (config.privateKey) {
    args.push("-i", config.privateKey, "-o", "IdentitiesOnly=yes")
  }
  return args
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/**
 * Run a command and buffer stdout/stderr into Uint8Arrays.
 * Handles abort signal by killing the subprocess.
 */
async function runBuffered(
  bin: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const proc = Bun.spawn([bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const cleanup = wireAbortSignal(proc, opts?.signal)

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
      new Response(proc.stderr).arrayBuffer().then((b) => new Uint8Array(b)),
    ])
    await proc.exited
    return { exitCode: proc.exitCode ?? 1, stdout, stderr }
  } finally {
    cleanup()
  }
}

/** Connect an AbortSignal to kill a subprocess. Returns a cleanup function. */
function wireAbortSignal(proc: { kill(): void }, signal?: AbortSignal): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    proc.kill()
    return () => {}
  }
  const onAbort = () => proc.kill()
  signal.addEventListener("abort", onAbort, { once: true })
  return () => signal.removeEventListener("abort", onAbort)
}

// ---------------------------------------------------------------------------
// SystemSSHConnection
// ---------------------------------------------------------------------------

/**
 * SSH transport that shells out to the system's `ssh` and `scp` binaries
 * via `Bun.spawn`. Supports OpenSSH multiplexing for connection reuse.
 *
 * Implements the full Transport interface with all four capabilities:
 * exec, transfer, fetch, and ping.
 */
export class SystemSSHConnection implements Transport {
  config: SSHConnectionConfig

  constructor(config: SSHConnectionConfig) {
    this.config = config
  }

  /** SSH supports all transport capabilities. */
  capabilities(): ReadonlySet<TransportCapability> {
    return ALL_TRANSPORT_CAPABILITIES
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const args = [...baseSshArgs(this.config), destination(this.config), command]
    const timeoutMs = opts?.timeoutMs ?? 0

    // Derive a single AbortController that fires on timeout OR external signal.
    const controller = new AbortController()
    let timedOut = false
    const timeoutId =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        : undefined

    // Forward external signal into derived controller
    const externalSignal = opts?.signal
    if (externalSignal?.aborted) {
      controller.abort()
    } else if (externalSignal) {
      const onAbort = () => controller.abort()
      externalSignal.addEventListener("abort", onAbort, { once: true })
      controller.signal.addEventListener(
        "abort",
        () => externalSignal.removeEventListener("abort", onAbort),
        { once: true },
      )
    }

    const hasStdin = opts?.stdin !== undefined
    const hasCallbacks = opts?.onStdout !== undefined || opts?.onStderr !== undefined

    try {
      // Streaming path: spawn + ReadableStream when callbacks or stdin are present
      if (hasStdin || hasCallbacks) {
        const child = Bun.spawn(["ssh", ...args], {
          stdin: hasStdin ? "pipe" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const cleanup = wireAbortSignal(child, controller.signal)

        try {
          if (hasStdin) {
            const data =
              typeof opts!.stdin === "string" ? new TextEncoder().encode(opts!.stdin) : opts!.stdin!
            await child.stdin!.write(data)
            await child.stdin!.end()
          }

          if (hasCallbacks) {
            const result = await readStreamsWithCallbacks(child, opts?.onStdout, opts?.onStderr)
            if (controller.signal.aborted) {
              throwAbortError(this.config.hostname, timedOut, timeoutMs, externalSignal)
            }
            return result
          }

          // Has stdin but no callbacks — buffer output
          const [stdoutBuf, stderrBuf] = await Promise.all([
            new Response(child.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
            new Response(child.stderr).arrayBuffer().then((b) => new Uint8Array(b)),
          ])
          await child.exited
          if (controller.signal.aborted) {
            throwAbortError(this.config.hostname, timedOut, timeoutMs, externalSignal)
          }
          const stdout = new TextDecoder().decode(stdoutBuf)
          const stderr = new TextDecoder().decode(stderrBuf)
          return { exitCode: child.exitCode ?? 1, stdout, stderr }
        } finally {
          cleanup()
        }
      }

      // Buffered path: no callbacks, no stdin
      const output = await runBuffered("ssh", args, { signal: controller.signal })
      if (controller.signal.aborted) {
        throwAbortError(this.config.hostname, timedOut, timeoutMs, externalSignal)
      }
      const stdout = new TextDecoder().decode(output.stdout)
      const stderr = new TextDecoder().decode(output.stderr)
      return { exitCode: output.exitCode, stdout, stderr }
    } catch (err) {
      if (err instanceof SSHConnectionError) throw err
      const error = err instanceof Error ? err : new Error(String(err))
      throw new SSHConnectionError(this.config.hostname, `ssh exec failed: ${error.message}`, error)
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
    }
  }

  async transfer(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    const args = [
      ...baseScpArgs(this.config),
      localPath,
      `${destination(this.config)}:${remotePath}`,
    ]

    try {
      const output = await runBuffered("scp", args, { signal })

      if (output.exitCode !== 0) {
        const stderr = new TextDecoder().decode(output.stderr)
        throw new TransferError(
          localPath,
          remotePath,
          `scp push failed (exit ${output.exitCode}): ${stderr}`,
        )
      }
    } catch (err) {
      if (err instanceof TransferError) throw err
      if (signal?.aborted) {
        throw new TransferError(localPath, remotePath, "scp push aborted")
      }
      throw err
    }
  }

  async fetch(remotePath: string, localPath: string, signal?: AbortSignal): Promise<void> {
    const args = [
      ...baseScpArgs(this.config),
      `${destination(this.config)}:${remotePath}`,
      localPath,
    ]

    try {
      const output = await runBuffered("scp", args, { signal })

      if (output.exitCode !== 0) {
        const stderr = new TextDecoder().decode(output.stderr)
        throw new TransferError(
          localPath,
          remotePath,
          `scp fetch failed (exit ${output.exitCode}): ${stderr}`,
        )
      }
    } catch (err) {
      if (err instanceof TransferError) throw err
      if (signal?.aborted) {
        throw new TransferError(localPath, remotePath, "scp fetch aborted")
      }
      throw err
    }
  }

  /** Last ping stderr, available for diagnostics after ping() returns false. */
  lastPingError = ""

  async ping(): Promise<boolean> {
    const ok = await this.#tryPing()
    if (ok) return true

    // When multiplexing is enabled a stale control socket from a previous
    // session (e.g. killed process) can cause the first attempt to fail.
    // Clean up the dead socket and retry once.
    if (this.config.multiplexing !== false) {
      await this.close()
      return await this.#tryPing()
    }
    return false
  }

  async #tryPing(): Promise<boolean> {
    const args = [
      ...baseSshArgs(this.config),
      "-o",
      "ConnectTimeout=5",
      destination(this.config),
      "true",
    ]
    try {
      const output = await runBuffered("ssh", args)
      if (output.exitCode !== 0) {
        this.lastPingError = new TextDecoder().decode(output.stderr).trim()
      }
      return output.exitCode === 0
    } catch (err) {
      this.lastPingError = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /**
   * Close the connection and clean up multiplexing socket if active.
   *
   * Sends `ssh -O exit` to tear down the ControlMaster. Failures are
   * silently ignored — the socket will expire via ControlPersist anyway.
   */
  async close(): Promise<void> {
    if (this.config.multiplexing === false) return

    try {
      await runBuffered("ssh", [
        "-o",
        `ControlPath=${controlPath(this.config)}`,
        "-O",
        "exit",
        destination(this.config),
      ])
    } catch {
      // Socket may not exist or already expired — safe to ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Throw the appropriate abort error based on what triggered cancellation. */
function throwAbortError(
  hostname: string,
  timedOut: boolean,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): never {
  if (timedOut) {
    throw new SSHConnectionError(hostname, `ssh exec timeout after ${timeoutMs}ms`)
  }
  if (externalSignal?.aborted) {
    throw new SSHConnectionError(hostname, `ssh exec aborted`)
  }
  throw new SSHConnectionError(hostname, `ssh exec aborted`)
}

/**
 * Read stdout/stderr streams concurrently, invoking callbacks per chunk
 * and accumulating the full output for the buffered ExecResult return.
 */
async function readStreamsWithCallbacks(
  child: {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    exitCode: number | null
  },
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
): Promise<ExecResult> {
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []
  const stdoutDecoder = new TextDecoder()
  const stderrDecoder = new TextDecoder()

  async function drain(
    stream: ReadableStream<Uint8Array>,
    chunks: Uint8Array[],
    decoder: TextDecoder,
    callback?: (chunk: string) => void,
  ): Promise<void> {
    for await (const chunk of stream) {
      chunks.push(chunk)
      if (callback) {
        callback(decoder.decode(chunk, { stream: true }))
      }
    }
    if (callback) {
      const final = decoder.decode()
      if (final) callback(final)
    }
  }

  await Promise.all([
    drain(child.stdout, stdoutChunks, stdoutDecoder, onStdout),
    drain(child.stderr, stderrChunks, stderrDecoder, onStderr),
  ])

  await child.exited
  const stdout = new TextDecoder().decode(concat(stdoutChunks))
  const stderr = new TextDecoder().decode(concat(stderrChunks))
  return { exitCode: child.exitCode ?? 1, stdout, stderr }
}

/** Concatenate an array of Uint8Array chunks into a single Uint8Array. */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.length
  }
  return result
}

/** Create a SystemSSHConnection, validating that `ssh` is available. */
export async function createSystemSSHConnection(
  config: SSHConnectionConfig,
): Promise<SystemSSHConnection> {
  try {
    const check = await runBuffered("ssh", ["-V"])
    if (check.exitCode !== 0) {
      throw new Error("ssh -V returned non-zero")
    }
  } catch (err) {
    throw new SSHConnectionError(
      config.hostname,
      "ssh binary not found or not executable",
      err instanceof Error ? err : undefined,
    )
  }
  return new SystemSSHConnection(config)
}
