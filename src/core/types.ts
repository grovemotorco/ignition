/**
 * Core type definitions for Ignition.
 *
 * These types form the foundation of the resource lifecycle, execution context,
 * and run orchestration. See ADR-0002 (Resource Lifecycle) and ARCHITECTURE.md.
 */

// ---------------------------------------------------------------------------
// Resource Lifecycle
// ---------------------------------------------------------------------------

/** Status of a resource after execution. */
export type ResourceStatus = "ok" | "changed" | "failed"

/** Run mode: apply mutates, check is read-only (dry-run). */
export type RunMode = "apply" | "check"

/** Error handling strategy for a run. See ADR-0005. */
export type ErrorMode = "fail-fast" | "fail-at-end" | "ignore"

/**
 * Result of a resource's `check()` phase.
 *
 * `inDesiredState` determines whether `apply()` will be called.
 * `current` and `desired` are used for diff output.
 *
 * **Idempotence contract** (ADR-0012, ISSUE-0017):
 * - `current` must reflect observed remote state (read-only query).
 * - `desired` must reflect the target state from the input.
 * - When `inDesiredState === true`, `output` must be populated.
 * - When `inDesiredState === false`, `output` must be absent.
 * - Both `current` and `desired` must be plain JSON-serializable objects.
 */
export interface CheckResult<TOutput> {
  inDesiredState: boolean
  current: Record<string, unknown>
  desired: Record<string, unknown>
  /** Populated when already in desired state (no apply needed). */
  output?: TOutput
}

/**
 * The contract for a resource type. Every built-in and user resource
 * implements this interface. See ADR-0002, ADR-0012.
 *
 * **Idempotence contract** (ADR-0012, ISSUE-0017):
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
 * the contract permits "always-run" semantics where convergence is managed
 * by the recipe author rather than the resource itself.
 *
 * Note: `ExecutionContext` is referenced here as a type parameter name only;
 * the full interface lives in `context.ts` (ISSUE-0004).
 */
export interface ResourceDefinition<TInput, TOutput> {
  /** Resource type identifier (e.g. "apt", "file", "exec"). Must be unique and lowercase. */
  readonly type: string
  /** Human-readable name for output (e.g. "/etc/nginx/nginx.conf"). Must be pure (no I/O). */
  formatName(input: TInput): string
  /** Read-only check: compare current vs desired state. Must be side-effect free. */
  check(ctx: ExecutionContext, input: TInput): Promise<CheckResult<TOutput>>
  /** Mutating apply: converge to desired state. Must be idempotent (convergent). */
  apply(ctx: ExecutionContext, input: TInput): Promise<TOutput>
  /** Machine-readable schema with steering metadata for agent discoverability. See ISSUE-0028. */
  readonly schema?: ResourceSchema
}

// ---------------------------------------------------------------------------
// Resource Schema (ISSUE-0028)
// ---------------------------------------------------------------------------

/** JSON Schema object. Plain JSON, manually authored per resource. */
export type JSONSchema = Record<string, unknown>

/**
 * A concrete usage example for a resource. Guides agents toward correct
 * first-attempt usage by pairing structural input with natural language.
 */
