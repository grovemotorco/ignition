import { test, expect } from "bun:test"
import { EventBus, EventReporter, generateId, NdjsonStream } from "../../src/output/events.ts"
import type {
  CorrelationId,
  HostFinishedEvent,
  HostStartedEvent,
  LifecycleEvent,
  ResourceFinishedEvent,
  ResourceRetryEvent,
  ResourceStartedEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "../../src/output/events.ts"
import { JsonFormatter } from "../../src/output/formats.ts"
import { runRecipe } from "../../src/core/runner.ts"
import { SSHConnectionError } from "../../src/core/errors.ts"
import type {
  ExecutionContext,
  HostContext,
  Reporter,
  ResourceResult,
} from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"
import { executeResource } from "../../src/core/resource.ts"
import type { ResourceDefinition } from "../../src/core/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubHost(name = "web-1", hostname = "10.0.1.10"): HostContext {
  return { name, hostname, user: "deploy", port: 22, vars: {} }
}

function stubConnection(
  overrides: Partial<{
    ping: () => Promise<boolean>
    close: () => Promise<void>
  }> = {},
): SSHConnection & { closeCalls: number } {
  const config: SSHConnectionConfig = {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    hostKeyPolicy: "strict",
  }
  const conn = {
    config,
    capabilities() {
      return ALL_TRANSPORT_CAPABILITIES
    },
    closeCalls: 0,
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: overrides.ping ?? (() => Promise.resolve(true)),
    close: () => {
      conn.closeCalls++
      return (overrides.close ?? (() => Promise.resolve()))()
    },
  }
  return conn
}

function noopReporter(): Reporter {
  return {
    resourceStart: () => {},
    resourceEnd: () => {},
  }
}

function collectEvents(bus: EventBus): LifecycleEvent[] {
  const events: LifecycleEvent[] = []
  bus.on((event) => events.push(event))
  return events
}

function fakeWriter(): { writer: { writeSync(p: Uint8Array): number }; output: () => string } {
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  return {
    writer: {
      writeSync(p: Uint8Array): number {
        chunks.push(new Uint8Array(p))
        return p.length
      },
    },
    output: () => decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c]))),
  }
}

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

test("generateId — produces 12-character hex string", () => {
  const id = generateId()
  expect(id.length).toEqual(12)
  expect(id).toMatch(/^[0-9a-f]{12}$/)
})

test("generateId — produces unique IDs", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateId()))
  expect(ids.size).toEqual(100)
})

// ---------------------------------------------------------------------------
// EventBus — basic mechanics
// ---------------------------------------------------------------------------

test("EventBus — assigns a runId", () => {
  const bus = new EventBus()
  expect(bus.runId.length).toEqual(12)
})

test("EventBus — accepts custom runId", () => {
  const bus = new EventBus("custom-run-id")
  expect(bus.runId).toEqual("custom-run-id")
})

test("EventBus — nextId increments", () => {
  const bus = new EventBus("run1")
  const id1 = bus.nextId()
  const id2 = bus.nextId()
  expect(id1).toEqual("run1-1")
  expect(id2).toEqual("run1-2")
})

test("EventBus — emits to all listeners", () => {
  const bus = new EventBus("run1")
  const events1: LifecycleEvent[] = []
  const events2: LifecycleEvent[] = []
  bus.on((e) => events1.push(e))
  bus.on((e) => events2.push(e))

  bus.runStarted("apply", "fail-fast", 2)

  expect(events1.length).toEqual(1)
  expect(events2.length).toEqual(1)
  expect(events1[0].type).toEqual("run_started")
})

test("EventBus — unsubscribe removes listener", () => {
  const bus = new EventBus("run1")
  const events: LifecycleEvent[] = []
  const unsub = bus.on((e) => events.push(e))

  bus.runStarted("apply", "fail-fast", 1)
  expect(events.length).toEqual(1)

  unsub()
  bus.runFinished(100, false, 1)
  expect(events.length).toEqual(1) // No new events after unsubscribe
})

// ---------------------------------------------------------------------------
// EventBus — convenience builders
// ---------------------------------------------------------------------------

