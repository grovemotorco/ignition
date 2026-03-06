/**
 * Tagged error hierarchy for Ignition.
 *
 * Every error carries a `tag` discriminant for programmatic matching and a
 * structured `context` bag for diagnostic details.
 */

/** Discriminant tags for the error hierarchy. */
export type IgnitionErrorTag =
  | "SSHConnectionError"
  | "SSHCommandError"
  | "TransferError"
  | "ResourceError"
  | "RecipeLoadError"
  | "InventoryError"
  | "CapabilityError"

/** Base class for all Ignition errors. */
export class IgnitionError extends Error {
  tag: IgnitionErrorTag
  context: Record<string, unknown>

  constructor(
    tag: IgnitionErrorTag,
    message: string,
    context: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(message, { cause })
    this.name = tag
    this.tag = tag
    this.context = context
  }
}

/** Failed to establish an SSH connection to a host. */
export class SSHConnectionError extends IgnitionError {
  constructor(host: string, message: string, cause?: Error, port?: number) {
    super("SSHConnectionError", message, { host, ...(port !== undefined ? { port } : {}) }, cause)
  }
}

/** An SSH command returned a non-zero exit code. */
export class SSHCommandError extends IgnitionError {
  exitCode: number
  stdout: string
  stderr: string

  constructor(command: string, exitCode: number, stdout: string, stderr: string, cause?: Error) {
    super(
      "SSHCommandError",
      `Command failed (exit ${exitCode}): ${command}`,
      {
        command,
        exitCode,
        stdout,
        stderr,
      },
      cause,
    )
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

/** File transfer (scp) failure. */
export class TransferError extends IgnitionError {
  constructor(localPath: string, remotePath: string, message: string, cause?: Error) {
    super("TransferError", message, { localPath, remotePath }, cause)
  }
}

/** A resource's check() or apply() failed. */
export class ResourceError extends IgnitionError {
  constructor(resourceType: string, resourceName: string, message: string, cause?: Error) {
    super("ResourceError", message, { resourceType, resourceName }, cause)
  }
}

/** Failed to load or parse a recipe file. */
export class RecipeLoadError extends IgnitionError {
  constructor(path: string, message: string, cause?: Error) {
    super("RecipeLoadError", message, { path }, cause)
  }
}

/** Failed to load or resolve inventory. */
export class InventoryError extends IgnitionError {
  constructor(path: string, message: string, cause?: Error) {
    super("InventoryError", message, { path }, cause)
  }
}

/**
 * A transport does not support a required capability.
 *
 * Thrown when a resource requires a capability (e.g. 'transfer') that the
 * current transport does not support.
 */
export class CapabilityError extends IgnitionError {
  /** The capability that was required but not supported. */
  capability: string

  constructor(capability: string, resourceType: string, message?: string, cause?: Error) {
    const msg =
      message ?? `Transport does not support '${capability}' (required by ${resourceType})`
    super("CapabilityError", msg, { capability, resourceType }, cause)
    this.capability = capability
  }
}

/**
 * Determine whether an error is retryable (transient transport failure).
 *
 * Retryable: SSHConnectionError, TransferError (network-level issues).
 * Non-retryable: SSHCommandError (command exited non-zero — deterministic),
 *   ResourceError, RecipeLoadError, InventoryError, unknown errors.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof IgnitionError)) return false
  return error.tag === "SSHConnectionError" || error.tag === "TransferError"
}
