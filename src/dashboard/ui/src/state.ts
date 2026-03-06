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

type CorrelationContext = {
  runId: string
  hostId?: string | undefined
  resourceId?: string | undefined
  attempt?: number | undefined
}

type BaseEvent = {
  type: string
  timestamp: string
  correlation: CorrelationContext
}

type HostInfo = {
  name: string
  hostname: string
}

type ResourceError = {
  message: string
  name: string
}

type ResourceOutputLine = {
  stream: "stdout" | "stderr"
  text: string
}

type OutputPending = {
  stdout: string
  stderr: string
}

type RunStartedEvent = BaseEvent & {
  type: "run_started"
  mode: "apply" | "check"
  errorMode: string
  hostCount: number
}

type RunFinishedEvent = BaseEvent & {
  type: "run_finished"
  durationMs: number
  hasFailures: boolean
  hostCount: number
}

type HostStartedEvent = BaseEvent & {
  type: "host_started"
  host: HostInfo
}

type HostFinishedEvent = BaseEvent & {
  type: "host_finished"
  host: HostInfo
  ok: number
  changed: number
  failed: number
  durationMs: number
  cancelled?: boolean | undefined
}

type ResourceStartedEvent = BaseEvent & {
  type: "resource_started"
  resourceType: string
  resourceName: string
}

type ResourceFinishedEvent = BaseEvent & {
  type: "resource_finished"
  resourceType: string
  resourceName: string
  status: string
  durationMs: number
  error?: ResourceError | undefined
  cacheHit?: boolean | undefined
}

type ResourceRetryEvent = BaseEvent & {
  type: "resource_retry"
  resourceType: string
  resourceName: string
  phase: string
  error: ResourceError
  durationMs: number
}

type ResourceOutputEvent = BaseEvent & {
  type: "resource_output"
  resourceType: string
  resourceName: string
  stream: "stdout" | "stderr"
  chunk: string
}

/** Wire-format lifecycle events consumed by the dashboard UI. */
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

/** Dashboard state for one resource row. */
export type ResourceState = {
  /** Resource type label. */
  type: string
  /** Resource display name. */
  name: string
  /** Latest resource lifecycle status. */
  status: "running" | "ok" | "changed" | "failed"
  /** Resource duration in milliseconds once finished. */
  durationMs?: number | undefined
  /** Structured resource error when the resource failed. */
  error?: ResourceError | undefined
  /** Whether the result came from the check cache. */
  cacheHit?: boolean | undefined
  /** Retry attempts recorded for this resource. */
  retries: Array<{ attempt: number; phase: string; error: string }>
  /** Flushed output lines collected so far. */
  output: ResourceOutputLine[]
  /** Buffered partial lines keyed by output stream. */
  outputPending: OutputPending
}

/** Dashboard state for one host card. */
export type HostState = {
  /** Host identity shown in the UI. */
  host: HostInfo
  /** Host lifecycle status. */
  status: "running" | "finished" | "cancelled"
  /** Resource rows keyed by correlation id. */
  resources: Map<string, ResourceState>
  /** Count of successful resources. */
  ok: number
  /** Count of changed resources. */
  changed: number
  /** Count of failed resources. */
  failed: number
  /** Host duration in milliseconds once finished. */
  durationMs?: number | undefined
  /** Whether the host stopped early due to cancellation. */
  cancelled?: boolean | undefined
}

/** Detailed run state for the active dashboard view. */
export type RunState = {
  /** Correlation id for the run. */
  id: string
  /** Execution mode used for the run. */
  mode: "apply" | "check"
  /** Error handling mode used by the run. */
  errorMode: string
  /** Number of targeted hosts. */
  hostCount: number
  /** ISO timestamp for when the run started. */
  startedAt: string
  /** ISO timestamp for when the run finished. */
  finishedAt?: string | undefined
  /** Run duration in milliseconds once finished. */
  durationMs?: number | undefined
  /** Whether any host failed in the run. */
  hasFailures?: boolean | undefined
}

/** Sidebar summary for a historical run. */
export type RunSummary = {
  /** Correlation id for the run. */
  id: string
  /** Execution mode label shown in the sidebar. */
  mode: string
  /** ISO timestamp for when the run started. */
  startedAt: string
  /** ISO timestamp for when the run finished. */
  finishedAt?: string | undefined
  /** Whether the run finished with failures. */
  hasFailures?: boolean | undefined
}

/** Root client-side dashboard state tree. */
export type DashboardState = {
  /** Historical runs shown in the sidebar. */
  runs: RunSummary[]
  /** Selected run id when browsing history. */
  activeRunId: string | null
  /** Active run details for the main pane. */
  run: RunState | null
  /** Host cards keyed by host correlation id. */
  hosts: Map<string, HostState>
}

/** Create the empty dashboard state used on first render and replay resets. */
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

/** Action that replays a historical run into the detail pane. */
export type SelectRunAction = {
  /** Action discriminator. */
  type: "SELECT_RUN"
  /** Run id to activate. */
  runId: string
  /** Full event stream for the selected run. */
  events: LifecycleEvent[]
}

/** Action that replaces the sidebar run history. */
export type SetRunsAction = {
  /** Action discriminator. */
  type: "SET_RUNS"
  /** Summaries to show in the run history sidebar. */
  runs: RunSummary[]
}

/** All reducer actions supported by the dashboard UI. */
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

/** Reduce lifecycle events and local UI actions into dashboard state. */
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
