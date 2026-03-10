/**
 * Core type definitions for Ignition.
 *
 * These types form the foundation of the resource lifecycle, execution context,
 * and run orchestration.
 */

// ---------------------------------------------------------------------------
// Resource Lifecycle
// ---------------------------------------------------------------------------

/** Status of a resource after execution. */
export type ResourceStatus = "ok" | "changed" | "failed"

/** Run mode: apply mutates, check is read-only (dry-run). */
export type RunMode = "apply" | "check"

/** Error handling strategy for a run. */
export type ErrorMode = "fail-fast" | "fail-at-end" | "ignore"

/** Executor phase within a single resource lifecycle. */
export type ExecutionPhase = "check" | "apply" | "post-check"

/**
 * Result of a resource's `check()` phase.
 *
 * `check()` must be safe to run during `ignition run --check`.
 *
 * `inDesiredState` determines whether `apply()` will be called.
 * `current` and `desired` are used for diff output.
 *
 * **Idempotence contract:**
 * - `current` must reflect observed remote state (read-only query).
 * - `desired` must reflect the target state from the input.
 * - When `inDesiredState === true`, `output` must be populated.
 * - When `inDesiredState === false`, `output` must be absent.
 * - Both `current` and `desired` must be plain JSON-serializable objects.
 */
export type CheckResult<TOutput> = {
  inDesiredState: boolean
  current: Record<string, unknown>
  desired: Record<string, unknown>
  /** Populated when already in desired state (no apply needed). */
  output?: TOutput
}

/**
 * The contract for a resource type. Every built-in and user resource
 * implements this type.
 *
 * **Idempotence contract:**
 *
 * 1. `check()` is **side-effect free** — read-only queries only, no mutations.
 * 2. `check()` returns `inDesiredState: true` when the remote already matches
 *    the input, causing `apply()` to be skipped by the executor.
 * 3. `apply()` is **convergent** — calling it when not in desired state moves
 *    the remote to desired state. A subsequent `check()` must then return
 *    `inDesiredState: true` (idempotent round-trip).
 * 4. `formatName()` is a **pure function** — no I/O, no side effects.
 * 5. `type` is a **unique, lowercase identifier** for the resource kind.
 *
 * Resources that are inherently imperative (e.g. `exec`, `service.restarted`)
 * may always return `inDesiredState: false` from `check()`. This is valid —
 * the contract permits conservative "always-run" semantics when a resource
 * cannot prove safety or desired state from read-only checks alone.
 */
export type ResourceDefinition<TInput, TOutput> = {
  /** Resource type identifier (e.g. "apt", "file", "exec"). Must be unique and lowercase. */
  type: string
  /** Human-readable name for output (e.g. "/etc/nginx/nginx.conf"). Must be pure (no I/O). */
  formatName(input: TInput): string
  /** Read-only check: compare current vs desired state. Must be side-effect free. */
  check(ctx: ExecutionContext, input: TInput): Promise<CheckResult<TOutput>>
  /** Mutating apply: converge to desired state. Must be idempotent (convergent). */
  apply(ctx: ExecutionContext, input: TInput): Promise<TOutput>
  /** Machine-readable schema with steering metadata for agent discoverability. */
  schema?: ResourceSchema | undefined
}

// ---------------------------------------------------------------------------
// Resource Schema
// ---------------------------------------------------------------------------

/** JSON Schema object. Plain JSON, manually authored per resource. */
export type JSONSchema = Record<string, unknown>

/**
 * A concrete usage example for a resource. Guides agents toward correct
 * first-attempt usage by pairing structural input with natural language.
 */
export type ResourceExample = {
  /** Short title for the example. */
  title: string
  /** Description of what the example achieves. */
  description: string
  /** Example input object. */
  input: Record<string, unknown>
  /** Natural language request that would produce this input. */
  naturalLanguage?: string | undefined
}

/**
 * MCP-style safety annotations for a resource.
 *
 * Describes the resource's worst-case behavior across all input combinations.
 * Individual inputs may be safer (e.g. `apt` with `state:'present'` is
 * non-destructive, but `state:'absent'` removes packages). The `hints` array
 * in ResourceSchema should call out input-dependent destructiveness so agents
 * can reason per-invocation.
 */
export type ResourceAnnotations = {
  /** check() is always read-only. */
  readOnly: boolean
  /** Can apply() destroy or remove state for some inputs? */
  destructive: boolean
  /** Safe to re-run with identical inputs and get same result? */
  idempotent: boolean
}

/**
 * Machine-readable resource schema with steering metadata for agent
 * discoverability. Wraps structural JSON Schema in behavioral guidance
 * designed to steer LLM usage toward correct first-attempt results.
 */
