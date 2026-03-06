import { test, expect } from "bun:test"
import {
  createInitialState,
  eventReducer,
  type LifecycleEvent,
  type RunSummary,
} from "../../src/dashboard/ui/src/state.ts"

function runStarted(runId: string, timestamp: string): LifecycleEvent {
  return {
    type: "run_started",
    timestamp,
    correlation: { runId },
    mode: "apply",
    errorMode: "fail-fast",
    hostCount: 1,
  }
}

function runFinished(runId: string, timestamp: string, hasFailures = false): LifecycleEvent {
  return {
    type: "run_finished",
    timestamp,
    correlation: { runId },
    durationMs: 1000,
    hasFailures,
    hostCount: 1,
  }
}

function hostStarted(runId: string, hostId: string, timestamp: string): LifecycleEvent {
  return {
    type: "host_started",
    timestamp,
    correlation: { runId, hostId },
    host: { name: hostId, hostname: `${hostId}.example` },
  }
}

test("eventReducer — selected historical run ignores foreign live host events", () => {
  const runs: RunSummary[] = [
    {
      id: "run-a",
      mode: "apply",
      startedAt: "2026-02-08T00:00:00.000Z",
      finishedAt: "2026-02-08T00:01:00.000Z",
      hasFailures: false,
    },
    {
      id: "run-b",
      mode: "apply",
      startedAt: "2026-02-08T00:02:00.000Z",
    },
  ]

  let state = createInitialState()
  state = eventReducer(state, { type: "SET_RUNS", runs })
  state = eventReducer(state, runStarted("run-b", "2026-02-08T00:02:00.000Z"))
  state = eventReducer(state, {
    type: "SELECT_RUN",
    runId: "run-a",
    events: [
      runStarted("run-a", "2026-02-08T00:00:00.000Z"),
      runFinished("run-a", "2026-02-08T00:01:00.000Z"),
    ],
  })

  state = eventReducer(state, hostStarted("run-b", "host-b", "2026-02-08T00:02:05.000Z"))

  expect(state.activeRunId).toEqual("run-a")
  expect(state.run?.id).toEqual("run-a")
  expect(state.hosts.size).toEqual(0)
})

test("eventReducer — foreign run completion updates sidebar while preserving selected run detail", () => {
  const runs: RunSummary[] = [
    {
      id: "run-a",
      mode: "apply",
      startedAt: "2026-02-08T00:00:00.000Z",
      finishedAt: "2026-02-08T00:01:00.000Z",
      hasFailures: false,
    },
    {
      id: "run-b",
      mode: "apply",
      startedAt: "2026-02-08T00:02:00.000Z",
    },
  ]

  let state = createInitialState()
  state = eventReducer(state, { type: "SET_RUNS", runs })
  state = eventReducer(state, runStarted("run-b", "2026-02-08T00:02:00.000Z"))
  state = eventReducer(state, {
    type: "SELECT_RUN",
    runId: "run-a",
    events: [
      runStarted("run-a", "2026-02-08T00:00:00.000Z"),
      runFinished("run-a", "2026-02-08T00:01:00.000Z"),
    ],
  })

  state = eventReducer(state, runFinished("run-b", "2026-02-08T00:03:00.000Z", true))

  expect(state.activeRunId).toEqual("run-a")
  expect(state.run?.id).toEqual("run-a")
  expect(state.run?.finishedAt).toEqual("2026-02-08T00:01:00.000Z")
  expect(state.run?.hasFailures).toEqual(false)

  const runB = state.runs.find((run) => run.id === "run-b")
  expect(runB?.finishedAt).toEqual("2026-02-08T00:03:00.000Z")
  expect(runB?.hasFailures).toEqual(true)
})

// ---------------------------------------------------------------------------
// resource_output events
// ---------------------------------------------------------------------------

function resourceStarted(
  runId: string,
  hostId: string,
  resourceId: string,
  timestamp: string,
): LifecycleEvent {
  return {
    type: "resource_started",
    timestamp,
    correlation: { runId, hostId, resourceId },
    resourceType: "exec",
    resourceName: "whoami",
  }
}

function resourceOutput(
  runId: string,
  hostId: string,
  resourceId: string,
  stream: "stdout" | "stderr",
  chunk: string,
  timestamp: string,
): LifecycleEvent {
  return {
    type: "resource_output",
    timestamp,
    correlation: { runId, hostId, resourceId },
    resourceType: "exec",
    resourceName: "whoami",
    stream,
    chunk,
  }
}

function resourceFinished(
  runId: string,
  hostId: string,
  resourceId: string,
  timestamp: string,
): LifecycleEvent {
  return {
    type: "resource_finished",
    timestamp,
    correlation: { runId, hostId, resourceId },
    resourceType: "exec",
    resourceName: "whoami",
    status: "changed",
    durationMs: 100,
  }
}

