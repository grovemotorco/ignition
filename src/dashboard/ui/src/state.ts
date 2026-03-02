/**
 * Dashboard state model and event reducer.
 *
 * Defines the wire-format event types locally (matching the server's
 * LifecycleEvent JSON) to keep the UI self-contained and avoid
 * cross-workspace import issues with Vite.
 */

// ---------------------------------------------------------------------------
// Wire-format event types (mirrors src/output/events.ts JSON output)
// ---------------------------------------------------------------------------

interface CorrelationContext {
  readonly runId: string
  readonly hostId?: string
  readonly resourceId?: string
  readonly attempt?: number
}

interface BaseEvent {
  readonly type: string
  readonly timestamp: string
  readonly correlation: CorrelationContext
}

interface RunStartedEvent extends BaseEvent {
  readonly type: "run_started"
  readonly mode: "apply" | "check"
  readonly errorMode: string
  readonly hostCount: number
}

interface RunFinishedEvent extends BaseEvent {
  readonly type: "run_finished"
  readonly durationMs: number
  readonly hasFailures: boolean
  readonly hostCount: number
}

interface HostStartedEvent extends BaseEvent {
  readonly type: "host_started"
  readonly host: { name: string; hostname: string }
}

interface HostFinishedEvent extends BaseEvent {
  readonly type: "host_finished"
  readonly host: { name: string; hostname: string }
  readonly ok: number
  readonly changed: number
  readonly failed: number
  readonly durationMs: number
  readonly cancelled?: boolean
}

interface ResourceStartedEvent extends BaseEvent {
  readonly type: "resource_started"
  readonly resourceType: string
  readonly resourceName: string
}

interface ResourceFinishedEvent extends BaseEvent {
  readonly type: "resource_finished"
  readonly resourceType: string
  readonly resourceName: string
  readonly status: string
  readonly durationMs: number
  readonly error?: { message: string; name: string }
  readonly cacheHit?: boolean
}

interface ResourceRetryEvent extends BaseEvent {
  readonly type: "resource_retry"
  readonly resourceType: string
  readonly resourceName: string
  readonly phase: string
  readonly error: { message: string; name: string }
  readonly durationMs: number
}

interface ResourceOutputEvent extends BaseEvent {
  readonly type: "resource_output"
  readonly resourceType: string
  readonly resourceName: string
  readonly stream: "stdout" | "stderr"
  readonly chunk: string
}

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
// State model
// ---------------------------------------------------------------------------

export interface ResourceState {
  type: string
  name: string
  status: "running" | "ok" | "changed" | "failed"
  durationMs?: number
  error?: { message: string; name: string }
  cacheHit?: boolean
  retries: Array<{ attempt: number; phase: string; error: string }>
  output: Array<{ stream: "stdout" | "stderr"; text: string }>
  outputPending: { stdout: string; stderr: string }
}

export interface HostState {
  host: { name: string; hostname: string }
  status: "running" | "finished" | "cancelled"
  resources: Map<string, ResourceState>
  ok: number
  changed: number
  failed: number
  durationMs?: number
  cancelled?: boolean
}

export interface RunState {
  id: string
  mode: "apply" | "check"
  errorMode: string
  hostCount: number
  startedAt: string
  finishedAt?: string
  durationMs?: number
  hasFailures?: boolean
}

export interface RunSummary {
  id: string
  mode: string
  startedAt: string
  finishedAt?: string
  hasFailures?: boolean
}

export interface DashboardState {
  runs: RunSummary[]
  activeRunId: string | null
  run: RunState | null
  hosts: Map<string, HostState>
}

export function createInitialState(): DashboardState {
  return { runs: [], activeRunId: null, run: null, hosts: new Map() }
}

function upsertRunSummary(runs: RunSummary[], summary: RunSummary): RunSummary[] {
  const index = runs.findIndex((run) => run.id === summary.id)
  if (index === -1) {
    return [...runs, summary]
  }
  const next = [...runs]
  next[index] = summary
  return next
}

function updateRunsFromLifecycleEvent(runs: RunSummary[], event: LifecycleEvent): RunSummary[] {
  switch (event.type) {
    case "run_started":
      return upsertRunSummary(runs, {
        id: event.correlation.runId,
        mode: event.mode,
        startedAt: event.timestamp,
      })
    case "run_finished": {
      const existing = runs.find((run) => run.id === event.correlation.runId)
      return upsertRunSummary(runs, {
        id: event.correlation.runId,
        mode: existing?.mode ?? "unknown",
        startedAt: existing?.startedAt ?? event.timestamp,
        finishedAt: event.timestamp,
        hasFailures: event.hasFailures,
      })
    }
    default:
      return runs
  }
}

// ---------------------------------------------------------------------------
// Actions (non-event actions dispatched by the UI)
// ---------------------------------------------------------------------------

export interface SelectRunAction {
  readonly type: "SELECT_RUN"
  readonly runId: string
  readonly events: LifecycleEvent[]
}

export interface SetRunsAction {
  readonly type: "SET_RUNS"
  readonly runs: RunSummary[]
}

export type DashboardAction = LifecycleEvent | SelectRunAction | SetRunsAction

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function appendOutputChunk(
  resource: ResourceState,
  stream: "stdout" | "stderr",
  chunk: string,
): ResourceState {
  const merged = resource.outputPending[stream] + chunk
  const parts = merged.split("\n")
  const remainder = parts.pop() ?? ""

  const output =
    parts.length > 0
      ? [...resource.output, ...parts.map((text) => ({ stream, text }))]
      : resource.output

  const outputPending = {
    ...resource.outputPending,
    [stream]: remainder,
  } as ResourceState["outputPending"]
  return { ...resource, output, outputPending }
}

