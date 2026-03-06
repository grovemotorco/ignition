/**
 * Recipe runner — orchestrates execution across hosts.
 *
 * Creates an ExecutionContext per host, loads and executes the recipe function,
 * and produces a RunSummary with per-host results and timing. Manages transport
 * lifecycle (close/cleanup) per host. Supports bounded host-level concurrency
 * with cancellation and timeout semantics. Optionally emits lifecycle events
 * via an EventBus for observability.
 */

import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import type {
  CheckResultCache,
  ConcurrencyOptions,
  ErrorMode,
  HostContext,
  HostRunSummary,
  Reporter,
  ResourcePolicy,
  RunMode,
  RunSummary,
} from "./types.ts"
import { DEFAULT_CONCURRENCY } from "./types.ts"
import type { Transport } from "../ssh/types.ts"
import { ExecutionContextImpl } from "./context.ts"
import { SSHConnectionError } from "./errors.ts"
import { probeHostFacts } from "./facts.ts"
import type { RecipeFunction } from "../recipe/types.ts"
import { loadRecipe } from "../recipe/loader.ts"
import type { EventBus } from "../output/events.ts"

export type { RecipeFunction } from "../recipe/types.ts"

/** Options for runRecipe(). */
export type RunRecipeOptions = {
  /** Recipe function to execute, or path to a recipe .ts file to load. */
  recipe: RecipeFunction | string
  /** Hosts to run against. */
  hosts: ReadonlyArray<{
    host: HostContext
    connection: Transport
  }>
  /** Run mode (apply or check). */
  mode: RunMode
  /** Error handling strategy. */
  errorMode: ErrorMode
  /** Verbose output. */
  verbose: boolean
  /** Reporter for output. */
  reporter: Reporter
  /** CLI variable overrides. */
  vars?: Record<string, unknown> | undefined
  /** Optional recipe tag filter (intersection with recipe meta tags). */
  tags?: string[] | undefined
  /** Concurrency options for multi-host runs. */
  concurrency?: Partial<ConcurrencyOptions> | undefined
  /** Global resource execution policy (timeout/retry). */
  resourcePolicy?: Partial<ResourcePolicy> | undefined
  /** AbortSignal for run-level cancellation. */
  signal?: AbortSignal | undefined
  /** Optional check result cache. */
  cache?: CheckResultCache | undefined
  /** Optional event bus for lifecycle telemetry. */
  eventBus?: EventBus | undefined
}

/**
 * Determine whether the loaded recipe should execute for the selected tag
 * filter. When no filter is provided, all recipes run.
 */
function recipeMatchesTags(
  recipeTags: string[] | undefined,
  selected: string[] | undefined,
): boolean {
  if (!selected || selected.length === 0) return true
  if (!recipeTags || recipeTags.length === 0) return false
  const selectedSet = new Set(selected)
  return recipeTags.some((tag) => selectedSet.has(tag))
}

/**
 * Build a HostRunSummary from accumulated results.
 */
function summarizeHost(
  host: HostContext,
  ctx: ExecutionContextImpl,
  durationMs: number,
  cancelled = false,
): HostRunSummary {
  const summary: HostRunSummary = {
    host,
    results: [...ctx.results],
    ok: ctx.results.filter((r) => r.status === "ok").length,
    changed: ctx.results.filter((r) => r.status === "changed").length,
    failed: ctx.results.filter((r) => r.status === "failed").length,
    durationMs,
  }
  if (cancelled) {
    summary.cancelled = true
  }
  return summary
}

/** Build a cancelled HostRunSummary for a host that never started. */
function cancelledHostSummary(host: HostContext): HostRunSummary {
  return {
    host,
    results: [],
    ok: 0,
    changed: 0,
    failed: 0,
    durationMs: 0,
    cancelled: true,
  }
}

/** Build a timed-out HostRunSummary. */
function timedOutHostSummary(
  host: HostContext,
  ctx: ExecutionContextImpl | undefined,
  durationMs: number,
): HostRunSummary {
  const results = ctx ? [...ctx.results] : []
  results.push({
    type: "timeout",
    name: host.hostname,
    status: "failed",
    error: new SSHConnectionError(host.hostname, `Host timeout exceeded`),
    durationMs,
  })
  return {
    host,
    results,
    ok: results.filter((r) => r.status === "ok").length,
    changed: results.filter((r) => r.status === "changed").length,
    failed: results.filter((r) => r.status === "failed").length,
    durationMs,
    cancelled: true,
  }
}

