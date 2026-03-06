/**
 * Configuration file loader for Ignition CLI.
 *
 * Loads `ignition.config.ts` from the project root via dynamic import
 * and merges config values with CLI flags (CLI always wins).
 */

import { resolve } from "node:path"
import type { ErrorMode } from "../core/types.ts"
import { DEFAULT_CONCURRENCY, DEFAULT_RESOURCE_POLICY } from "../core/types.ts"
import { DEFAULT_CACHE_TTL_MS } from "../core/cache.ts"
import type { HostKeyPolicy } from "../ssh/types.ts"
import type { OutputFormat, ResolvedRunCheckOptions, RunCheckOptions } from "./types.ts"

/** The config file name to look for in the project root. */
const CONFIG_FILENAME = "ignition.config.ts"

/** Valid values for enum-typed config fields. */
const VALID_FORMATS: string[] = ["pretty", "json", "minimal"]
const VALID_ERROR_MODES: string[] = ["fail-fast", "fail-at-end", "ignore"]
const VALID_HOST_KEY_POLICIES: string[] = ["strict", "accept-new", "off"]

/**
 * Configuration file shape for `ignition.config.ts`.
 *
 * All fields are optional — they provide defaults that CLI flags override.
 *
 * @example
 * ```typescript
 * import type { IgnitionConfig } from '@grovemotorco/ignition'
 *
 * const config: IgnitionConfig = {
 *   inventory: 'hosts.ts',
 *   parallelism: 8,
 *   trace: true,
 * }
 *
 * export default config
 * ```
 */
export type IgnitionConfig = {
  /** Default inventory file path. */
  inventory?: string | undefined
  /** Default output format. */
  format?: OutputFormat | undefined
  /** Default error handling mode. */
  errorMode?: ErrorMode | undefined
  /** Maximum concurrent hosts. */
  parallelism?: number | undefined
  /** Per-host timeout in ms (0 = unlimited). */
  hostTimeout?: number | undefined
  /** Per-resource timeout in ms (0 = unlimited). */
  resourceTimeout?: number | undefined
  /** Retry attempts for transient failures. */
  retries?: number | undefined
  /** Initial retry backoff in ms. */
  retryDelay?: number | undefined
  /** Enable SSH connection multiplexing. */
  multiplex?: boolean | undefined
  /** SSH host key verification policy. */
  hostKeyPolicy?: HostKeyPolicy | undefined
  /** Dashboard server hostname. */
  dashboardHost?: string | undefined
  /** Dashboard server port. */
  dashboardPort?: number | undefined
  /** NDJSON log output directory. */
  logDir?: string | undefined
  /** Enable trace output. */
  trace?: boolean | undefined
  /** Enable check result caching. */
  cache?: boolean | undefined
  /** Cache TTL in ms. */
  cacheTtl?: number | undefined
  /** Clear cache before running. */
  cacheClear?: boolean | undefined
  /** Default variable overrides. */
  vars?: Record<string, unknown> | undefined
}

/**
 * Load an IgnitionConfig from `ignition.config.ts` in the given directory.
 *
 * Returns an empty config if the file doesn't exist.
 * Throws on syntax errors or invalid config values.
 */
