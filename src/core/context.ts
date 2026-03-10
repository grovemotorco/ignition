/**
 * ExecutionContext — one per host per run.
 *
 * Carries the transport connection, run mode, error mode, host metadata,
 * reporter, and accumulated results. Threaded through all resource executions
 * within a single host run.
 */

import type {
  CheckResultCache,
  ErrorMode,
  ExecutionPhase,
  ExecutionContext as IExecutionContext,
  HostContext,
  HostFacts,
  Reporter,
  ResourcePolicy,
  ResourceResult,
  RunMode,
} from "./types.ts"
import type { Transport } from "../ssh/types.ts"
import type { CorrelationId, EventBus } from "../output/events.ts"
import type { RedactionPolicy } from "./serialize.ts"

/** Options for constructing an ExecutionContext. */
export type ExecutionContextOptions = {
  connection: Transport
  mode: RunMode
  phase?: ExecutionPhase | undefined
  errorMode: ErrorMode
  verbose: boolean
  host: HostContext
  reporter: Reporter
  vars?: Record<string, unknown> | undefined
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

/**
 * Concrete implementation of the ExecutionContext type.
 *
 * Immutable: connection, mode, errorMode, host, reporter.
 * Mutable: vars (stacked scoped state), results (accumulated during run).
 */
export class ExecutionContextImpl implements IExecutionContext {
  connection: Transport
  mode: RunMode
  phase?: ExecutionPhase | undefined
  errorMode: ErrorMode
  verbose: boolean
  host: HostContext
  reporter: Reporter
  cache?: CheckResultCache | undefined
  resourcePolicy?: Partial<ResourcePolicy> | undefined
  eventBus?: EventBus | undefined
  hostCorrelationId?: CorrelationId | undefined
  resourceTags?: string[] | undefined
  signal?: AbortSignal | undefined
  facts?: HostFacts | undefined
  redactionPolicy?: RedactionPolicy | undefined

  /**
   * Stack of variable scopes. Index 0 is the root scope (from constructor).
   * Each `withVars()` call pushes a new layer; `setVar()` writes to the topmost.
   */
  private _scopes: Record<string, unknown>[]

  /** Accumulated resource results. */
  results: ResourceResult[] = []

  constructor(opts: ExecutionContextOptions) {
    this.connection = opts.connection
    this.mode = opts.mode
    this.phase = opts.phase
    this.errorMode = opts.errorMode
    this.verbose = opts.verbose
    this.host = opts.host
    this.reporter = opts.reporter
    this._scopes = [{ ...opts.vars }]
    this.cache = opts.cache
    this.resourcePolicy = opts.resourcePolicy
    this.eventBus = opts.eventBus
    this.hostCorrelationId = opts.hostCorrelationId
    this.resourceTags = opts.resourceTags
    this.signal = opts.signal
    this.facts = opts.facts
    this.redactionPolicy = opts.redactionPolicy
  }

  /**
   * Merged read-only view of all active scopes (latest wins).
   *
   * Returns a Proxy so that `ctx.vars.foo = x` delegates to `setVar()`,
   * maintaining backward compatibility with existing recipes.
   */
  get vars(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => {
        if (typeof prop === "symbol") return undefined
        // Walk scopes top-down to find the first layer that has the key
        for (let i = this._scopes.length - 1; i >= 0; i--) {
          if (prop in this._scopes[i]) {
            return this._scopes[i][prop]
          }
        }
        return undefined
      },
      set: (_target, prop, value) => {
        if (typeof prop === "symbol") return false
        this.setVar(prop, value)
        return true
      },
      has: (_target, prop) => {
        if (typeof prop === "symbol") return false
        for (let i = this._scopes.length - 1; i >= 0; i--) {
          if (prop in this._scopes[i]) return true
        }
        return false
      },
      ownKeys: () => {
        const keys = new Set<string>()
        for (const scope of this._scopes) {
          for (const key of Object.keys(scope)) {
            keys.add(key)
          }
        }
        return [...keys]
      },
      deleteProperty: (_target, prop) => {
        if (typeof prop === "symbol") return false
        delete this._scopes[this._scopes.length - 1][prop]
        return true
      },
      getOwnPropertyDescriptor: (_target, prop) => {
        if (typeof prop === "symbol") return undefined
        for (let i = this._scopes.length - 1; i >= 0; i--) {
          if (prop in this._scopes[i]) {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: this._scopes[i][prop],
            }
          }
        }
        return undefined
      },
    })
  }

  /** Set a variable in the current (topmost) scope. */
  setVar(key: string, value: unknown): void {
    this._scopes[this._scopes.length - 1][key] = value
  }

  /**
   * Execute a function with additional/overridden vars.
   * The override scope is popped when the function completes (including on error).
   * Parent vars are not mutated.
   *
   * Note: concurrent `withVars()` calls on the same context are not supported.
   * The sequential per-host execution model prevents this in practice.
   */
  async withVars<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    this._scopes.push({ ...overrides })
    try {
      return await fn()
    } finally {
      this._scopes.pop()
    }
  }

  /** True if any accumulated result has status "failed". */
  get hasFailed(): boolean {
    return this.results.some((r) => r.status === "failed")
  }
}
