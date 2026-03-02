/**
 * ExecutionContext — one per host per run.
 *
 * Carries the transport connection, run mode, error mode, host metadata,
 * reporter, and accumulated results. Threaded through all resource executions
 * within a single host run. See ISSUE-0004, ADR-0002, ADR-0015.
 */

import type {
  CheckResultCache,
  ErrorMode,
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
export interface ExecutionContextOptions {
  readonly connection: Transport
  readonly mode: RunMode
  readonly errorMode: ErrorMode
  readonly verbose: boolean
  readonly host: HostContext
  readonly reporter: Reporter
  readonly vars?: Record<string, unknown>
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

/**
 * Concrete implementation of the ExecutionContext interface.
 *
 * Immutable: connection, mode, errorMode, host, reporter.
 * Mutable: vars (stacked scoped state — see ISSUE-0035), results (accumulated during run).
 */
export class ExecutionContextImpl implements IExecutionContext {
  readonly connection: Transport
  readonly mode: RunMode
  readonly errorMode: ErrorMode
  readonly verbose: boolean
  readonly host: HostContext
  readonly reporter: Reporter
  readonly cache?: CheckResultCache
  readonly resourcePolicy?: Partial<ResourcePolicy>
  readonly eventBus?: EventBus
  readonly hostCorrelationId?: CorrelationId
  readonly resourceTags?: readonly string[]
  readonly signal?: AbortSignal
  readonly facts?: HostFacts
  readonly redactionPolicy?: RedactionPolicy

  /**
   * Stack of variable scopes. Index 0 is the root scope (from constructor).
   * Each `withVars()` call pushes a new layer; `setVar()` writes to the topmost.
   * See ISSUE-0035.
   */
  private readonly _scopes: Record<string, unknown>[]

  /** Accumulated resource results. */
  readonly results: ResourceResult[] = []

  constructor(opts: ExecutionContextOptions) {
    this.connection = opts.connection
    this.mode = opts.mode
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
   * maintaining backward compatibility with existing recipes. See ISSUE-0035.
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

  /** Set a variable in the current (topmost) scope. See ISSUE-0035. */
  setVar(key: string, value: unknown): void {
    this._scopes[this._scopes.length - 1][key] = value
  }

  /**
   * Execute a function with additional/overridden vars.
   * The override scope is popped when the function completes (including on error).
   * Parent vars are not mutated. See ISSUE-0035.
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