export interface ResourceExample {
  /** Short title for the example. */
  readonly title: string
  /** Description of what the example achieves. */
  readonly description: string
  /** Example input object. */
  readonly input: Record<string, unknown>
  /** Natural language request that would produce this input. */
  readonly naturalLanguage?: string
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
export interface ResourceAnnotations {
  /** check() is always read-only. */
  readonly readOnly: boolean
  /** Can apply() destroy or remove state for some inputs? */
  readonly destructive: boolean
  /** Safe to re-run with identical inputs and get same result? */
  readonly idempotent: boolean
}

/**
 * Machine-readable resource schema with steering metadata for agent
 * discoverability. Wraps structural JSON Schema in behavioral guidance
 * designed to steer LLM usage toward correct first-attempt results.
 *
 * See ISSUE-0028, ADR-0019.
 */
export interface ResourceSchema {
  /** One-line purpose statement. */
  readonly description: string
  /** "USE THIS RESOURCE WHEN" — trigger scenarios for agents. */
  readonly whenToUse: readonly string[]
  /** Anti-patterns with pointers to alternatives. */
  readonly doNotUseFor?: readonly string[]
  /** Natural language phrases that should trigger this resource. */
  readonly triggerPatterns: readonly string[]
  /** Critical behavioral guidance (parameter gotchas, ordering, etc.). */
  readonly hints: readonly string[]
  /** Structural JSON Schema for resource input. */
  readonly input: JSONSchema
  /** Structural JSON Schema for resource output. */
  readonly output: JSONSchema
  /** Concrete usage examples. */
  readonly examples: readonly ResourceExample[]
  /** Resource execution model: declarative (convergent) or imperative (always-run). */
  readonly nature: "declarative" | "imperative"
  /** MCP-style safety annotations. */
  readonly annotations: ResourceAnnotations
  /** Transport capabilities required by this resource. */
  readonly requiredCapabilities: readonly TransportCapability[]
}

/**
 * Result of executing a single resource through the check-then-apply lifecycle.
 */
export interface ResourceResult<TOutput = unknown> {
  /** Resource type (e.g. "apt", "file"). */
  type: string
  /** Human-readable resource name. */
  name: string
  /** Outcome: ok (no change), changed (applied), or failed. */
  status: ResourceStatus
  /** Current state from check(). */
  current?: Record<string, unknown>
  /** Desired state from check(). */
  desired?: Record<string, unknown>
  /** Output value from apply() or check() when already in desired state. */
  output?: TOutput
  /** Error if status is "failed". */
  error?: Error
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Attempt history when retries occurred. Only present when attempts > 1. */
  attempts?: AttemptRecord[]
  /** Whether this result was served from cache (check mode only). See ISSUE-0018. */
  cacheHit?: boolean
  /** Age of the cached entry in milliseconds, when cacheHit is true. */
  cacheAgeMs?: number
  /** Per-invocation metadata passed by the caller. See ISSUE-0031. */
  meta?: ResourceCallMeta
}

/**
 * Standardized diff shape extracted from a CheckResult.
 *
 * Provides a uniform view of what changed (or would change) across all
 * resource types. Used by reporters and conformance tests. See ISSUE-0017.
 */
export interface ResourceDiff {
  /** Resource type identifier. */
  readonly type: string
  /** Human-readable resource name. */
  readonly name: string
  /** Whether the resource is already in desired state. */
  readonly inDesiredState: boolean
  /** Observed remote state from check(). */
  readonly current: Record<string, unknown>
  /** Target state from input. */
  readonly desired: Record<string, unknown>
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
// Host Facts (ISSUE-0032)
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
 * See ISSUE-0032.
 */
export interface HostFacts {
  /** OS family from /etc/os-release ID_LIKE or ID. */
  readonly distro: DistroFamily
  /** Specific distro ID (e.g. 'ubuntu', 'rocky', 'alpine'). */
  readonly distroId: string
  /** Version string from /etc/os-release VERSION_ID. */
  readonly distroVersion: string
  /** Available package manager binary, or null if undetected. */
  readonly pkgManager: PackageManager
  /** Init system, or null if undetected. */
  readonly initSystem: InitSystem
  /** CPU architecture from uname -m. */
  readonly arch: string
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
export interface HostContext {
  /** Logical host name from inventory (e.g. "web-1"). */
  readonly name: string
  /** SSH hostname or IP address. */
  readonly hostname: string
  /** SSH user. */
  readonly user: string
  /** SSH port. */
  readonly port: number
  /** Merged variables (inventory defaults → group vars → host vars → CLI overrides). */
  readonly vars: Record<string, unknown>
}

/** Variables passed into TypeScript template functions. */
export type TemplateContext = Record<string, unknown>

// ---------------------------------------------------------------------------
// Resource Call Metadata (ISSUE-0031)
// ---------------------------------------------------------------------------

/**
 * Per-invocation metadata for resource calls.
 *
 * Separates executor/runner concerns (tags, notifications, redaction) from
 * domain-specific resource inputs. Consumed by the executor and reporter,
 * invisible to resource check()/apply() implementations.
 *
 * See ISSUE-0031 for design rationale.
 */
export interface ResourceCallMeta {
  /** Resource-level tags for selective execution (--resource-tags). */
  readonly tags?: readonly string[]
  /** Handler names to notify on change. */
  readonly notify?: readonly string[]
  /** Stable identifier for this call (separate from formatName). */
  readonly id?: string
  /** Fields in input that contain sensitive values (redaction hints). */
  readonly sensitivePaths?: readonly string[]
}

// ---------------------------------------------------------------------------
// Resource Execution Policy
// ---------------------------------------------------------------------------

/**
 * Policy controlling timeout and retry behavior for resource execution.
 * Applies to both `check()` and `apply()` phases. See ADR-0011, ISSUE-0016.
 *
 * Override hierarchy: per-resource input > RunOptions global > DEFAULT_RESOURCE_POLICY.
 */
export interface ResourcePolicy {
  /** Per-phase timeout in milliseconds. 0 means no timeout. Default: 30000. */
  readonly timeoutMs: number
  /** Maximum number of retry attempts (0 = no retries). Default: 2. */
  readonly retries: number
  /** Initial backoff delay in milliseconds for exponential backoff. Default: 1000. */
  readonly retryDelayMs: number
  /**
   * Run check() again after apply() to verify convergence.
   * When true, status is 'changed' only if post-check confirms state changed.
   * When false (default), status is 'changed' whenever apply() runs.
   * See ISSUE-0036.
   */
  readonly postCheck?: boolean
}

/** Default resource execution policy. */
export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = {
  timeoutMs: 30_000,
  retries: 2,
  retryDelayMs: 1_000,
}

/**
 * Record of a single execution attempt (check or apply phase).
 * Captured for observability when retries occur. See ADR-0011.
 */
export interface AttemptRecord {
  /** 1-based attempt number. */
  readonly attempt: number
  /** Which phase this attempt was for. */
  readonly phase: "check" | "apply" | "post-check"
  /** Error that caused this attempt to fail (absent on success). */
  readonly error?: Error
  /** Wall-clock duration of this attempt in milliseconds. */
  readonly durationMs: number
}

// ---------------------------------------------------------------------------
// Run Orchestration
// ---------------------------------------------------------------------------

/** Concurrency options for multi-host runs. See ADR-0010. */
export interface ConcurrencyOptions {
  /** Maximum number of hosts to run concurrently. Must be >= 1. Default: 5. */
  readonly parallelism: number
  /** Per-host timeout in milliseconds. 0 means no timeout. Default: 0. */
  readonly hostTimeout: number
}

/** Default concurrency options. */
export const DEFAULT_CONCURRENCY: Readonly<ConcurrencyOptions> = {
  parallelism: 5,
  hostTimeout: 0,
}

/** Options that govern a single provisioning run. */
export interface RunOptions {
  /** Path to the recipe file. */
  recipe: string
  /** Target specifier(s) — host name, @group, or ad-hoc. */
  targets: string[]
  /** Inventory file path. */
  inventory?: string
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
  tags?: string[]
  /** Prompt before applying. */
  confirm: boolean
  /** SSH host key checking policy. See ADR-0009. */
  hostKeyPolicy: HostKeyPolicy
  /** Enable SSH multiplexing (ControlMaster). */
  multiplex: boolean
  /** Concurrency options for multi-host runs. See ADR-0010. */
  concurrency?: ConcurrencyOptions
  /** Global resource execution policy (timeout/retry). See ADR-0011. */
  resourcePolicy?: Partial<ResourcePolicy>
}

/** Summary of a completed run for a single host. */
export interface HostRunSummary {
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
  cancelled?: boolean
}

/** Summary of a complete provisioning run across all hosts. */
export interface RunSummary {
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
  recipe?: {
    /** File path or URL of the recipe. */
    path: string
    /** SHA-256 hex digest of the recipe file content. */
    checksum: string
  }
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
// Forward-declared interfaces (implemented in other modules)
// ---------------------------------------------------------------------------

import type { HostKeyPolicy, Transport, TransportCapability } from "../ssh/types.ts"
import type { CorrelationId, EventBus } from "../output/events.ts"
import type { RedactionPolicy } from "./serialize.ts"

/**
 * Reporter interface. Full definition in `src/output/reporter.ts` (ISSUE-0011).
 * Forward-declared here so ExecutionContext can reference it.
 */
export interface Reporter {
  resourceStart(type: string, name: string): void
  resourceEnd(result: ResourceResult): void
  hostStart?(host: string, hostname: string): void
  hostEnd?(summary: HostRunSummary): void
  checkBanner?(): void
  resourceOutput?(type: string, name: string, stream: "stdout" | "stderr", chunk: string): void
}

/**
 * Execution context — one per host per run. Full implementation in
 * `src/core/context.ts` (ISSUE-0004). Declared here as an interface so
 * ResourceDefinition and other types can reference it without circular deps.
 *
 * The `connection` property carries the transport for the current host.
 * Resources access it to execute commands, transfer files, etc.
 * See ADR-0015 for the capability-driven transport abstraction.
 */
export interface ExecutionContext {
  readonly connection: Transport
  readonly mode: RunMode
  readonly errorMode: ErrorMode
  readonly verbose: boolean
  readonly host: HostContext
  readonly results: ResourceResult[]
  readonly vars: Record<string, unknown>
  readonly reporter: Reporter
  readonly hasFailed: boolean