test("EventBus — runStarted emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.runStarted("check", "fail-at-end", 3)

  expect(events.length).toEqual(1)
  const event = events[0] as RunStartedEvent
  expect(event.type).toEqual("run_started")
  expect(event.correlation.runId).toEqual("run1")
  expect(event.mode).toEqual("check")
  expect(event.errorMode).toEqual("fail-at-end")
  expect(event.hostCount).toEqual(3)
  expect(event.timestamp).toBeDefined()
})

test("EventBus — runFinished emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.runFinished(5000, true, 2)

  const event = events[0] as RunFinishedEvent
  expect(event.type).toEqual("run_finished")
  expect(event.durationMs).toEqual(5000)
  expect(event.hasFailures).toEqual(true)
  expect(event.hostCount).toEqual(2)
})

test("EventBus — hostStarted emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)
  const host = stubHost()

  bus.hostStarted("host-1", host)

  const event = events[0] as HostStartedEvent
  expect(event.type).toEqual("host_started")
  expect(event.correlation.runId).toEqual("run1")
  expect(event.correlation.hostId).toEqual("host-1")
  expect(event.host.name).toEqual("web-1")
})

test("EventBus — hostFinished emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)
  const host = stubHost()

  bus.hostFinished("host-1", host, { ok: 2, changed: 1, failed: 0, durationMs: 1500 })

  const event = events[0] as HostFinishedEvent
  expect(event.type).toEqual("host_finished")
  expect(event.ok).toEqual(2)
  expect(event.changed).toEqual(1)
  expect(event.failed).toEqual(0)
  expect(event.durationMs).toEqual(1500)
})

test("EventBus — resourceStarted emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.resourceStarted("host-1", "res-1", "apt", "nginx")

  const event = events[0] as ResourceStartedEvent
  expect(event.type).toEqual("resource_started")
  expect(event.correlation.runId).toEqual("run1")
  expect(event.correlation.hostId).toEqual("host-1")
  expect(event.correlation.resourceId).toEqual("res-1")
  expect(event.resourceType).toEqual("apt")
  expect(event.resourceName).toEqual("nginx")
})

test("EventBus — resourceFinished emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  const result: ResourceResult = {
    type: "apt",
    name: "nginx",
    status: "changed",
    durationMs: 200,
  }

  bus.resourceFinished("host-1", "res-1", result)

  const event = events[0] as ResourceFinishedEvent
  expect(event.type).toEqual("resource_finished")
  expect(event.status).toEqual("changed")
  expect(event.durationMs).toEqual(200)
  expect(event.error).toEqual(undefined)
})

test("EventBus — resourceFinished serializes error", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  const result: ResourceResult = {
    type: "apt",
    name: "nginx",
    status: "failed",
    error: new Error("install failed"),
    durationMs: 50,
  }

  bus.resourceFinished("host-1", "res-1", result)

  const event = events[0] as ResourceFinishedEvent
  expect(event.error?.message).toEqual("install failed")
  expect(event.error?.name).toEqual("Error")
})

test("EventBus — resourceRetry emits correct event", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.resourceRetry("host-1", "res-1", 2, "file", "/etc/motd", "check", new Error("timeout"), 150)

  const event = events[0] as ResourceRetryEvent
  expect(event.type).toEqual("resource_retry")
  expect(event.correlation.attempt).toEqual(2)
  expect(event.phase).toEqual("check")
  expect(event.error.message).toEqual("timeout")
  expect(event.durationMs).toEqual(150)
})

// ---------------------------------------------------------------------------
// EventReporter — bridges events to Reporter interface
// ---------------------------------------------------------------------------

test("EventReporter — emits resource_started and resource_finished events", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)
  const reporter = new EventReporter(bus, "host-1")

  reporter.resourceStart("apt", "nginx")
  reporter.resourceEnd({
    type: "apt",
    name: "nginx",
    status: "ok",
    durationMs: 100,
  })

  expect(events.length).toEqual(2)
  expect(events[0].type).toEqual("resource_started")
  expect(events[1].type).toEqual("resource_finished")
})

