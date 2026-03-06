/**
 * Mock transport for unit tests.
 *
 * Provides a configurable stub implementation of Transport that records
 * all calls for assertion without requiring a real SSH connection.
 * Supports capability configuration for testing capability-driven behavior.
 */

import {
  ALL_TRANSPORT_CAPABILITIES,
  type ExecOptions,
  type ExecResult,
  type SSHConnectionConfig,
  type Transport,
  type TransportCapability,
} from "../../src/ssh/types.ts"
import type { HostContext, Reporter } from "../../src/core/types.ts"

/** Recorded exec call for assertion. */
export type ExecCall = {
  command: string
  opts?: ExecOptions | undefined
}

/** Recorded transfer call for assertion. */
export type TransferCall = {
  localPath: string
  remotePath: string
}

/** Recorded fetch call for assertion. */
export type FetchCall = {
  remotePath: string
  localPath: string
}

/** All calls recorded by a mock transport. */
export type MockSSHCalls = {
  exec: ExecCall[]
  transfer: TransferCall[]
  fetch: FetchCall[]
  ping: number
  close: number
}

/** Options for creating a mock transport. */
export type MockSSHOptions = {
  /** Override the exec handler. Default: returns exit 0 with empty output. */
  exec?: (command: string, opts?: ExecOptions) => Promise<ExecResult>
  /** Override the transfer handler. Default: resolves. */
  transfer?: (localPath: string, remotePath: string, signal?: AbortSignal) => Promise<void>
  /** Override the fetch handler. Default: resolves. */
  fetch?: (remotePath: string, localPath: string, signal?: AbortSignal) => Promise<void>
  /** Override the ping handler. Default: returns true. */
  ping?: () => Promise<boolean>
  /** Override the close handler. Default: resolves. */
  close?: () => Promise<void>
  /** Override connection config. */
  config?: Partial<SSHConnectionConfig>
  /** Override transport capabilities. Default: all capabilities. */
  capabilities?: ReadonlySet<TransportCapability>
}

/** Default connection config used by mock transport. */
const DEFAULT_CONFIG: SSHConnectionConfig = {
  hostname: "10.0.1.10",
  port: 22,
  user: "deploy",
  hostKeyPolicy: "strict",
}

/**
 * Create a mock transport that records all calls.
 *
 * Usage:
 * ```ts
 * const { connection, calls } = createMockSSH()
 * // ... use connection in tests ...
 * assertEquals(calls.exec.length, 2)
 * assertEquals(calls.exec[0].command, 'whoami')
 * ```
 */
export function createMockSSH(opts: MockSSHOptions = {}): {
  connection: Transport
  calls: MockSSHCalls
} {
  const calls: MockSSHCalls = {
    exec: [],
    transfer: [],
    fetch: [],
    ping: 0,
    close: 0,
  }

  const config: SSHConnectionConfig = {
    ...DEFAULT_CONFIG,
    ...opts.config,
  }

  const caps = opts.capabilities ?? ALL_TRANSPORT_CAPABILITIES

  const defaultExec = (): Promise<ExecResult> =>
    Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })

  const connection: Transport = {
    config,
    capabilities(): ReadonlySet<TransportCapability> {
      return caps
    },
    async exec(command: string, execOpts?: ExecOptions): Promise<ExecResult> {
      calls.exec.push({ command, opts: execOpts })
      // Reject immediately if the signal is already aborted.
      if (execOpts?.signal?.aborted) {
        throw new Error("exec aborted")
      }
      const result = await (opts.exec ?? defaultExec)(command, execOpts)
      // Invoke streaming callbacks with the buffered output so tests
      // exercising the streaming pipeline get realistic behavior.
      if (result.stdout && execOpts?.onStdout) execOpts.onStdout(result.stdout)
      if (result.stderr && execOpts?.onStderr) execOpts.onStderr(result.stderr)
      return result
    },
    transfer(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
      calls.transfer.push({ localPath, remotePath })
      if (signal?.aborted) return Promise.reject(new Error("transfer aborted"))
      return (opts.transfer ?? (() => Promise.resolve()))(localPath, remotePath, signal)
    },
    fetch(remotePath: string, localPath: string, signal?: AbortSignal): Promise<void> {
      calls.fetch.push({ remotePath, localPath })
      if (signal?.aborted) return Promise.reject(new Error("fetch aborted"))
      return (opts.fetch ?? (() => Promise.resolve()))(remotePath, localPath, signal)
    },
    ping(): Promise<boolean> {
      calls.ping++
      return (opts.ping ?? (() => Promise.resolve(true)))()
    },
    close(): Promise<void> {
      calls.close++
      return (opts.close ?? (() => Promise.resolve()))()
    },
  }

  return { connection, calls }
}

/** Create a stub HostContext for testing. */
export function createMockHost(overrides: Partial<HostContext> = {}): HostContext {
  return {
    name: overrides.name ?? "web-1",
    hostname: overrides.hostname ?? "10.0.1.10",
    user: overrides.user ?? "deploy",
    port: overrides.port ?? 22,
    vars: overrides.vars ?? {},
  }
}

/** Create a silent (no-op) reporter for testing. */
export function silentReporter(): Reporter {
  return {
    resourceStart() {},
    resourceEnd() {},
  }
}