  /**
   * Execute a function with additional/overridden vars.
   * The override scope is popped when the function completes (including on error).
   * Parent vars are not mutated. See ISSUE-0035.
   */
  withVars<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T>

  /**
   * Set a variable in the current scope.
   * Recipes that need to pass data downstream still work. See ISSUE-0035.
   */
  setVar(key: string, value: unknown): void
  /** Optional check result cache. See ISSUE-0018. */
  readonly cache?: CheckResultCache
  /** Optional resource policy defaults for executeResource(). */
  readonly resourcePolicy?: Partial<ResourcePolicy>
  /** Optional event bus for lifecycle telemetry. See ISSUE-0029, ADR-0016. */
  readonly eventBus?: EventBus
  /** Host correlation ID for event telemetry. See ISSUE-0029. */
  readonly hostCorrelationId?: CorrelationId
  /** Active resource-tag filter. See ISSUE-0031. */
  readonly resourceTags?: readonly string[]
  /** AbortSignal for cooperative cancellation. See ISSUE-0030. */
  readonly signal?: AbortSignal
  /** Platform facts gathered after connectivity is verified. See ISSUE-0032. */
  readonly facts?: HostFacts
  /** Optional redaction policy for sensitive data. See ISSUE-0033. */
  readonly redactionPolicy?: RedactionPolicy
}

// ---------------------------------------------------------------------------
// Check Result Cache (ISSUE-0018, ADR-0013)
// ---------------------------------------------------------------------------

/** Cache lookup result. */
export interface CacheLookup {
  /** Whether the cache had a valid (non-expired) entry. */
  readonly hit: boolean
  /** The cached result, if hit. */
  readonly result?: CheckResult<unknown>
  /** Age of the cached entry in milliseconds, if hit. */
  readonly ageMs?: number
}

/**
 * Interface for check result caches. Non-authoritative, TTL-based.
 *
 * Used in check mode only to reduce repeated SSH work on stable hosts.
 * Apply mode always performs a live check. See ADR-0013.
 */
export interface CheckResultCache {
  /** Look up a cached check result. Returns miss if expired or absent. */
  get(key: string): CacheLookup
  /** Store a check result. */
  set(key: string, result: CheckResult<unknown>): void
  /** Remove all entries from the cache. */
  clear(): void
  /** Number of valid (non-expired) entries. */
  readonly size: number
}