test("EventReporter — delegates to wrapped reporter", () => {
  const bus = new EventBus("run1")
  const calls: string[] = []
  const delegate = {
    resourceStart(type: string, name: string) {
      calls.push(`start:${type}:${name}`)
    },
    resourceEnd(result: ResourceResult) {
      calls.push(`end:${result.type}:${result.name}`)
    },
  }

  const reporter = new EventReporter(bus, "host-1", delegate)

  reporter.resourceStart("file", "/etc/motd")
  reporter.resourceEnd({
    type: "file",
    name: "/etc/motd",
    status: "changed",
    durationMs: 50,
  })

  expect(calls).toEqual(["start:file:/etc/motd", "end:file:/etc/motd"])
})

test("EventReporter — pairs resourceId across start/end", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)
  const reporter = new EventReporter(bus, "host-1")

  reporter.resourceStart("apt", "nginx")
  reporter.resourceEnd({
    type: "apt",
    name: "nginx",
    status: "ok",
    durationMs: 100,
  })

  const startEvent = events[0] as ResourceStartedEvent
  const endEvent = events[1] as ResourceFinishedEvent
  expect(startEvent.correlation.resourceId).toEqual(endEvent.correlation.resourceId)
})

test("EventReporter — exposes bus and hostId", () => {
  const bus = new EventBus("run1")
  const reporter = new EventReporter(bus, "host-1")

  expect(reporter.bus).toEqual(bus)
  expect(reporter.hostId).toEqual("host-1")
})

// ---------------------------------------------------------------------------
// NdjsonStream
// ---------------------------------------------------------------------------

test("NdjsonStream — writes one JSON line per event", () => {
  const { writer, output } = fakeWriter()
  const stream = new NdjsonStream(writer)
  const bus = new EventBus("run1")
  bus.on(stream.listener)

  bus.runStarted("apply", "fail-fast", 1)
  bus.runFinished(100, false, 1)

  const lines = output().trim().split("\n")
  expect(lines.length).toEqual(2)

  const event1 = JSON.parse(lines[0])
  expect(event1.type).toEqual("run_started")
  expect(event1.correlation.runId).toEqual("run1")

  const event2 = JSON.parse(lines[1])
  expect(event2.type).toEqual("run_finished")
})

test("NdjsonStream — each line is valid JSON", () => {
  const { writer, output } = fakeWriter()
  const stream = new NdjsonStream(writer)
  const bus = new EventBus("run1")
  bus.on(stream.listener)

  const host = stubHost()
  bus.hostStarted("h1", host)
  bus.resourceStarted("h1", "r1", "apt", "nginx")
  bus.resourceFinished("h1", "r1", { type: "apt", name: "nginx", status: "ok", durationMs: 50 })
  bus.hostFinished("h1", host, { ok: 1, changed: 0, failed: 0, durationMs: 100 })

  const lines = output().trim().split("\n")
  expect(lines.length).toEqual(4)

  // All lines must parse without error
  for (const line of lines) {
    const parsed = JSON.parse(line)
    expect(parsed.type).toBeDefined()
    expect(parsed.timestamp).toBeDefined()
    expect(parsed.correlation).toBeDefined()
  }
})

// ---------------------------------------------------------------------------
// JsonFormatter — formatEvent
// ---------------------------------------------------------------------------

test("JsonFormatter — formatEvent produces valid JSON", () => {
  const formatter = new JsonFormatter()
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.runStarted("apply", "fail-fast", 2)

  const json = formatter.formatEvent(events[0])
  const parsed = JSON.parse(json)
  expect(parsed.type).toEqual("run_started")
  expect(parsed.correlation.runId).toEqual("run1")
})

// ---------------------------------------------------------------------------
// Integration — runner emits events
// ---------------------------------------------------------------------------

test("runner emits run_started and run_finished events", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const types = events.map((e) => e.type)
  expect(types[0]).toEqual("run_started")
  expect(types[types.length - 1]).toEqual("run_finished")
})