/**
 * Execute the recipe against a single host. Returns a HostRunSummary.
 *
 * Handles ping, context creation, recipe execution, and connection cleanup.
 * Respects the provided AbortSignal for cancellation.
 */
async function executeHost(
  host: HostContext,
  connection: Transport,
  recipeFn: RecipeFunction,
  opts: {
    mode: RunMode
    errorMode: ErrorMode
    verbose: boolean
    reporter: Reporter
    vars?: Record<string, unknown>
    signal?: AbortSignal
    hostTimeout: number
    cache?: CheckResultCache
    eventBus?: EventBus
    resourcePolicy?: Partial<ResourcePolicy>
    recipeName: string
  },
): Promise<HostRunSummary> {
  const hostStart = performance.now()

  // Generate host correlation ID
  const hostId = opts.eventBus?.nextId()

  // Check cancellation before starting
  if (opts.signal?.aborted) {
    await closeQuietly(connection)
    const summary = cancelledHostSummary(host)
    if (opts.eventBus && hostId) {
      opts.eventBus.hostStarted(hostId, host)
      opts.eventBus.hostFinished(hostId, host, summary)
    }
    return summary
  }

  // Emit host_started event
  if (opts.eventBus && hostId) {
    opts.eventBus.hostStarted(hostId, host)
  }

  // Report host start (before ping so failures are visible)
  opts.reporter.hostStart?.(host.name, host.hostname)

  // Verify connectivity
  let reachable: boolean
  try {
    reachable = await connection.ping()
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    const connResult = {
      type: "connection",
      name: host.hostname,
      status: "failed" as const,
      error: new SSHConnectionError(
        host.hostname,
        `Ping failed for ${host.hostname}:${host.port}: ${error.message}`,
        error,
        host.port,
      ),
      durationMs: performance.now() - hostStart,
    }
    const summary: HostRunSummary = {
      host,
      results: [connResult],
      ok: 0,
      changed: 0,
      failed: 1,
      durationMs: performance.now() - hostStart,
    }
    opts.reporter.resourceStart("connection", host.hostname)
    opts.reporter.resourceEnd(connResult)
    if (opts.eventBus && hostId) {
      const connResId = opts.eventBus.nextId()
      opts.eventBus.resourceStarted(hostId, connResId, "connection", host.hostname)
      opts.eventBus.resourceFinished(hostId, connResId, connResult)
    }
    opts.reporter.hostEnd?.(summary)
    await closeQuietly(connection)
    if (opts.eventBus && hostId) {
      opts.eventBus.hostFinished(hostId, host, summary)
    }
    return summary
  }

  if (!reachable) {
    // Surface SSH stderr when available for diagnostics
    const detail =
      "lastPingError" in connection && (connection as { lastPingError: string }).lastPingError
    const message = detail
      ? `Host ${host.hostname}:${host.port} is not reachable: ${detail}`
      : `Host ${host.hostname}:${host.port} is not reachable`
    const connResult = {
      type: "connection",
      name: host.hostname,
      status: "failed" as const,
      error: new SSHConnectionError(host.hostname, message, undefined, host.port),
      durationMs: performance.now() - hostStart,
    }
    const summary: HostRunSummary = {
      host,
      results: [connResult],
      ok: 0,
      changed: 0,
      failed: 1,
      durationMs: performance.now() - hostStart,
    }
    opts.reporter.resourceStart("connection", host.hostname)
    opts.reporter.resourceEnd(connResult)
    if (opts.eventBus && hostId) {
      const connResId = opts.eventBus.nextId()
      opts.eventBus.resourceStarted(hostId, connResId, "connection", host.hostname)
      opts.eventBus.resourceFinished(hostId, connResId, connResult)
    }
    opts.reporter.hostEnd?.(summary)
    await closeQuietly(connection)
    if (opts.eventBus && hostId) {
      opts.eventBus.hostFinished(hostId, host, summary)
    }
    return summary
  }

  // Check cancellation after ping but before probe
  if (opts.signal?.aborted) {
    await closeQuietly(connection)
    const summary = cancelledHostSummary(host)
    if (opts.eventBus && hostId) {
      opts.eventBus.hostFinished(hostId, host, summary)
    }
    return summary
  }

  // --- Probe host facts ---
  const facts = await probeHostFacts(connection)

  // --- Per-host cancellation controller ---
  const hostController = new AbortController()
  let hostTimedOut = false
  const hostTimeoutId =
    opts.hostTimeout > 0
      ? setTimeout(() => {
          hostTimedOut = true
          hostController.abort()
        }, opts.hostTimeout)
      : undefined

  // Forward run-level signal into per-host controller
  const onRunAbort = () => hostController.abort()
  if (opts.signal?.aborted) {
    hostController.abort()
  } else if (opts.signal) {
    opts.signal.addEventListener("abort", onRunAbort, { once: true })
  }

  // Create context for this host
  const ctx = new ExecutionContextImpl({
    connection,
    mode: opts.mode,
    errorMode: opts.errorMode,
    verbose: opts.verbose,
    host,
    reporter: opts.reporter,
    vars: { ...host.vars, ...opts.vars },
    cache: opts.cache,
    resourcePolicy: opts.resourcePolicy,
    eventBus: opts.eventBus,
    hostCorrelationId: hostId,
    signal: hostController.signal,
    facts,
  })

  let recipeError: Error | undefined

  // Execute recipe
  if (opts.hostTimeout > 0) {
    try {
      await Promise.race([
        recipeFn(ctx),
        new Promise<never>((_resolve, reject) => {
          hostController.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("host_timeout"))
            },
            { once: true },
          )
          if (hostController.signal.aborted) {
            reject(new Error("host_timeout"))
          }
        }),
      ])
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (error.message === "host_timeout" && hostTimedOut) {
        const summary = timedOutHostSummary(host, ctx, performance.now() - hostStart)
        opts.reporter.hostEnd?.(summary)
        if (opts.eventBus && hostId) {
          opts.eventBus.hostFinished(hostId, host, summary)
        }
        await closeQuietly(connection)
        if (hostTimeoutId !== undefined) clearTimeout(hostTimeoutId)
        opts.signal?.removeEventListener("abort", onRunAbort)
        return summary
      }
      recipeError = error
    } finally {
      if (hostTimeoutId !== undefined) clearTimeout(hostTimeoutId)
      opts.signal?.removeEventListener("abort", onRunAbort)
    }
  } else {
    // No timeout — execute with signal-based cancellation
    try {
      await recipeFn(ctx)
    } catch (err) {
      recipeError = err instanceof Error ? err : new Error(String(err))
    } finally {
      opts.signal?.removeEventListener("abort", onRunAbort)
    }
  }

  // Ensure recipe-level exceptions surface as host failures.
  if (recipeError && !ctx.results.some((r) => r.status === "failed")) {
    ctx.results.push({
      type: "recipe",
      name: opts.recipeName,
      status: "failed",
      error: recipeError,
      durationMs: performance.now() - hostStart,
    })
  }

  // Check if cancelled after execution
  const cancelled = opts.signal?.aborted ?? false
  const summary = summarizeHost(host, ctx, performance.now() - hostStart, cancelled)

  // Report host end
  opts.reporter.hostEnd?.(summary)

  // Emit host_finished event
  if (opts.eventBus && hostId) {
    opts.eventBus.hostFinished(hostId, host, summary)
  }

  // Clean up SSH session
  await closeQuietly(connection)

  return summary
}

