import type { ErrorMode } from "../core/types.ts"
import type { HostKeyPolicy } from "../ssh/types.ts"

/** Supported output formats. */
export type OutputFormat = "pretty" | "json" | "minimal"

/** Options specific to run and check commands. */
export type RunCheckOptions = {
  inventory?: string | undefined
  trace?: boolean | undefined
  format?: OutputFormat | undefined
  errorMode?: ErrorMode | undefined
  tags: string[]
  vars: Record<string, unknown>
  confirm?: boolean | undefined
  hostKeyPolicy?: HostKeyPolicy | undefined
  identity?: string | undefined
  multiplex?: boolean | undefined
  parallelism?: number | undefined
  hostTimeout?: number | undefined
  resourceTimeout?: number | undefined
  retries?: number | undefined
  retryDelay?: number | undefined
  cache?: boolean | undefined
  cacheTtl?: number | undefined
  cacheClear?: boolean | undefined
  dashboardHost?: string | undefined
  dashboardPort?: number | undefined
  logDir?: string | undefined
}

/** Fully resolved options after merging CLI flags, config file, and defaults. */
export type ResolvedRunCheckOptions = {
  inventory?: string | undefined
  trace: boolean
  format: OutputFormat
  errorMode: ErrorMode
  tags: string[]
  vars: Record<string, unknown>
  confirm: boolean
  hostKeyPolicy: HostKeyPolicy
  identity?: string | undefined
  multiplex: boolean
  parallelism: number
  hostTimeout: number
  resourceTimeout: number
  retries: number
  retryDelay: number
  cache: boolean
  cacheTtl: number
  cacheClear: boolean
  dashboardHost: string
  dashboardPort: number
  logDir?: string | undefined
}