test("runner emits host_started and host_finished events", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const hostEvents = events.filter((e) => e.type === "host_started" || e.type === "host_finished")
  expect(hostEvents.length).toEqual(2)
  expect(hostEvents[0].type).toEqual("host_started")
  expect(hostEvents[1].type).toEqual("host_finished")
})

test("runner emits events with consistent runId", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  for (const event of events) {
    expect(event.correlation.runId).toEqual("test-run")
  }
})

test("runner emits resource events via EventReporter", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName: (input) => input.pkg,
    check: () =>
      Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "ok",
      }),
    apply: () => Promise.resolve("applied"),
  }

  await runRecipe({
    recipe: async (ctx) => {
      await executeResource(ctx, def, { pkg: "nginx" })
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const types = events.map((e) => e.type)
  expect(types.includes("resource_started")).toEqual(true)
  expect(types.includes("resource_finished")).toEqual(true)

  // resource events should have hostId
  const resStarted = events.find((e) => e.type === "resource_started") as ResourceStartedEvent
  expect(resStarted.correlation.hostId).toBeDefined()
  expect(resStarted.correlation.resourceId).toBeDefined()
})

test("runner emits resource_retry events via EventReporter", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)
  let checkCalls = 0

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "retry-test",
    formatName: (input) => input.pkg,
    check: () => {
      checkCalls++
      if (checkCalls === 1) {
        return Promise.reject(new SSHConnectionError("10.0.1.10", "transient"))
      }
      return Promise.resolve({
        inDesiredState: true,
        current: { installed: true },
        desired: { installed: true },
        output: "ok",
      })
    },
    apply: () => Promise.resolve("applied"),
  }

  await runRecipe({
    recipe: async (ctx) => {
      await executeResource(
        ctx,
        def,
        { pkg: "nginx" },
        { retries: 1, retryDelayMs: 0, timeoutMs: 0 },
      )
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const retryEvents = events.filter((e) => e.type === "resource_retry") as ResourceRetryEvent[]
  expect(retryEvents.length).toEqual(1)
  expect(retryEvents[0].resourceType).toEqual("retry-test")
  expect(retryEvents[0].resourceName).toEqual("nginx")
  expect(retryEvents[0].phase).toEqual("check")
  expect(retryEvents[0].correlation.attempt).toEqual(1)
})

// ---------------------------------------------------------------------------
// Event ordering under concurrency
// ---------------------------------------------------------------------------

test("event ordering — run_started is first, run_finished is last", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("web-2", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
    concurrency: { parallelism: 2 },
  })

  expect(events[0].type).toEqual("run_started")
  expect(events[events.length - 1].type).toEqual("run_finished")
})

test("event ordering — each host has started before finished", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("web-2", "10.0.1.2"), connection: stubConnection() },
      { host: stubHost("web-3", "10.0.1.3"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
    concurrency: { parallelism: 3 },
  })

  // Find all host events and verify ordering per hostId
  const hostEvents = events.filter((e) => e.type === "host_started" || e.type === "host_finished")

  // Group by hostId
  const byHost = new Map<CorrelationId, LifecycleEvent[]>()
  for (const e of hostEvents) {
    const hostId = e.correlation.hostId!
    if (!byHost.has(hostId)) byHost.set(hostId, [])
    byHost.get(hostId)!.push(e)
  }

  // Each host should have started before finished
  for (const [_hostId, hostEvts] of byHost) {
    expect(hostEvts.length).toEqual(2)
    expect(hostEvts[0].type).toEqual("host_started")
    expect(hostEvts[1].type).toEqual("host_finished")
  }
})

