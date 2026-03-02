/**
 * Observability event pipeline — event schema, bus, and correlation IDs.
 *
 * Defines a unified event model for run/host/resource lifecycle telemetry.
 * All reporters and formatters consume the same event stream, ensuring
 * consistent output regardless of sink. See ADR-0016, ISSUE-0021.
 */

import type {
  ErrorMode,
  HostContext,
  ResourceResult,
  ResourceStatus,
  RunMode,
} from "../core/types.ts"
import type { RedactionPolicy } from "../core/serialize.ts"
import { redact } from "../core/serialize.ts"

// ---------------------------------------------------------------------------
// Correlation IDs
// ---------------------------------------------------------------------------

/** Unique identifier for a run, host, or resource execution. */
export type CorrelationId = string

/** Correlation context threaded through all events in a run. */
export interface CorrelationContext {
  /** Unique ID for the entire run. */
  readonly runId: CorrelationId
  /** Unique ID for the current host (absent for run-level events). */
  readonly hostId?: CorrelationId
  /** Unique ID for the current resource execution (absent for run/host-level events). */
  readonly resourceId?: CorrelationId
  /** 1-based attempt number (present only for retry-related events). */
  readonly attempt?: number
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Discriminant for all lifecycle event types. */
export type EventType =
  | "run_started"
  | "run_finished"
  | "host_started"
  | "host_finished"
  | "resource_started"
  | "resource_finished"
  | "resource_retry"
  | "resource_output"

/** Base shape shared by all events. */
export interface BaseEvent {
  /** Event type discriminant. */
  readonly type: EventType
  /** ISO-8601 timestamp of event emission. */
  readonly timestamp: string
  /** Correlation IDs for tracing. */
  readonly correlation: CorrelationContext
}

// ---------------------------------------------------------------------------
// Run-level events
// ---------------------------------------------------------------------------

/** Emitted when a run begins. */
export interface RunStartedEvent extends BaseEvent {
  readonly type: "run_started"
  readonly mode: RunMode
  readonly errorMode: ErrorMode
  readonly hostCount: number
}

/** Emitted when a run completes. */
export interface RunFinishedEvent extends BaseEvent {
  readonly type: "run_finished"
  readonly durationMs: number
  readonly hasFailures: boolean
  readonly hostCount: number
}

// ---------------------------------------------------------------------------
// Host-level events
// ---------------------------------------------------------------------------

/** Emitted when a host begins execution. */
export interface HostStartedEvent extends BaseEvent {
  readonly type: "host_started"
  readonly host: HostContext
}

/** Emitted when a host completes execution. */
export interface HostFinishedEvent extends BaseEvent {
  readonly type: "host_finished"
  readonly host: HostContext
  readonly ok: number
  readonly changed: number
  readonly failed: number
  readonly durationMs: number
  readonly cancelled?: boolean
}

// ---------------------------------------------------------------------------
// Resource-level events
// ---------------------------------------------------------------------------

/** Emitted when a resource begins execution. */
export interface ResourceStartedEvent extends BaseEvent {
  readonly type: "resource_started"
  readonly resourceType: string
  readonly resourceName: string
}

/** Emitted when a resource completes execution. */
export interface ResourceFinishedEvent extends BaseEvent {
  readonly type: "resource_finished"
  readonly resourceType: string
  readonly resourceName: string
  readonly status: ResourceStatus
  readonly durationMs: number
  readonly error?: { readonly message: string; readonly name: string }
  readonly cacheHit?: boolean
}

/** Emitted when a resource phase is retried. */
export interface ResourceRetryEvent extends BaseEvent {
  readonly type: "resource_retry"
  readonly resourceType: string
  readonly resourceName: string
  readonly phase: "check" | "apply" | "post-check"
  readonly error: { readonly message: string; readonly name: string }
  readonly durationMs: number
}

/** Emitted when a resource produces stdout/stderr output during execution. */
export interface ResourceOutputEvent extends BaseEvent {
  readonly type: "resource_output"
  readonly resourceType: string
  readonly resourceName: string
  readonly stream: "stdout" | "stderr"
  readonly chunk: string
}

/** Discriminated union of all lifecycle events. */
export type LifecycleEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | HostStartedEvent
  | HostFinishedEvent
  | ResourceStartedEvent
  | ResourceFinishedEvent
  | ResourceRetryEvent
  | ResourceOutputEvent

// ---------------------------------------------------------------------------
// Event listener
// ---------------------------------------------------------------------------

/** Callback for receiving lifecycle events. */
export type EventListener = (event: LifecycleEvent) => void

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

/**
 * Central event bus for run lifecycle telemetry.
 *
 * Generates correlation IDs and dispatches events to registered listeners.
 * Thread-safe for concurrent host execution — each emit is synchronous.
 */
export class EventBus {
  readonly #listeners: EventListener[] = []
  readonly #runId: CorrelationId
  #idCounter = 0