test("eventReducer — resource_output accumulates on correct resource", () => {
  let state = createInitialState()
  state = eventReducer(state, runStarted("run-1", "2026-02-08T00:00:00.000Z"))
  state = eventReducer(state, hostStarted("run-1", "host-1", "2026-02-08T00:00:01.000Z"))
  state = eventReducer(
    state,
    resourceStarted("run-1", "host-1", "res-1", "2026-02-08T00:00:02.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stdout", "line 1\n", "2026-02-08T00:00:03.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stderr", "warn\n", "2026-02-08T00:00:04.000Z"),
  )

  const host = state.hosts.get("host-1")!
  const resource = host.resources.get("res-1")!
  expect(resource.output.length).toEqual(2)
  expect(resource.output[0]).toEqual({ stream: "stdout", text: "line 1" })
  expect(resource.output[1]).toEqual({ stream: "stderr", text: "warn" })
})

test("eventReducer — output survives resource_finished", () => {
  let state = createInitialState()
  state = eventReducer(state, runStarted("run-1", "2026-02-08T00:00:00.000Z"))
  state = eventReducer(state, hostStarted("run-1", "host-1", "2026-02-08T00:00:01.000Z"))
  state = eventReducer(
    state,
    resourceStarted("run-1", "host-1", "res-1", "2026-02-08T00:00:02.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stdout", "output\n", "2026-02-08T00:00:03.000Z"),
  )
  state = eventReducer(
    state,
    resourceFinished("run-1", "host-1", "res-1", "2026-02-08T00:00:04.000Z"),
  )

  const host = state.hosts.get("host-1")!
  const resource = host.resources.get("res-1")!
  expect(resource.status).toEqual("changed")
  expect(resource.output.length).toEqual(1)
  expect(resource.output[0]).toEqual({ stream: "stdout", text: "output" })
})

test("eventReducer — resource_output works during replay (SELECT_RUN)", () => {
  const events: LifecycleEvent[] = [
    runStarted("run-1", "2026-02-08T00:00:00.000Z"),
    hostStarted("run-1", "host-1", "2026-02-08T00:00:01.000Z"),
    resourceStarted("run-1", "host-1", "res-1", "2026-02-08T00:00:02.000Z"),
    resourceOutput("run-1", "host-1", "res-1", "stdout", "replayed\n", "2026-02-08T00:00:03.000Z"),
    resourceFinished("run-1", "host-1", "res-1", "2026-02-08T00:00:04.000Z"),
    runFinished("run-1", "2026-02-08T00:00:05.000Z"),
  ]

  let state = createInitialState()
  state = eventReducer(state, {
    type: "SELECT_RUN",
    runId: "run-1",
    events,
  })

  const host = state.hosts.get("host-1")!
  const resource = host.resources.get("res-1")!
  expect(resource.output.length).toEqual(1)
  expect(resource.output[0]).toEqual({ stream: "stdout", text: "replayed" })
})

test("eventReducer — resource_output preserves stream-local partial lines", () => {
  let state = createInitialState()
  state = eventReducer(state, runStarted("run-1", "2026-02-08T00:00:00.000Z"))
  state = eventReducer(state, hostStarted("run-1", "host-1", "2026-02-08T00:00:01.000Z"))
  state = eventReducer(
    state,
    resourceStarted("run-1", "host-1", "res-1", "2026-02-08T00:00:02.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stdout", "hello ", "2026-02-08T00:00:03.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stderr", "warn ", "2026-02-08T00:00:04.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stdout", "world\n", "2026-02-08T00:00:05.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput("run-1", "host-1", "res-1", "stderr", "line\n", "2026-02-08T00:00:06.000Z"),
  )

  const host = state.hosts.get("host-1")!
  const resource = host.resources.get("res-1")!
  expect(resource.output).toEqual([
    { stream: "stdout", text: "hello world" },
    { stream: "stderr", text: "warn line" },
  ])
  expect(resource.outputPending).toEqual({ stdout: "", stderr: "" })
})

test("eventReducer — resource_finished flushes remaining partial output", () => {
  let state = createInitialState()
  state = eventReducer(state, runStarted("run-1", "2026-02-08T00:00:00.000Z"))
  state = eventReducer(state, hostStarted("run-1", "host-1", "2026-02-08T00:00:01.000Z"))
  state = eventReducer(
    state,
    resourceStarted("run-1", "host-1", "res-1", "2026-02-08T00:00:02.000Z"),
  )
  state = eventReducer(
    state,
    resourceOutput(
      "run-1",
      "host-1",
      "res-1",
      "stdout",
      "unterminated",
      "2026-02-08T00:00:03.000Z",
    ),
  )
  state = eventReducer(
    state,
    resourceFinished("run-1", "host-1", "res-1", "2026-02-08T00:00:04.000Z"),
  )

  const host = state.hosts.get("host-1")!
  const resource = host.resources.get("res-1")!
  expect(resource.output).toEqual([{ stream: "stdout", text: "unterminated" }])
  expect(resource.outputPending).toEqual({ stdout: "", stderr: "" })
})