export async function loadConfig(cwd: string): Promise<IgnitionConfig> {
  const configPath = resolve(cwd, CONFIG_FILENAME)

  try {
    const exists = await Bun.file(configPath).exists()
    if (!exists) return {}

    const url = new URL(`file://${configPath}`).href
    const mod = await import(url)
    const config = (mod.default as IgnitionConfig) ?? {}
    validateConfig(config)
    return config
  } catch (err) {
    if (err instanceof ConfigValidationError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigValidationError(`Failed to load ${CONFIG_FILENAME}: ${message}`)
  }
}

/**
 * Merge CLI options with config file values.
 *
 * Precedence: CLI flag > config file > hardcoded default.
 *
 * CLI flags are `undefined` when not explicitly passed by the user (Stricli
 * flags use `optional: true` instead of `default:`). This lets the merge
 * correctly distinguish "user explicitly passed --no-trace" (`false`) from
 * "user didn't pass --trace" (`undefined`).
 */
export function mergeWithConfig(
  options: RunCheckOptions,
  config: IgnitionConfig,
): ResolvedRunCheckOptions {
  return {
    tags: options.tags,
    vars: { ...config.vars, ...options.vars },
    // CLI ?? config ?? default
    inventory: options.inventory ?? config.inventory,
    logDir: options.logDir ?? config.logDir,
    trace: options.trace ?? config.trace ?? false,
    format: options.format ?? config.format ?? "pretty",
    errorMode: options.errorMode ?? config.errorMode ?? "fail-fast",
    // confirm is intentionally not config-settable — too dangerous as a default
    confirm: options.confirm ?? false,
    hostKeyPolicy: options.hostKeyPolicy ?? config.hostKeyPolicy ?? "accept-new",
    identity: options.identity,
    multiplex: options.multiplex ?? config.multiplex ?? true,
    parallelism: options.parallelism ?? config.parallelism ?? DEFAULT_CONCURRENCY.parallelism,
    hostTimeout: options.hostTimeout ?? config.hostTimeout ?? DEFAULT_CONCURRENCY.hostTimeout,
    resourceTimeout:
      options.resourceTimeout ?? config.resourceTimeout ?? DEFAULT_RESOURCE_POLICY.timeoutMs,
    retries: options.retries ?? config.retries ?? DEFAULT_RESOURCE_POLICY.retries,
    retryDelay: options.retryDelay ?? config.retryDelay ?? DEFAULT_RESOURCE_POLICY.retryDelayMs,
    cache: options.cache ?? config.cache ?? false,
    cacheTtl: options.cacheTtl ?? config.cacheTtl ?? DEFAULT_CACHE_TTL_MS,
    cacheClear: options.cacheClear ?? config.cacheClear ?? false,
    dashboardHost: options.dashboardHost ?? config.dashboardHost ?? "127.0.0.1",
    dashboardPort: options.dashboardPort ?? config.dashboardPort ?? 9090,
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Error thrown when config file values are invalid. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigValidationError"
  }
}

/** Assert a config field has the expected type. */
function assertType(field: string, value: unknown, expected: string): void {
  if (typeof value !== expected) {
    throw new ConfigValidationError(
      `Invalid ${field} in ${CONFIG_FILENAME}. Expected ${expected}, got ${typeof value}.`,
    )
  }
}

/**
 * Validate config file values at load time.
 *
 * Checks top-level shape, field types, enum membership, and numeric
 * constraints. Throws ConfigValidationError with a clear message on
 * the first invalid field.
 */
export function validateConfig(config: IgnitionConfig): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new ConfigValidationError(`${CONFIG_FILENAME} must default-export a plain object.`)
  }

  // String fields
  if (config.inventory !== undefined) assertType("inventory", config.inventory, "string")
  if (config.dashboardHost !== undefined)
    assertType("dashboardHost", config.dashboardHost, "string")
  if (config.logDir !== undefined) assertType("logDir", config.logDir, "string")

  // Boolean fields
  if (config.trace !== undefined) assertType("trace", config.trace, "boolean")
  if (config.multiplex !== undefined) assertType("multiplex", config.multiplex, "boolean")
  if (config.cache !== undefined) assertType("cache", config.cache, "boolean")
  if (config.cacheClear !== undefined) assertType("cacheClear", config.cacheClear, "boolean")

  // Vars must be a plain object
  if (config.vars !== undefined) {
    if (typeof config.vars !== "object" || config.vars === null || Array.isArray(config.vars)) {
      throw new ConfigValidationError(
        `Invalid vars in ${CONFIG_FILENAME}. Expected a plain object.`,
      )
    }
  }

  // Enum fields
  if (config.format !== undefined && !VALID_FORMATS.includes(config.format)) {
    throw new ConfigValidationError(
      `Invalid format "${config.format}" in ${CONFIG_FILENAME}. Must be one of: ${VALID_FORMATS.join(", ")}`,
    )
  }
  if (config.errorMode !== undefined && !VALID_ERROR_MODES.includes(config.errorMode)) {
    throw new ConfigValidationError(
      `Invalid errorMode "${config.errorMode}" in ${CONFIG_FILENAME}. Must be one of: ${VALID_ERROR_MODES.join(", ")}`,
    )
  }
  if (
    config.hostKeyPolicy !== undefined &&
    !VALID_HOST_KEY_POLICIES.includes(config.hostKeyPolicy)
  ) {
    throw new ConfigValidationError(
      `Invalid hostKeyPolicy "${config.hostKeyPolicy}" in ${CONFIG_FILENAME}. Must be one of: ${VALID_HOST_KEY_POLICIES.join(", ")}`,
    )
  }
  if (config.dashboardPort !== undefined) {
    if (
      typeof config.dashboardPort !== "number" ||
      !Number.isInteger(config.dashboardPort) ||
      config.dashboardPort < 1 ||
      config.dashboardPort > 65535
    ) {
      throw new ConfigValidationError(
        `Invalid dashboardPort "${config.dashboardPort}" in ${CONFIG_FILENAME}. Must be an integer between 1 and 65535.`,
      )
    }
  }
  if (config.parallelism !== undefined) {
    if (
      typeof config.parallelism !== "number" ||
      !Number.isInteger(config.parallelism) ||
      config.parallelism < 1
    ) {
      throw new ConfigValidationError(
        `Invalid parallelism "${config.parallelism}" in ${CONFIG_FILENAME}. Must be a positive integer.`,
      )
    }
  }
  if (config.hostTimeout !== undefined) {
    if (
      typeof config.hostTimeout !== "number" ||
      !Number.isInteger(config.hostTimeout) ||
      config.hostTimeout < 0
    ) {
      throw new ConfigValidationError(
        `Invalid hostTimeout "${config.hostTimeout}" in ${CONFIG_FILENAME}. Must be a non-negative integer.`,
      )
    }
  }
  if (config.resourceTimeout !== undefined) {
    if (
      typeof config.resourceTimeout !== "number" ||
      !Number.isInteger(config.resourceTimeout) ||
      config.resourceTimeout < 0
    ) {
      throw new ConfigValidationError(
        `Invalid resourceTimeout "${config.resourceTimeout}" in ${CONFIG_FILENAME}. Must be a non-negative integer.`,
      )
    }
  }
  if (config.retries !== undefined) {
    if (
      typeof config.retries !== "number" ||
      !Number.isInteger(config.retries) ||
      config.retries < 0
    ) {
      throw new ConfigValidationError(
        `Invalid retries "${config.retries}" in ${CONFIG_FILENAME}. Must be a non-negative integer.`,
      )
    }
  }
  if (config.retryDelay !== undefined) {
    if (
      typeof config.retryDelay !== "number" ||
      !Number.isInteger(config.retryDelay) ||
      config.retryDelay < 0
    ) {
      throw new ConfigValidationError(
        `Invalid retryDelay "${config.retryDelay}" in ${CONFIG_FILENAME}. Must be a non-negative integer.`,
      )
    }
  }
  if (config.cacheTtl !== undefined) {
    if (
      typeof config.cacheTtl !== "number" ||
      !Number.isInteger(config.cacheTtl) ||
      config.cacheTtl < 0
    ) {
      throw new ConfigValidationError(
        `Invalid cacheTtl "${config.cacheTtl}" in ${CONFIG_FILENAME}. Must be a non-negative integer.`,
      )
    }
  }
}