  constructor(runId?: CorrelationId) {
    this.#runId = runId ?? generateId()
  }

  /** The run-level correlation ID. */
  get runId(): CorrelationId {
    return this.#runId
  }

  /** Register a listener. Returns an unsubscribe function. */
  on(listener: EventListener): () => void {
    this.#listeners.push(listener)
    return () => {
      const idx = this.#listeners.indexOf(listener)
      if (idx >= 0) this.#listeners.splice(idx, 1)
    }
  }

  /** Generate a unique correlation ID for a host or resource. */
  nextId(): CorrelationId {
    return `${this.#runId}-${++this.#idCounter}`
  }

  /** Emit an event to all listeners. */
  emit(event: LifecycleEvent): void {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  // -- Convenience builders -------------------------------------------------

  /** Build and emit a run_started event. */
  runStarted(mode: RunMode, errorMode: ErrorMode, hostCount: number): void {
    this.emit({
      type: "run_started",
      timestamp: now(),
      correlation: { runId: this.#runId },
      mode,
      errorMode,
      hostCount,
    })
  }

  /** Build and emit a run_finished event. */
  runFinished(durationMs: number, hasFailures: boolean, hostCount: number): void {
    this.emit({
      type: "run_finished",
      timestamp: now(),
      correlation: { runId: this.#runId },
      durationMs,
      hasFailures,
      hostCount,
    })
  }

  /** Build and emit a host_started event. */
  hostStarted(hostId: CorrelationId, host: HostContext): void {
    this.emit({
      type: "host_started",
      timestamp: now(),
      correlation: { runId: this.#runId, hostId },
      host,
    })
  }

  /** Build and emit a host_finished event. */
  hostFinished(
    hostId: CorrelationId,
    host: HostContext,
    counts: {
      ok: number
      changed: number
      failed: number
      durationMs: number
      cancelled?: boolean
    },
  ): void {
    this.emit({
      type: "host_finished",
      timestamp: now(),
      correlation: { runId: this.#runId, hostId },
      host,
      ...counts,
    })
  }

  /** Build and emit a resource_started event. */
  resourceStarted(
    hostId: CorrelationId,
    resourceId: CorrelationId,
    resourceType: string,
    resourceName: string,
  ): void {
    this.emit({
      type: "resource_started",
      timestamp: now(),
      correlation: { runId: this.#runId, hostId, resourceId },
      resourceType,
      resourceName,
    })
  }

  /** Build and emit a resource_finished event. */
  resourceFinished(hostId: CorrelationId, resourceId: CorrelationId, result: ResourceResult): void {
    this.emit({
      type: "resource_finished",
      timestamp: now(),
      correlation: { runId: this.#runId, hostId, resourceId },
      resourceType: result.type,
      resourceName: result.name,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error ? { message: result.error.message, name: result.error.name } : undefined,
      cacheHit: result.cacheHit,
    })
  }

  /** Build and emit a resource_retry event. */
  resourceRetry(
    hostId: CorrelationId,
    resourceId: CorrelationId,
    attempt: number,
    resourceType: string,
    resourceName: string,
    phase: "check" | "apply" | "post-check",
    error: Error,
    durationMs: number,
  ): void {
    this.emit({
      type: "resource_retry",
      timestamp: now(),
      correlation: { runId: this.#runId, hostId, resourceId, attempt },
      resourceType,
      resourceName,
      phase,
      error: { message: error.message, name: error.name },
      durationMs,
    })
  }

  /** Build and emit a resource_output event. */
  resourceOutput(
    hostId: CorrelationId,
    resourceId: CorrelationId,
    resourceType: string,
    resourceName: string,
    stream: "stdout" | "stderr",
    chunk: string,
  ): void {
    this.emit({
      type: "resource_output",
      timestamp: now(),
      correlation: { runId: this.#runId, hostId, resourceId },
      resourceType,
      resourceName,
      stream,
      chunk,
    })
  }
}

// ---------------------------------------------------------------------------
// EventReporter — bridges event bus to Reporter interface
// ---------------------------------------------------------------------------

/**
 * A Reporter that emits resource lifecycle events to an EventBus.
 *
 * Wraps an optional delegate Reporter so existing pretty/quiet output
 * continues to work alongside the event pipeline. Requires hostId and
 * a reference to the event bus for correlation.
 */
export class EventReporter {
  readonly #bus: EventBus
  readonly #hostId: CorrelationId
  readonly #delegate?: {
    resourceStart(type: string, name: string): void
    resourceEnd(result: ResourceResult): void
    resourceOutput?(type: string, name: string, stream: "stdout" | "stderr", chunk: string): void
  }

  constructor(
    bus: EventBus,
    hostId: CorrelationId,
    delegate?: {
      resourceStart(type: string, name: string): void
      resourceEnd(result: ResourceResult): void
      resourceOutput?(type: string, name: string, stream: "stdout" | "stderr", chunk: string): void
    },
  ) {
    this.#bus = bus
    this.#hostId = hostId
    this.#delegate = delegate
  }

  /** The event bus backing this reporter. */
  get bus(): EventBus {
    return this.#bus
  }

  /** The host correlation ID for this reporter. */
  get hostId(): CorrelationId {
    return this.#hostId
  }

  resourceStart(type: string, name: string): void {
    const resourceId = this.#bus.nextId()
    // Store the resourceId for pairing with resourceEnd — use a stack
    // since resources within a host are sequential.
    this.#currentResourceId = resourceId
    this.#bus.resourceStarted(this.#hostId, resourceId, type, name)
    this.#delegate?.resourceStart(type, name)
  }

  resourceEnd(result: ResourceResult): void {
    const resourceId = this.#currentResourceId ?? this.#bus.nextId()
    this.#bus.resourceFinished(this.#hostId, resourceId, result)
    this.#delegate?.resourceEnd(result)
    this.#currentResourceId = undefined
  }

  /** Emit a retry event for the currently active resource. */
  resourceRetry(
    attempt: number,
    resourceType: string,
    resourceName: string,
    phase: "check" | "apply" | "post-check",
    error: Error,
    durationMs: number,
  ): void {
    const resourceId = this.#currentResourceId ?? this.#bus.nextId()
    this.#bus.resourceRetry(
      this.#hostId,
      resourceId,
      attempt,
      resourceType,
      resourceName,
      phase,
      error,
      durationMs,
    )
  }

  /** Emit a resource_output event for the currently active resource. */
  resourceOutput(
    resourceType: string,
    resourceName: string,
    stream: "stdout" | "stderr",
    chunk: string,
  ): void {
    const resourceId = this.#currentResourceId ?? this.#bus.nextId()
    this.#bus.resourceOutput(this.#hostId, resourceId, resourceType, resourceName, stream, chunk)
    this.#delegate?.resourceOutput?.(resourceType, resourceName, stream, chunk)
  }

  /** Current resource correlation ID (set during resourceStart, cleared on resourceEnd). */
  #currentResourceId?: CorrelationId
}

// ---------------------------------------------------------------------------
// NdjsonStream — NDJSON output sink
// ---------------------------------------------------------------------------

/**
 * Streams lifecycle events as newline-delimited JSON (NDJSON).
 *
 * Each event is serialized as a single JSON line followed by `\n`.
 * Suitable for piping to log aggregators, monitoring tools, or `jq`.
 * When a redaction policy is provided, sensitive fields are replaced
 * before serialization. See ISSUE-0033.
 */
export class NdjsonStream {
  readonly #writer: { writeSync(p: Uint8Array): number }
  readonly #encoder = new TextEncoder()
  readonly #redactionPolicy?: RedactionPolicy

  constructor(writer: { writeSync(p: Uint8Array): number }, redactionPolicy?: RedactionPolicy) {
    this.#writer = writer
    this.#redactionPolicy = redactionPolicy
  }

  /** EventListener-compatible handler. */
  readonly listener: EventListener = (event: LifecycleEvent): void => {
    const output = this.#redactionPolicy ? redact(event, this.#redactionPolicy) : event
    const line = JSON.stringify(output, serializeError) + "\n"
    this.#writer.writeSync(this.#encoder.encode(line))
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Generate a short unique ID (12 hex chars). */
export function generateId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** JSON replacer that serializes Error instances. */
function serializeError(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name }
  }
  return value
}

/** ISO-8601 timestamp. */
function now(): string {
  return new Date().toISOString()
}
