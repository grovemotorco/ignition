import type { ErrorMode } from "../core/types.ts"
import type { HostKeyPolicy } from "../ssh/types.ts"

/** Supported output formats. */
export type OutputFormat = "pretty" | "json" | "minimal"

/** Options specific to run and check commands. */
export interface RunCheckOptions {
  readonly inventory?: string
  readonly verbose?: boolean
  readonly format?: OutputFormat
  readonly errorMode?: ErrorMode
  readonly tags: readonly string[]
  readonly vars: Record<string, unknown>
  readonly confirm?: boolean
  readonly hostKeyPolicy?: HostKeyPolicy
  readonly identity?: string
  readonly multiplex?: boolean
  readonly parallelism?: number
  readonly hostTimeout?: number
  readonly resourceTimeout?: number
  readonly retries?: number
  readonly retryDelay?: number
  readonly cache?: boolean
  readonly cacheTtl?: number
  readonly cacheClear?: boolean
  readonly dashboard?: string
  readonly logDir?: string
}

/** Fully resolved options after merging CLI flags, config file, and defaults. */
export interface ResolvedRunCheckOptions {
  readonly inventory?: string
  readonly verbose: boolean
  readonly format: OutputFormat
  readonly errorMode: ErrorMode
  readonly tags: readonly string[]
  readonly vars: Record<string, unknown>
  readonly confirm: boolean
  readonly hostKeyPolicy: HostKeyPolicy
  readonly identity?: string
  readonly multiplex: boolean
  readonly parallelism: number
  readonly hostTimeout: number
  readonly resourceTimeout: number
  readonly retries: number
  readonly retryDelay: number
  readonly cache: boolean
  readonly cacheTtl: number
  readonly cacheClear: boolean
  readonly dashboard?: string
  readonly logDir?: string
}
