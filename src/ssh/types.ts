/**
 * Transport types — capability-driven transport abstraction.
 *
 * Defines the Transport type and supporting types. SSH remains
 * first-class; future transports can implement a subset of capabilities
 * without resource-layer rewrites.
 */

/** Host key checking policy. */
export type HostKeyPolicy = "strict" | "accept-new" | "off"

/** Configuration for an SSH connection. */
export type SSHConnectionConfig = {
  /** SSH hostname or IP address. */
  hostname: string
  /** SSH port (default 22). */
  port: number
  /** SSH user. */
  user: string
  /** Path to private key file (optional — falls back to agent/default). */
  privateKey?: string | undefined
  /** Host key checking policy. */
  hostKeyPolicy: HostKeyPolicy
  /** Enable OpenSSH multiplexing (ControlMaster). Defaults to true. */
  multiplexing?: boolean | undefined
  /** Directory for ControlPath sockets. Defaults to system temp dir. */
  controlDirectory?: string | undefined
}

/** Options for `SSHConnection.exec()`. */
export type ExecOptions = {
  /** Data to pipe to stdin. */
  stdin?: string | Uint8Array | undefined
  /** Timeout in milliseconds (0 = no timeout). */
  timeoutMs?: number | undefined
  /** Callback invoked with each stdout chunk as it arrives. */
  onStdout?: ((chunk: string) => void) | undefined
  /** Callback invoked with each stderr chunk as it arrives. */
  onStderr?: ((chunk: string) => void) | undefined
  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal | undefined
}

/** Result of a remote command execution. */
export type ExecResult = {
  /** Exit code of the remote process. */
  exitCode: number
  /** Standard output. */
  stdout: string
  /** Standard error. */
  stderr: string
}

// ---------------------------------------------------------------------------
// Transport Capabilities
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
 * Capability-driven transport type.
 *
 * Every transport must declare its supported capabilities via `capabilities()`.
 * Callers should check capabilities before invoking optional methods.
 * SSH implements all four capabilities; future transports may implement a subset.
 */
export type Transport = {
  /** Connection configuration. */
  config: SSHConnectionConfig
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
