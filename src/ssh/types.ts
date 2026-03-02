/**
 * Transport types — capability-driven transport abstraction.
 *
 * Defines the Transport interface and supporting types. SSH remains
 * first-class; future transports can implement a subset of capabilities
 * without resource-layer rewrites. See ADR-0004, ADR-0015, ISSUE-0020.
 */

/** Host key checking policy. See ADR-0009. */
export type HostKeyPolicy = "strict" | "accept-new" | "off"

/** Configuration for an SSH connection. */
export interface SSHConnectionConfig {
  /** SSH hostname or IP address. */
  readonly hostname: string
  /** SSH port (default 22). */
  readonly port: number
  /** SSH user. */
  readonly user: string
  /** Path to private key file (optional — falls back to agent/default). */
  readonly privateKey?: string
  /** Host key checking policy. */
  readonly hostKeyPolicy: HostKeyPolicy
  /** Enable OpenSSH multiplexing (ControlMaster). Defaults to true. */
  readonly multiplexing?: boolean
  /** Directory for ControlPath sockets. Defaults to system temp dir. */
  readonly controlDirectory?: string
}

/** Options for `SSHConnection.exec()`. */
export interface ExecOptions {
  /** Data to pipe to stdin. */
  stdin?: string | Uint8Array
  /** Timeout in milliseconds (0 = no timeout). */
  timeoutMs?: number
  /** Callback invoked with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void
  /** Callback invoked with each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void
  /** AbortSignal for cooperative cancellation. See ISSUE-0030. */
  signal?: AbortSignal
}

/** Result of a remote command execution. */
export interface ExecResult {
  /** Exit code of the remote process. */
  exitCode: number
  /** Standard output. */
  stdout: string
  /** Standard error. */
  stderr: string
}

// ---------------------------------------------------------------------------
// Transport Capabilities (ADR-0015, ISSUE-0020)
// ---------------------------------------------------------------------------

/**
 * Transport capabilities that a connection may support.
 *
 * - `exec`: Execute commands on the remote host.
 * - `transfer`: Push files to the remote host (e.g. scp push).
 * - `fetch`: Pull files from the remote host (e.g. scp pull).
 * - `ping`: Check if the host is reachable.
 */
export type TransportCapability = "exec" | "transfer" | "fetch" | "ping"

/**
 * Capability-driven transport interface. See ADR-0015.
 *
 * Every transport must declare its supported capabilities via `capabilities()`.
 * Callers should check capabilities before invoking optional methods.
 * SSH implements all four capabilities; future transports may implement a subset.
 */
export interface Transport {
  /** Connection configuration. */
  readonly config: SSHConnectionConfig
  /** Return the set of capabilities this transport supports. */
  capabilities(): ReadonlySet<TransportCapability>
  /** Execute a command on the remote host. Requires 'exec' capability. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Transfer a local file to the remote host. Requires 'transfer' capability. */
  transfer(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>
  /** Fetch a remote file to a local path. Requires 'fetch' capability. */
  fetch(remotePath: string, localPath: string, signal?: AbortSignal): Promise<void>
  /** Check if the host is reachable. Requires 'ping' capability. */
  ping(): Promise<boolean>
  /** Close the connection / clean up resources. Always available. */
  close(): Promise<void>
}

/**
 * Check whether a transport supports a given capability.
 */
export function hasCapability(transport: Transport, capability: TransportCapability): boolean {
  return transport.capabilities().has(capability)
}

/**
 * The full set of transport capabilities supported by SSH.
 *
 * Useful for transports that support everything (SystemSSHConnection) or
 * for tests that need a reference set.
 */
export const ALL_TRANSPORT_CAPABILITIES: ReadonlySet<TransportCapability> =
  new Set<TransportCapability>(["exec", "transfer", "fetch", "ping"])

/**
 * Backward-compatible alias. SSHConnection is now Transport.
 *
 * Existing code that references SSHConnection continues to work unchanged.
 * New code should prefer Transport directly.
 */
export type SSHConnection = Transport