export type ResourceSchema = {
  /** One-line purpose statement. */
  description: string
  /** "USE THIS RESOURCE WHEN" — trigger scenarios for agents. */
  whenToUse: string[]
  /** Anti-patterns with pointers to alternatives. */
  doNotUseFor?: string[] | undefined
  /** Natural language phrases that should trigger this resource. */
  triggerPatterns: string[]
  /** Critical behavioral guidance (parameter gotchas, ordering, etc.). */
  hints: string[]
  /** Structural JSON Schema for resource input. */
  input: JSONSchema
  /** Structural JSON Schema for resource output. */
  output: JSONSchema
  /** Concrete usage examples. */
  examples: ResourceExample[]
  /** Resource execution model: declarative (convergent) or imperative (always-run). */
  nature: "declarative" | "imperative"
  /** MCP-style safety annotations. */
  annotations: ResourceAnnotations
  /** Transport capabilities required by this resource. */
  requiredCapabilities: TransportCapability[]
}

/**
 * Result of executing a single resource through the check-then-apply lifecycle.
 */
export type ResourceResult<TOutput = unknown> = {
  /** Resource type (e.g. "apt", "file"). */
  type: string
  /** Human-readable resource name. */
  name: string
  /** Outcome: ok (no change), changed (applied), or failed. */
  status: ResourceStatus
  /** Current state from check(). */
  current?: Record<string, unknown> | undefined
  /** Desired state from check(). */
  desired?: Record<string, unknown> | undefined
  /** Output value from apply() or check() when already in desired state. */
  output?: TOutput | undefined
  /** Error if status is "failed". */
  error?: Error | undefined
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Attempt history when retries occurred. Only present when attempts > 1. */
  attempts?: AttemptRecord[] | undefined
  /** Whether this result was served from cache (check mode only). */
  cacheHit?: boolean | undefined
  /** Age of the cached entry in milliseconds, when cacheHit is true. */
  cacheAgeMs?: number | undefined
  /** Per-invocation metadata passed by the caller. */
  meta?: ResourceCallMeta | undefined
}

/**
 * Standardized diff shape extracted from a CheckResult.
 *
 * Provides a uniform view of what changed (or would change) across all
 * resource types. Used by reporters and conformance tests.
 */
export type ResourceDiff = {
  /** Resource type identifier. */
  type: string
  /** Human-readable resource name. */
  name: string
  /** Whether the resource is already in desired state. */
  inDesiredState: boolean
  /** Observed remote state from check(). */
  current: Record<string, unknown>
  /** Target state from input. */
  desired: Record<string, unknown>
}

/**
 * Extract a standardized ResourceDiff from a ResourceDefinition + CheckResult.
 */
export function toResourceDiff<TInput, TOutput>(
  def: ResourceDefinition<TInput, TOutput>,
  input: TInput,
  check: CheckResult<TOutput>,
): ResourceDiff {
  return {
    type: def.type,
    name: def.formatName(input),
    inDesiredState: check.inDesiredState,
    current: check.current,
    desired: check.desired,
  }
}

// ---------------------------------------------------------------------------
// Host Facts
// ---------------------------------------------------------------------------

/** OS family derived from /etc/os-release ID_LIKE or ID. */
export type DistroFamily = "debian" | "rhel" | "alpine" | "unknown"

/** Detected package manager binary. */
export type PackageManager = "apt" | "dnf" | "yum" | "apk" | null

/** Detected init system. */
export type InitSystem = "systemd" | "openrc" | null

/**
 * Platform facts gathered from a remote host after connectivity is verified.
 *
 * Probed once per host per run and cached on ExecutionContext. Resources
 * access these facts instead of re-implementing OS detection ad-hoc.
 */
export type HostFacts = {
  /** OS family from /etc/os-release ID_LIKE or ID. */
  distro: DistroFamily
  /** Specific distro ID (e.g. 'ubuntu', 'rocky', 'alpine'). */
  distroId: string
  /** Version string from /etc/os-release VERSION_ID. */
  distroVersion: string
  /** Available package manager binary, or null if undetected. */
  pkgManager: PackageManager
  /** Init system, or null if undetected. */
  initSystem: InitSystem
  /** CPU architecture from uname -m. */
  arch: string
}

/** Default facts used when probe fails or is unavailable. */
export const UNKNOWN_HOST_FACTS: Readonly<HostFacts> = {
  distro: "unknown",
  distroId: "",
  distroVersion: "",
  pkgManager: null,
  initSystem: null,
  arch: "",
}

// ---------------------------------------------------------------------------
// Host & Vars
// ---------------------------------------------------------------------------