function flushPendingOutput(resource: ResourceState): ResourceState {
  const { stdout, stderr } = resource.outputPending
  if (stdout.length === 0 && stderr.length === 0) return resource

  const output = [...resource.output]
  if (stdout.length > 0) output.push({ stream: "stdout", text: stdout })
  if (stderr.length > 0) output.push({ stream: "stderr", text: stderr })

  return { ...resource, output, outputPending: { stdout: "", stderr: "" } }
}

export function eventReducer(state: DashboardState, action: DashboardAction): DashboardState {
  if (action.type === "SET_RUNS") {
    return { ...state, runs: action.runs }
  }

  if (action.type === "SELECT_RUN") {
    // Replay events to reconstruct state for a historical run
    let replayed = createInitialState()
    replayed = { ...replayed, runs: state.runs }
    for (const event of action.events) {
      replayed = eventReducer(replayed, event)
    }
    return { ...replayed, runs: state.runs, activeRunId: action.runId }
  }

  const event = action
  const runsForEvent = updateRunsFromLifecycleEvent(state.runs, event)

  // When a historical run is selected, keep the detail pane isolated from other live runs.
  if (state.activeRunId && state.activeRunId !== event.correlation.runId) {
    return runsForEvent === state.runs ? state : { ...state, runs: runsForEvent }
  }

  switch (event.type) {
    case "run_started": {
      let runs = runsForEvent
      if (state.run && state.run.id !== event.correlation.runId) {
        runs = upsertRunSummary(runs, {
          id: state.run.id,
          mode: state.run.mode,
          startedAt: state.run.startedAt,
          finishedAt: state.run.finishedAt,
          hasFailures: state.run.hasFailures,
        })
      }
      return {
        runs,
        activeRunId: event.correlation.runId,
        run: {
          id: event.correlation.runId,
          mode: event.mode,
          errorMode: event.errorMode,
          hostCount: event.hostCount,
          startedAt: event.timestamp,
        },
        hosts: new Map(),
      }
    }

    case "run_finished": {
      const updatedRun = state.run
        ? {
            ...state.run,
            finishedAt: event.timestamp,
            durationMs: event.durationMs,
            hasFailures: event.hasFailures,
          }
        : state.run
      return { ...state, run: updatedRun, runs: runsForEvent }
    }

    case "host_started": {
      const hostId = event.correlation.hostId
      if (!hostId) return state
      const hosts = new Map(state.hosts)
      hosts.set(hostId, {
        host: event.host,
        status: "running",
        resources: new Map(),
        ok: 0,
        changed: 0,
        failed: 0,
      })
      return { ...state, hosts }
    }

    case "host_finished": {
      const hostId = event.correlation.hostId
      if (!hostId) return state
      const hosts = new Map(state.hosts)
      const existing = hosts.get(hostId)
      if (existing) {
        hosts.set(hostId, {
          ...existing,
          status: event.cancelled ? "cancelled" : "finished",
          ok: event.ok,
          changed: event.changed,
          failed: event.failed,
          durationMs: event.durationMs,
          cancelled: event.cancelled,
        })
      }
      return { ...state, hosts }
    }

    case "resource_started": {
      const hostId = event.correlation.hostId
      const resourceId = event.correlation.resourceId
      if (!hostId || !resourceId) return state
      const hosts = new Map(state.hosts)
      const host = hosts.get(hostId)
      if (host) {
        const resources = new Map(host.resources)
        resources.set(resourceId, {
          type: event.resourceType,
          name: event.resourceName,
          status: "running",
          retries: [],
          output: [],
          outputPending: { stdout: "", stderr: "" },
        })
        hosts.set(hostId, { ...host, resources })
      }
      return { ...state, hosts }
    }

    case "resource_finished": {
      const hostId = event.correlation.hostId
      const resourceId = event.correlation.resourceId
      if (!hostId || !resourceId) return state
      const hosts = new Map(state.hosts)
      const host = hosts.get(hostId)
      if (host) {
        const resources = new Map(host.resources)
        const existing = resources.get(resourceId)
        const finalized = existing ? flushPendingOutput(existing) : undefined
        resources.set(resourceId, {
          type: event.resourceType,
          name: event.resourceName,
          status: event.status as ResourceState["status"],
          durationMs: event.durationMs,
          error: event.error,
          cacheHit: event.cacheHit,
          retries: finalized?.retries ?? [],
          output: finalized?.output ?? [],
          outputPending: { stdout: "", stderr: "" },
        })
        hosts.set(hostId, { ...host, resources })
      }
      return { ...state, hosts }
    }

    case "resource_retry": {
      const hostId = event.correlation.hostId
      const resourceId = event.correlation.resourceId
      if (!hostId || !resourceId) return state
      const hosts = new Map(state.hosts)
      const host = hosts.get(hostId)
      if (host) {
        const resources = new Map(host.resources)
        const existing = resources.get(resourceId)
        if (existing) {
          resources.set(resourceId, {
            ...existing,
            retries: [
              ...existing.retries,
              {
                attempt: event.correlation.attempt ?? 0,
                phase: event.phase,
                error: event.error.message,
              },
            ],
          })
          hosts.set(hostId, { ...host, resources })
        }
      }
      return { ...state, hosts }
    }

    case "resource_output": {
      const hostId = event.correlation.hostId
      const resourceId = event.correlation.resourceId
      if (!hostId || !resourceId) return state
      const hosts = new Map(state.hosts)
      const host = hosts.get(hostId)
      if (host) {
        const resources = new Map(host.resources)
        const existing = resources.get(resourceId)
        if (existing) {
          resources.set(resourceId, appendOutputChunk(existing, event.stream, event.chunk))
          hosts.set(hostId, { ...host, resources })
        }
      }
      return { ...state, hosts }
    }

    default:
      return state
  }
}