/**
 * Run a recipe against one or more hosts with bounded concurrency.
 *
 * Returns a RunSummary with per-host results in input order (deterministic).
 */
export async function runRecipe(opts: RunRecipeOptions): Promise<RunSummary> {
  const runStart = performance.now()
  const timestamp = new Date().toISOString()

  // Resolve recipe function
  let recipeFn: RecipeFunction
  let recipeName = "<inline-recipe>"
  let recipeAudit: RunSummary["recipe"]
  if (typeof opts.recipe === "string") {
    const loaded = await loadRecipe(opts.recipe)
    recipeName = loaded.path

    recipeAudit = {
      path: loaded.path,
      checksum: await hashRecipeFile(loaded.path),
    }

    if (!recipeMatchesTags(loaded.meta?.tags, opts.tags)) {
      recipeFn = async () => {}
    } else {
      recipeFn = loaded.fn
    }
  } else {
    recipeFn = opts.recipe
  }

  const parallelism = opts.concurrency?.parallelism ?? DEFAULT_CONCURRENCY.parallelism
  const hostTimeout = opts.concurrency?.hostTimeout ?? DEFAULT_CONCURRENCY.hostTimeout

  const eventBus = opts.eventBus

  // Create an AbortController for fail-fast cancellation
  const runController = new AbortController()

  // Chain external signal if provided
  if (opts.signal?.aborted) {
    runController.abort()
  } else {
    opts.signal?.addEventListener("abort", () => runController.abort(), { once: true })
  }

  const hostEntries = opts.hosts

  // Emit run_started event
  eventBus?.runStarted(opts.mode, opts.errorMode, hostEntries.length)

  // Show check-mode banner
  if (opts.mode === "check") {
    opts.reporter.checkBanner?.()
  }

  if (hostEntries.length === 0) {
    const summary: RunSummary = {
      hosts: [],
      hasFailures: false,
      durationMs: performance.now() - runStart,
      mode: opts.mode,
      timestamp,
      recipe: recipeAudit,
    }
    eventBus?.runFinished(summary.durationMs, summary.hasFailures, 0)
    return summary
  }

  // Run with bounded parallelism using a pool
  const results: Array<HostRunSummary | null> = Array.from(
    { length: hostEntries.length },
    () => null,
  )
  let nextIndex = 0

  async function runNext(): Promise<void> {
    while (nextIndex < hostEntries.length) {
      // Check cancellation before starting next host
      if (runController.signal.aborted) {
        // Mark remaining hosts as cancelled
        while (nextIndex < hostEntries.length) {
          const idx = nextIndex++
          const { host, connection } = hostEntries[idx]
          await closeQuietly(connection)
          const summary = cancelledHostSummary(host)
          if (eventBus) {
            const cancelledHostId = eventBus.nextId()
            eventBus.hostStarted(cancelledHostId, host)
            eventBus.hostFinished(cancelledHostId, host, summary)
          }
          results[idx] = summary
        }
        return
      }

      const idx = nextIndex++
      const { host, connection } = hostEntries[idx]

      const summary = await executeHost(host, connection, recipeFn, {
        mode: opts.mode,
        errorMode: opts.errorMode,
        verbose: opts.verbose,
        reporter: opts.reporter,
        vars: opts.vars,
        signal: runController.signal,
        hostTimeout,
        cache: opts.cache,
        eventBus,
        resourcePolicy: opts.resourcePolicy,
        recipeName,
      })

      results[idx] = summary

      // fail-fast: cancel siblings on terminal failure
      if (opts.errorMode === "fail-fast" && summary.failed > 0 && !summary.cancelled) {
        runController.abort()
      }
    }
  }

  // Launch pool workers up to parallelism bound
  const workers: Promise<void>[] = []
  const workerCount = Math.min(parallelism, hostEntries.length)
  for (let i = 0; i < workerCount; i++) {
    workers.push(runNext())
  }
  await Promise.all(workers)

  const hostSummaries = results.filter((r): r is HostRunSummary => r !== null)

  const runSummary: RunSummary = {
    hosts: hostSummaries,
    hasFailures: hostSummaries.some((h) => h.failed > 0),
    durationMs: performance.now() - runStart,
    mode: opts.mode,
    timestamp,
    recipe: recipeAudit,
  }

  // Emit run_finished event
  eventBus?.runFinished(runSummary.durationMs, runSummary.hasFailures, hostSummaries.length)

  return runSummary
}

/** Compute SHA-256 hex digest of a recipe file for audit purposes. */
async function hashRecipeFile(path: string): Promise<string> {
  try {
    // Convert file:// URL to path for fs read
    const filePath = path.startsWith("file://") ? fileURLToPath(path) : path
    const content = await readFile(filePath)
    const digest = await crypto.subtle.digest("SHA-256", content)
    const bytes = new Uint8Array(digest)
    return `sha256:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
  } catch {
    return "sha256:unknown"
  }
}

/** Close a transport connection, swallowing any errors. */
async function closeQuietly(connection: Transport): Promise<void> {
  try {
    await connection.close()
  } catch {
    // Close errors are non-fatal — the socket will expire on its own.
  }
}