/** Metadata about the target host, available inside recipes. */
export type HostContext = {
  /** Logical host name from inventory (e.g. "web-1"). */
  name: string
  /** SSH hostname or IP address. */
  hostname: string
  /** SSH user. */
  user: string
  /** SSH port. */
  port: number
  /** Merged variables (inventory defaults → group vars → host vars → CLI overrides). */
  vars: Record<string, unknown>
}

/** Variables passed into TypeScript template functions. */
export type TemplateContext = Record<string, unknown>

// ---------------------------------------------------------------------------
// Resource Call Metadata
// ---------------------------------------------------------------------------

/**
 * Per-invocation metadata for resource calls.
 *
 * Separates executor/runner concerns (tags, notifications, redaction) from
 * domain-specific resource inputs. Consumed by the executor and reporter,
 * invisible to resource check()/apply() implementations.
 */
export type ResourceCallMeta = {
  /** Resource-level tags for selective execution (--resource-tags). */
  tags?: string[] | undefined
  /** Handler names to notify on change. */
  notify?: string[] | undefined
  /** Stable identifier for this call (separate from formatName). */
  id?: string | undefined
  /** Fields in input that contain sensitive values (redaction hints). */
  sensitivePaths?: string[] | undefined
}

// ---------------------------------------------------------------------------
// Resource Execution Policy
// ---------------------------------------------------------------------------

/**
 * Policy controlling timeout and retry behavior for resource execution.
 * Applies to both `check()` and `apply()` phases.
 *
 * Override hierarchy: per-resource input > RunOptions global > DEFAULT_RESOURCE_POLICY.
 */
export type ResourcePolicy = {
  /** Per-phase timeout in milliseconds. 0 means no timeout. Default: 30000. */
  timeoutMs: number
  /** Maximum number of retry attempts (0 = no retries). Default: 2. */
  retries: number
  /** Initial backoff delay in milliseconds for exponential backoff. Default: 1000. */
  retryDelayMs: number
  /**
   * Run check() again after apply() to verify convergence.
   * When true, status is 'changed' only if post-check confirms state changed.
   * When false (default), status is 'changed' whenever apply() runs.
   */
  postCheck?: boolean | undefined
}

/** Default resource execution policy. */
export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = {
  timeoutMs: 30_000,
  retries: 2,
  retryDelayMs: 1_000,
}

/**
 * Record of a single execution attempt (check or apply phase).
 * Captured for observability when retries occur.
 */
export type AttemptRecord = {
  /** 1-based attempt number. */
  attempt: number
  /** Which phase this attempt was for. */
  phase: ExecutionPhase
  /** Error that caused this attempt to fail (absent on success). */
  error?: Error | undefined
  /** Wall-clock duration of this attempt in milliseconds. */
  durationMs: number
}

// ---------------------------------------------------------------------------
// Run Orchestration
// ---------------------------------------------------------------------------

/** Concurrency options for multi-host runs. */
export type ConcurrencyOptions = {
  /** Maximum number of hosts to run concurrently. Must be >= 1. Default: 5. */
  parallelism: number
  /** Per-host timeout in milliseconds. 0 means no timeout. Default: 0. */
  hostTimeout: number
}

/** Default concurrency options. */
export const DEFAULT_CONCURRENCY: Readonly<ConcurrencyOptions> = {
  parallelism: 5,
  hostTimeout: 0,
}

/** Options that govern a single provisioning run. */
export type RunOptions = {
  /** Path to the recipe file. */
  recipe: string
  /** Target specifier(s) — host name, @group, or ad-hoc. */
  targets: string[]
  /** Inventory file path. */
  inventory?: string | undefined
  /** Run mode. */
  mode: RunMode
  /** Error handling strategy. */
  errorMode: ErrorMode
  /** Verbose output. */
  verbose: boolean
  /** Output format. */
  format: "pretty" | "json" | "minimal"
  /** CLI variable overrides (key=value). */
  vars: Record<string, unknown>
  /** Optional recipe tag filter (intersection with recipe meta tags). */
  tags?: string[] | undefined
  /** Prompt before applying. */
  confirm: boolean
  /** SSH host key checking policy. */
  hostKeyPolicy: HostKeyPolicy
  /** Enable SSH multiplexing (ControlMaster). */
  multiplex: boolean
  /** Concurrency options for multi-host runs. */
  concurrency?: ConcurrencyOptions | undefined
  /** Global resource execution policy (timeout/retry). */
  resourcePolicy?: Partial<ResourcePolicy> | undefined
}

/** Summary of a completed run for a single host. */
export type HostRunSummary = {
  /** Host that was targeted. */
  host: HostContext
  /** All resource results in execution order. */
  results: ResourceResult[]
  /** Count of ok resources. */
  ok: number
  /** Count of changed resources. */
  changed: number
  /** Count of failed resources. */
  failed: number
  /** Total wall-clock duration in milliseconds. */
  durationMs: number
  /** Whether this host was cancelled (fail-fast sibling failure or timeout). */
  cancelled?: boolean | undefined
}

