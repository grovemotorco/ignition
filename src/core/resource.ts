/**
 * Resource lifecycle engine — executeResource().
 *
 * Drives the check-then-apply lifecycle for all resources with policy-driven
 * timeout and retry support. Enforces the idempotence contract.
 *
 * Supports an optional non-authoritative check result cache. Cache is
 * advisory for check mode only — apply mode always performs a live check.
 *
 * **Idempotence contract enforcement**:
 * - check() is called first (read-only, side-effect free).
 * - If inDesiredState === true, apply() is skipped → status "ok".
 * - If inDesiredState === false and mode is "apply", apply() is called → status "changed".
 * - A convergent resource: after apply(), a subsequent check() returns inDesiredState: true.
 */

import type {
  AttemptRecord,
  CheckResult,
  ExecOptions,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourcePolicy,
  ResourceResult,
  Transport,
  TransportCapability,
} from "./types.ts"
import { DEFAULT_RESOURCE_POLICY } from "./types.ts"
import { CapabilityError, isRetryable, ResourceError } from "./errors.ts"
import { buildCacheKey } from "./cache.ts"
import { stableStringify } from "./serialize.ts"

/**
 * Assert that the transport on `ctx` supports the given capability.
 *
 * Throws a typed `CapabilityError` if the capability is not available.
 * Resources should call this before performing operations that depend
 * on optional transport capabilities (e.g. 'transfer', 'fetch').
 *
 */
export function requireCapability(
  ctx: ExecutionContext,
  capability: TransportCapability,
  resourceType: string,
): void {
  if (!ctx.connection.capabilities().has(capability)) {
    throw new CapabilityError(capability, resourceType)
  }
}