test("event ordering — resource events are between host start and finish", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName: (input) => input.pkg,
    check: () =>
      Promise.resolve({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      }),
    apply: () => Promise.resolve("done"),
  }

  await runRecipe({
    recipe: async (ctx) => {
      await executeResource(ctx, def, { pkg: "curl" })
      await executeResource(ctx, def, { pkg: "nginx" })
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const types = events.map((e) => e.type)

  // run_started -> host_started -> resource events -> host_finished -> run_finished
  const hostStartIdx = types.indexOf("host_started")
  const hostFinishIdx = types.indexOf("host_finished")
  const firstResIdx = types.indexOf("resource_started")
  const lastResIdx = types.lastIndexOf("resource_finished")

  expect(hostStartIdx < firstResIdx).toEqual(true)
  expect(lastResIdx < hostFinishIdx).toEqual(true)
})

test("event ordering — concurrent hosts all have valid event sequences", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)
  const resolvers: Array<() => void> = []

  const recipe = (_ctx: ExecutionContext): Promise<void> => {
    return new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })
  }

  const hosts = [
    { host: stubHost("host-a", "10.0.1.1"), connection: stubConnection() },
    { host: stubHost("host-b", "10.0.1.2"), connection: stubConnection() },
    { host: stubHost("host-c", "10.0.1.3"), connection: stubConnection() },
  ]

  const promise = runRecipe({
    recipe,
    hosts,
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
    concurrency: { parallelism: 3 },
  })

  // Wait for all hosts to start
  await new Promise((r) => setTimeout(r, 20))

  // Resolve in reverse order
  for (let i = resolvers.length - 1; i >= 0; i--) {
    resolvers[i]()
    await new Promise((r) => setTimeout(r, 5))
  }

  await promise

  // Every host_started must come before its host_finished
  const hostStartIndices = new Map<string, number>()
  const hostFinishIndices = new Map<string, number>()

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.type === "host_started") {
      hostStartIndices.set(e.correlation.hostId!, i)
    } else if (e.type === "host_finished") {
      hostFinishIndices.set(e.correlation.hostId!, i)
    }
  }

  for (const [hostId, startIdx] of hostStartIndices) {
    const finishIdx = hostFinishIndices.get(hostId)
    expect(finishIdx).toBeDefined()
    expect(startIdx < finishIdx!).toEqual(true)
  }
})

// ---------------------------------------------------------------------------
// Event ordering — connection failure
// ---------------------------------------------------------------------------

test("connection failure host still emits host_started and host_finished", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [
      {
        host: stubHost(),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const types = events.map((e) => e.type)
  expect(types.includes("host_started")).toEqual(true)
  expect(types.includes("host_finished")).toEqual(true)

  const finished = events.find((e) => e.type === "host_finished") as HostFinishedEvent
  expect(finished.failed).toEqual(1)
})

// ---------------------------------------------------------------------------
// Event ordering — fail-fast cancellation
// ---------------------------------------------------------------------------

test("fail-fast cancelled hosts still emit host events", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [
      {
        host: stubHost("fail-host", "10.0.1.1"),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
      {
        host: stubHost("queued-host", "10.0.1.2"),
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
    concurrency: { parallelism: 1 },
  })

  // Both hosts should have started/finished
  const hostStartedEvents = events.filter((e) => e.type === "host_started") as HostStartedEvent[]
  const hostFinishedEvents = events.filter((e) => e.type === "host_finished") as HostFinishedEvent[]

  expect(hostStartedEvents.length).toEqual(2)
  expect(hostFinishedEvents.length).toEqual(2)
})

// ---------------------------------------------------------------------------
// Event ordering — empty hosts
// ---------------------------------------------------------------------------

test("empty hosts list emits run_started and run_finished", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  expect(events.length).toEqual(2)
  expect(events[0].type).toEqual("run_started")
  expect(events[1].type).toEqual("run_finished")
  expect((events[0] as RunStartedEvent).hostCount).toEqual(0)
})

// ---------------------------------------------------------------------------
// Correlation IDs
// ---------------------------------------------------------------------------

test("correlation IDs — runId is consistent across all events", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName: (input) => input.pkg,
    check: () =>
      Promise.resolve({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      }),
    apply: () => Promise.resolve("ok"),
  }

  await runRecipe({
    recipe: async (ctx) => {
      await executeResource(ctx, def, { pkg: "nginx" })
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  for (const event of events) {
    expect(event.correlation.runId).toEqual("test-run")
  }
})

test("correlation IDs — hostId is consistent for a host lifecycle", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const hostStarted = events.find((e) => e.type === "host_started") as HostStartedEvent
  const hostFinished = events.find((e) => e.type === "host_finished") as HostFinishedEvent

  expect(hostStarted.correlation.hostId).toEqual(hostFinished.correlation.hostId)
})

