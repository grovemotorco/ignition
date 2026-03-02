import { test, expect } from "bun:test"
import { EventBus } from "../../src/output/events.ts"

test("EventBus no longer exposes worker lifecycle helpers", () => {
  const bus = new EventBus("run1")
  expect("workerStarted" in (bus as unknown as Record<string, unknown>)).toEqual(false)
  expect("workerFailed" in (bus as unknown as Record<string, unknown>)).toEqual(false)
  expect("workerFinished" in (bus as unknown as Record<string, unknown>)).toEqual(false)
})

test("lifecycle stream has no worker_* event types", () => {
  const bus = new EventBus("run1")
  const types: string[] = []
  bus.on((event) => types.push(event.type))
  bus.runStarted("check", "fail-fast", 0)
  bus.runFinished(1, false, 0)
  expect(types.some((t) => t.startsWith("worker_"))).toEqual(false)
})
