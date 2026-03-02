import { test, expect } from "bun:test"
import { EventBus, EventReporter } from "../../src/output/events.ts"
import type { LifecycleEvent, ResourceOutputEvent } from "../../src/output/events.ts"
import type { ResourceResult } from "../../src/core/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function collectEvents(bus: EventBus): LifecycleEvent[] {
  const events: LifecycleEvent[] = []
  bus.on((event) => events.push(event))
  return events
}

// ---------------------------------------------------------------------------
// EventBus.resourceOutput()
// ---------------------------------------------------------------------------

test("EventBus.resourceOutput — emits correct event shape", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.resourceOutput(
    "host-1",
    "res-1",
    "exec",
    "apt install nginx",
    "stdout",
    "Reading package lists...\n",
  )

  expect(events.length).toEqual(1)
  const event = events[0] as ResourceOutputEvent
  expect(event.type).toEqual("resource_output")
  expect(event.correlation.runId).toEqual("run1")
  expect(event.correlation.hostId).toEqual("host-1")
  expect(event.correlation.resourceId).toEqual("res-1")
  expect(event.resourceType).toEqual("exec")
  expect(event.resourceName).toEqual("apt install nginx")
  expect(event.stream).toEqual("stdout")
  expect(event.chunk).toEqual("Reading package lists...\n")
  expect(event.timestamp).toBeDefined()
})

test("EventBus.resourceOutput — stderr stream", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)

  bus.resourceOutput(
    "host-1",
    "res-1",
    "exec",
    "make build",
    "stderr",
    "warning: unused variable\n",
  )

  const event = events[0] as ResourceOutputEvent
  expect(event.stream).toEqual("stderr")
  expect(event.chunk).toEqual("warning: unused variable\n")
})

// ---------------------------------------------------------------------------
// EventReporter.resourceOutput()
// ---------------------------------------------------------------------------

test("EventReporter.resourceOutput — emits event to bus", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)
  const reporter = new EventReporter(bus, "host-1")

  reporter.resourceStart("exec", "whoami")
  reporter.resourceOutput("exec", "whoami", "stdout", "root\n")

  const outputEvents = events.filter((e) => e.type === "resource_output") as ResourceOutputEvent[]
  expect(outputEvents.length).toEqual(1)
  expect(outputEvents[0].resourceType).toEqual("exec")
  expect(outputEvents[0].resourceName).toEqual("whoami")
  expect(outputEvents[0].stream).toEqual("stdout")
  expect(outputEvents[0].chunk).toEqual("root\n")
})

test("EventReporter.resourceOutput — delegates to wrapped reporter", () => {
  const bus = new EventBus("run1")
  const outputCalls: Array<{ type: string; name: string; stream: string; chunk: string }> = []
  const delegate = {
    resourceStart() {},
    resourceEnd(_result: ResourceResult) {},
    resourceOutput(type: string, name: string, stream: "stdout" | "stderr", chunk: string) {
      outputCalls.push({ type, name, stream, chunk })
    },
  }

  const reporter = new EventReporter(bus, "host-1", delegate)
  reporter.resourceStart("file", "/etc/motd")
  reporter.resourceOutput("file", "/etc/motd", "stderr", "permission warning\n")

  expect(outputCalls.length).toEqual(1)
  expect(outputCalls[0]).toEqual({
    type: "file",
    name: "/etc/motd",
    stream: "stderr",
    chunk: "permission warning\n",
  })
})

test("EventReporter.resourceOutput — uses current resourceId for correlation", () => {
  const bus = new EventBus("run1")
  const events = collectEvents(bus)
  const reporter = new EventReporter(bus, "host-1")

  reporter.resourceStart("exec", "cmd1")
  reporter.resourceOutput("exec", "cmd1", "stdout", "output1\n")
  reporter.resourceEnd({ type: "exec", name: "cmd1", status: "ok", durationMs: 10 })

  const startEvent = events.find((e) => e.type === "resource_started")!
  const outputEvent = events.find((e) => e.type === "resource_output")!
  expect(startEvent.correlation.resourceId).toEqual(outputEvent.correlation.resourceId)
})