/**
 * Run a phase function with signal-aware timeout. Creates a derived
 * AbortController that fires on timeout OR when the parent signal fires.
 * The derived signal is passed to `fn` so the transport can kill the
 * subprocess immediately on abort. Races the fn result with an abort
 * rejection so stuck operations are interrupted.
 */
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  // Already aborted — reject immediately
  if (parentSignal?.aborted) {
    return Promise.reject(new Error("Resource aborted"))
  }

  // No timeout and no parent signal — run with a never-aborting signal
  if (timeoutMs <= 0 && !parentSignal) {
    return fn(new AbortController().signal)
  }

  const controller = new AbortController()

  // Race fn against abort signal — this ensures stuck operations reject
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const reason = controller.signal.reason
      reject(reason instanceof Error ? reason : new Error(String(reason ?? "Resource aborted")))
    }
    if (controller.signal.aborted) {
      onAbort()
      return
    }
    controller.signal.addEventListener("abort", onAbort, { once: true })
  })

  // Fire on timeout
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error(`Resource timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )
      : undefined

  // Forward parent abort
  const onParentAbort = parentSignal
    ? () => controller.abort(new Error("Resource aborted"))
    : undefined
  if (onParentAbort) {
    parentSignal!.addEventListener("abort", onParentAbort, { once: true })
  }

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    if (onParentAbort) parentSignal!.removeEventListener("abort", onParentAbort)
  }

  return Promise.race([fn(controller.signal), abortPromise]).then(
    (value) => {
      cleanup()
      return value
    },
    (err) => {
      cleanup()
      throw err
    },
  )
}

/**
 * Compute exponential backoff with jitter.
 *
 * delay = baseDelay * 2^(attempt-1) + random jitter (0..baseDelay/2)
 */
function backoffDelay(baseDelay: number, attempt: number): number {
  const exponential = baseDelay * Math.pow(2, attempt - 1)
  const jitter = Math.random() * (baseDelay / 2)
  return exponential + jitter
}

/** Resolve effective policy from per-resource override and global default. */
export function resolvePolicy(override?: Partial<ResourcePolicy>): ResourcePolicy {
  if (!override) return DEFAULT_RESOURCE_POLICY
  return {
    timeoutMs: override.timeoutMs ?? DEFAULT_RESOURCE_POLICY.timeoutMs,
    retries: override.retries ?? DEFAULT_RESOURCE_POLICY.retries,
    retryDelayMs: override.retryDelayMs ?? DEFAULT_RESOURCE_POLICY.retryDelayMs,
    postCheck: override.postCheck ?? DEFAULT_RESOURCE_POLICY.postCheck,
  }
}

/**
 * Wrap a transport to merge default ExecOptions into every exec() call.
 *
 * Returns a new Transport that delegates all methods to the original,
 * merging `defaults` into the opts argument of `exec()`. Caller-provided
 * opts take precedence over defaults.
 */
export function wrapTransport(
  transport: Transport,
  defaults: Partial<ExecOptions>,
  defaultSignal?: AbortSignal,
): Transport {
  return {
    config: transport.config,
    capabilities: () => transport.capabilities(),
    exec: (command: string, opts?: ExecOptions) =>
      transport.exec(command, { ...defaults, ...opts }),
    transfer: (l: string, r: string, signal?: AbortSignal) =>
      transport.transfer(l, r, signal ?? defaultSignal),
    fetch: (r: string, l: string, signal?: AbortSignal) =>
      transport.fetch(r, l, signal ?? defaultSignal),
    ping: () => transport.ping(),
    close: () => transport.close(),
  }
}

/**
 * Clone an execution context while preserving its prototype/getters.
 *
 * This keeps class-backed accessors like `hasFailed` available while swapping
 * the transport for a wrapped variant.
 */
function withConnection(ctx: ExecutionContext, connection: Transport): ExecutionContext {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx) ?? Object.prototype), ctx, {
    connection,
  }) as ExecutionContext
}

/**
 * Clone an execution context with a derived AbortSignal.
 *
 * Used by withTimeout() to thread per-phase signals into the context so
 * resources and transport calls can observe cancellation.
 */
function withSignal(ctx: ExecutionContext, signal: AbortSignal): ExecutionContext {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx) ?? Object.prototype), ctx, {
    signal,
  }) as ExecutionContext
}

/**
 * Clone an execution context with a derived signal and a transport wrapper
 * that injects the same signal into exec/transfer/fetch calls by default.
 *
 * This ensures built-in resources that call `ctx.connection.exec(...)` (without
 * explicitly passing `{ signal: ctx.signal }`) still propagate cancellation to
 * the transport layer.
 */
function withPhaseSignal(ctx: ExecutionContext, signal: AbortSignal): ExecutionContext {
  const signaled = withSignal(ctx, signal)
  const wrapped = wrapTransport(signaled.connection, { signal }, signal)
  return withConnection(signaled, wrapped)
}

/**
 * Execute a single resource through the check-then-apply lifecycle.
 *
 * 1. Reports resource start to the context reporter.
 * 2. In check mode with cache: tries cache first, returns cached result on hit.
 * 3. Runs `check()` to compare current vs desired state (with timeout/retry).
 * 4. If already in desired state → status "ok", skip apply.
 * 5. If not in desired state and mode is "check" → status "changed", skip apply.
 * 6. If not in desired state and mode is "apply" → runs `apply()` (with timeout/retry), status "changed".
 * 7. On error → status "failed", error captured in result.
 * 8. Records timing and attempt metadata, pushes result to `ctx.results`, reports to `ctx.reporter`.
 * 9. In check mode with cache: stores the check result for future lookups.
 * 10. In "fail-fast" error mode, re-throws after recording the failure.
 */
export async function executeResource<TInput, TOutput>(
  ctx: ExecutionContext,
  def: ResourceDefinition<TInput, TOutput>,
  input: TInput,
  policy?: Partial<ResourcePolicy>,
  meta?: ResourceCallMeta,
): Promise<ResourceResult<TOutput>> {
  const name = def.formatName(input)

  // --- Resource-tag filtering ---
  // When an active tag filter is set on the context and the call carries tags,
  // skip execution if none of the call's tags match the filter.
  if (ctx.resourceTags && ctx.resourceTags.length > 0 && meta?.tags) {
    const filterSet = new Set(ctx.resourceTags)
    const matched = meta.tags.some((t) => filterSet.has(t))
    if (!matched) {
      const eventBus = ctx.eventBus
      const hostId = ctx.hostCorrelationId
      const resourceId = eventBus && hostId ? eventBus.nextId() : undefined
      const result: ResourceResult<TOutput> = {
        type: def.type,
        name,
        status: "ok",
        durationMs: 0,
        meta,
      }
      ctx.results.push(result)
      ctx.reporter.resourceStart(def.type, name)
      ctx.reporter.resourceEnd(result)
      if (eventBus && hostId && resourceId) {
        eventBus.resourceStarted(hostId, resourceId, def.type, name)
        eventBus.resourceFinished(hostId, resourceId, result)
      }
      return result
    }
  }

  ctx.reporter.resourceStart(def.type, name)

  const effectivePolicy = resolvePolicy(policy)
  const start = performance.now()
  const attempts: AttemptRecord[] = []
  let result: ResourceResult<TOutput>
  const eventBus = ctx.eventBus
  const hostId = ctx.hostCorrelationId
  const resourceId = eventBus && hostId ? eventBus.nextId() : undefined

  // Emit resource_started event via event bus
  if (eventBus && hostId && resourceId) {
    eventBus.resourceStarted(hostId, resourceId, def.type, name)
  }

  // --- Streaming output wiring ---
  // Wrap transport when verbose display OR event bus consumers (dashboard,
  // log sink) need streaming output. Reporter calls stay gated on verbose
  // so terminal display is still opt-in.
  let resourceCtx: ExecutionContext = ctx
  if (ctx.verbose || eventBus) {
    const onStdout = (chunk: string) => {
      if (ctx.verbose) ctx.reporter.resourceOutput?.(def.type, name, "stdout", chunk)
      if (eventBus && hostId && resourceId) {
        eventBus.resourceOutput(hostId, resourceId, def.type, name, "stdout", chunk)
      }
    }
    const onStderr = (chunk: string) => {
      if (ctx.verbose) ctx.reporter.resourceOutput?.(def.type, name, "stderr", chunk)
      if (eventBus && hostId && resourceId) {
        eventBus.resourceOutput(hostId, resourceId, def.type, name, "stderr", chunk)
      }
    }
    const wrapped = wrapTransport(ctx.connection, { onStdout, onStderr })
    resourceCtx = withConnection(ctx, wrapped)
  }

  const cache = ctx.cache

  // Build cache key for potential cache lookup/store
  const cacheKey = cache
    ? buildCacheKey({
        hostname: ctx.host.hostname,
        port: ctx.host.port,
        user: ctx.host.user,
        resourceType: def.type,
        resourceName: name,
        inputJson: stableStringify(input),
      })
    : undefined

  // --- Cache lookup (check mode only, never in apply mode) ---
  if (ctx.mode === "check" && cache && cacheKey) {
    const lookup = cache.get(cacheKey)
    if (lookup.hit && lookup.result) {
      const cachedCheck = lookup.result as CheckResult<TOutput>
      const status = cachedCheck.inDesiredState ? "ok" : "changed"
      result = {
        type: def.type,
        name,
        status,
        current: cachedCheck.current,
        desired: cachedCheck.desired,
        output: cachedCheck.output,
        durationMs: performance.now() - start,
        cacheHit: true,
        cacheAgeMs: lookup.ageMs,
        meta,
      }

      ctx.results.push(result)
      ctx.reporter.resourceEnd(result)
      if (eventBus && hostId && resourceId) {
        eventBus.resourceFinished(hostId, resourceId, result)
      }
      return result
    }
  }

  try {
    // --- Signal check before check phase ---
    if (ctx.signal?.aborted) {
      throw new Error("Resource aborted")
    }

    // --- Check phase with retry ---
    const checkResult = await executePhaseWithRetry(
      "check",
      () =>
        withTimeout(
          (signal) => def.check(withPhaseSignal(resourceCtx, signal), input),
          effectivePolicy.timeoutMs,
          ctx.signal,
        ),
      effectivePolicy,
      attempts,
      (attempt, phase, error, durationMs) => {
        if (eventBus && hostId && resourceId) {
          eventBus.resourceRetry(
            hostId,
            resourceId,
            attempt,
            def.type,
            name,
            phase,
            error,
            durationMs,
          )
        }
      },
    )

    if (checkResult.inDesiredState) {
      result = {
        type: def.type,
        name,
        status: "ok",
        current: checkResult.current,
        desired: checkResult.desired,
        output: checkResult.output,
        durationMs: performance.now() - start,
      }
    } else if (ctx.mode === "check") {
      result = {
        type: def.type,
        name,
        status: "changed",
        current: checkResult.current,
        desired: checkResult.desired,
        durationMs: performance.now() - start,
      }
    } else {
      // --- Signal check before apply phase ---
      if (ctx.signal?.aborted) {
        throw new Error("Resource aborted")
      }

      // --- Apply phase with retry ---
      const output = await executePhaseWithRetry(
        "apply",
        () =>
          withTimeout(
            (signal) => def.apply(withPhaseSignal(resourceCtx, signal), input),
            effectivePolicy.timeoutMs,
            ctx.signal,
          ),
        effectivePolicy,
        attempts,
        (attempt, phase, error, durationMs) => {
          if (eventBus && hostId && resourceId) {
            eventBus.resourceRetry(
              hostId,
              resourceId,
              attempt,
              def.type,
              name,
              phase,
              error,
              durationMs,
            )
          }
        },
      )

      // --- Post-check phase ---
      // When postCheck is enabled, run check() again after apply() to
      // verify convergence. If post-check shows still not in desired
      // state, this is a convergence failure → status 'failed'.
      if (effectivePolicy.postCheck) {
        const postCheckResult = await executePhaseWithRetry(
          "post-check",
          () =>
            withTimeout(
              (signal) => def.check(withPhaseSignal(resourceCtx, signal), input),
              effectivePolicy.timeoutMs,
              ctx.signal,
            ),
          effectivePolicy,
          attempts,
          (attempt, phase, error, durationMs) => {
            if (eventBus && hostId && resourceId) {
              eventBus.resourceRetry(
                hostId,
                resourceId,
                attempt,
                def.type,
                name,
                phase,
                error,
                durationMs,
              )
            }
          },
        )

        if (!postCheckResult.inDesiredState) {
          throw new ResourceError(
            def.type,
            name,
            `Convergence failure: post-check after apply() shows resource is still not in desired state`,
          )
        }

        result = {
          type: def.type,
          name,
          status: "changed",
          current: checkResult.current,
          desired: checkResult.desired,
          output,
          durationMs: performance.now() - start,
        }
      } else {
        result = {
          type: def.type,
          name,
          status: "changed",
          current: checkResult.current,
          desired: checkResult.desired,
          output,
          durationMs: performance.now() - start,
        }
      }
    }

    // Store in cache after successful check (check mode only)
    if (ctx.mode === "check" && cache && cacheKey) {
      cache.set(cacheKey, checkResult)
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      type: def.type,
      name,
      status: "failed",
      error,
      durationMs: performance.now() - start,
    }
  }

  // Mark cache miss when cache is enabled (check mode only)
  if (ctx.mode === "check" && cache && !result.cacheHit) {
    result.cacheHit = false
  }

  // Attach attempt metadata when retries occurred
  if (attempts.length > 1) {
    result.attempts = attempts
  }

  // Attach call metadata when provided
  if (meta) {
    result.meta = meta
  }

  ctx.results.push(result)
  ctx.reporter.resourceEnd(result)

  // Emit resource_finished event via event bus
  if (eventBus && hostId && resourceId) {
    eventBus.resourceFinished(hostId, resourceId, result)
  }

  if (result.status === "failed" && ctx.errorMode === "fail-fast") {
    throw result.error instanceof ResourceError
      ? result.error
      : new ResourceError(def.type, name, result.error!.message, result.error)
  }

  return result
}

/**
 * Execute a phase function with retry logic.
 *
 * Only retries on retryable errors (transport-level). Non-retryable errors
 * and timeouts from non-retryable causes are thrown immediately.
 */
async function executePhaseWithRetry<T>(
  phase: "check" | "apply" | "post-check",
  fn: () => Promise<T>,
  policy: ResourcePolicy,
  attempts: AttemptRecord[],
  onRetry?: (
    attempt: number,
    phase: "check" | "apply" | "post-check",
    error: Error,
    durationMs: number,
  ) => void,
): Promise<T> {
  const maxAttempts = policy.retries + 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = performance.now()
    try {
      const result = await fn()
      attempts.push({
        attempt,
        phase,
        durationMs: performance.now() - attemptStart,
      })
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      attempts.push({
        attempt,
        phase,
        error,
        durationMs: performance.now() - attemptStart,
      })

      // Only retry retryable errors and if we have attempts left
      if (attempt < maxAttempts && isRetryable(error)) {
        onRetry?.(attempt, phase, error, performance.now() - attemptStart)
        const delay = backoffDelay(policy.retryDelayMs, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      throw error
    }
  }

  // Unreachable — loop always returns or throws
  throw new Error("executePhaseWithRetry: unreachable")
}