/** Summary of a complete provisioning run across all hosts. */
export type RunSummary = {
  /** Per-host summaries. */
  hosts: HostRunSummary[]
  /** Whether any host had failures. */
  hasFailures: boolean
  /** Total wall-clock duration in milliseconds. */
  durationMs: number
  /** Run mode used (apply or check). */
  mode: RunMode
  /** ISO-8601 timestamp when the run started. */
  timestamp: string
  /** Recipe audit info. Absent for inline recipe functions. */
  recipe?:
    | {
        /** File path or URL of the recipe. */
        path: string
        /** SHA-256 hex digest of the recipe file content. */
        checksum: string
      }
    | undefined
}

// ---------------------------------------------------------------------------
// Re-exported transport types (canonical definitions in src/ssh/types.ts)
// ---------------------------------------------------------------------------

export type {
  ExecOptions,
  ExecResult,
  HostKeyPolicy,
  SSHConnection,
  SSHConnectionConfig,
  Transport,
  TransportCapability,
} from "../ssh/types.ts"
export { ALL_TRANSPORT_CAPABILITIES, hasCapability } from "../ssh/types.ts"

// ---------------------------------------------------------------------------
// Forward-declared types (implemented in other modules)
// ---------------------------------------------------------------------------

import type { HostKeyPolicy, Transport, TransportCapability } from "../ssh/types.ts"
import type { CorrelationId, EventBus } from "../output/events.ts"
import type { RedactionPolicy } from "./serialize.ts"

/**
 * Reporter type. Full definition in `src/output/reporter.ts`.
 * Forward-declared here so ExecutionContext can reference it.
 */
export type Reporter = {
  resourceStart(type: string, name: string): void
  resourceEnd(result: ResourceResult): void
  hostStart?(host: string, hostname: string): void
  hostEnd?(summary: HostRunSummary): void
  checkBanner?(): void
  resourceOutput?(type: string, name: string, stream: "stdout" | "stderr", chunk: string): void
}

/**
 * Execution context — one per host per run. Full implementation in
 * `src/core/context.ts`. Declared here as a type so ResourceDefinition
 * and other types can reference it without circular deps.
 *
 * The `connection` property carries the transport for the current host.
 * Resources access it to execute commands, transfer files, etc.
 */
export type ExecutionContext = {
  connection: Transport
  mode: RunMode
  /** Internal lifecycle phase used by the executor. */
  phase?: ExecutionPhase | undefined
  errorMode: ErrorMode
  verbose: boolean
  host: HostContext
  results: ResourceResult[]
  vars: Record<string, unknown>
  reporter: Reporter
  hasFailed: boolean

  /**
   * Execute a function with additional/overridden vars.
   * The override scope is popped when the function completes (including on error).
   * Parent vars are not mutated.
   */
  withVars<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T>

  /**
   * Set a variable in the current scope.
   * Recipes that need to pass data downstream still work.
   */
  setVar(key: string, value: unknown): void
  /** Optional check result cache. */
  cache?: CheckResultCache | undefined
  /** Optional resource policy defaults for executeResource(). */
  resourcePolicy?: Partial<ResourcePolicy> | undefined
  /** Optional event bus for lifecycle telemetry. */
  eventBus?: EventBus | undefined
  /** Host correlation ID for event telemetry. */
  hostCorrelationId?: CorrelationId | undefined
  /** Active resource-tag filter. */
  resourceTags?: string[] | undefined
  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal | undefined
  /** Platform facts gathered after connectivity is verified. */
  facts?: HostFacts | undefined
  /** Optional redaction policy for sensitive data. */
  redactionPolicy?: RedactionPolicy | undefined
}

// ---------------------------------------------------------------------------
// Check Result Cache
// ---------------------------------------------------------------------------

/** Cache lookup result. */
export type CacheLookup = {
  /** Whether the cache had a valid (non-expired) entry. */
  hit: boolean
  /** The cached result, if hit. */
  result?: CheckResult<unknown> | undefined
  /** Age of the cached entry in milliseconds, if hit. */
  ageMs?: number | undefined
}

/**
 * Type for check result caches. Non-authoritative, TTL-based.
 *
 * Used in check mode only to reduce repeated SSH work on stable hosts.
 * Apply mode always performs a live check.
 */
export type CheckResultCache = {
  /** Look up a cached check result. Returns miss if expired or absent. */
  get(key: string): CacheLookup
  /** Store a check result. */
  set(key: string, result: CheckResult<unknown>): void
  /** Remove all entries from the cache. */
  clear(): void
  /** Number of valid (non-expired) entries. */
  size: number
}