test("correlation IDs — different hosts get different hostIds", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("web-2", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const hostStartedEvents = events.filter((e) => e.type === "host_started") as HostStartedEvent[]
  const hostIds = hostStartedEvents.map((e) => e.correlation.hostId)
  expect(new Set(hostIds).size).toEqual(2) // unique IDs
})

test("correlation IDs — resourceId pairs start and finish", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName: (input) => input.pkg,
    check: () =>
      Promise.resolve({
        inDesiredState: false,
        current: {},
        desired: {},
      }),
    apply: () => Promise.resolve("done"),
  }

  await runRecipe({
    recipe: async (ctx) => {
      await executeResource(ctx, def, { pkg: "curl" })
      await executeResource(ctx, def, { pkg: "nginx" })
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const resStarted = events.filter((e) => e.type === "resource_started") as ResourceStartedEvent[]
  const resFinished = events.filter(
    (e) => e.type === "resource_finished",
  ) as ResourceFinishedEvent[]

  expect(resStarted.length).toEqual(2)
  expect(resFinished.length).toEqual(2)

  // First resource pair
  expect(resStarted[0].correlation.resourceId).toEqual(resFinished[0].correlation.resourceId)
  // Second resource pair
  expect(resStarted[1].correlation.resourceId).toEqual(resFinished[1].correlation.resourceId)
  // Different resources get different IDs
  expect(resStarted[0].correlation.resourceId !== resStarted[1].correlation.resourceId).toEqual(
    true,
  )
})

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test("events have ISO-8601 timestamps", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  for (const event of events) {
    // ISO-8601 should parse to a valid date
    const date = new Date(event.timestamp)
    expect(isNaN(date.getTime())).toEqual(false)
  }
})

// ---------------------------------------------------------------------------
// No event bus — backward compatibility
// ---------------------------------------------------------------------------

test("runner works without eventBus (backward compatible)", async () => {
  const result = await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hasFailures).toEqual(false)
})

// ---------------------------------------------------------------------------
// NDJSON integration with runner
// ---------------------------------------------------------------------------

test("NDJSON stream captures full run lifecycle", async () => {
  const { writer, output } = fakeWriter()
  const bus = new EventBus("test-run")
  const stream = new NdjsonStream(writer)
  bus.on(stream.listener)

  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "test",
    formatName: (input) => input.pkg,
    check: () =>
      Promise.resolve({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "ok",
      }),
    apply: () => Promise.resolve("ok"),
  }

  await runRecipe({
    recipe: async (ctx) => {
      await executeResource(ctx, def, { pkg: "nginx" })
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const lines = output().trim().split("\n")
  const eventTypes = lines.map((l) => JSON.parse(l).type)

  expect(eventTypes[0]).toEqual("run_started")
  expect(eventTypes.includes("host_started")).toEqual(true)
  expect(eventTypes.includes("resource_started")).toEqual(true)
  expect(eventTypes.includes("resource_finished")).toEqual(true)
  expect(eventTypes.includes("host_finished")).toEqual(true)
  expect(eventTypes[eventTypes.length - 1]).toEqual("run_finished")
})

// ---------------------------------------------------------------------------
// RunStartedEvent — mode and errorMode fields
// ---------------------------------------------------------------------------

test("run_started event includes mode and errorMode", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "check",
    errorMode: "ignore",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const started = events[0] as RunStartedEvent
  expect(started.mode).toEqual("check")
  expect(started.errorMode).toEqual("ignore")
})

// ---------------------------------------------------------------------------
// RunFinishedEvent — aggregation correctness
// ---------------------------------------------------------------------------

test("run_finished event reflects failure state", async () => {
  const bus = new EventBus("test-run")
  const events = collectEvents(bus)

  await runRecipe({
    recipe: () => Promise.resolve(),
    hosts: [
      {
        host: stubHost(),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    eventBus: bus,
  })

  const finished = events.find((e) => e.type === "run_finished") as RunFinishedEvent
  expect(finished.hasFailures).toEqual(true)
})
