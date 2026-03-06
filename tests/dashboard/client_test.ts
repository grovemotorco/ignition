import { test, expect } from "bun:test"
import { DashboardClient } from "../../src/dashboard/client.ts"
import type { LifecycleEvent } from "../../src/output/events.ts"

type EventName = "open" | "error" | "close"
type EventListener = (event: Event | ErrorEvent) => void

class FakeWebSocket {
  url: string
  readyState = 0
  sent: string[] = []
  closeCalls = 0
  #listeners = new Map<EventName, Array<{ fn: EventListener; once: boolean }>>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: EventName, listener: EventListener, opts?: { once?: boolean }): void {
    const arr = this.#listeners.get(type) ?? []
    arr.push({ fn: listener, once: opts?.once ?? false })
    this.#listeners.set(type, arr)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCalls++
    this.readyState = 2
    this.emit("close", new Event("close"))
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.emit("open", new Event("open"))
  }

  error(err?: Error): void {
    const event = new ErrorEvent("error", { error: err ?? new Error("ws error") })
    this.emit("error", event)
  }

  emit(type: EventName, event: Event | ErrorEvent): void {
    const arr = this.#listeners.get(type) ?? []
    this.#listeners.set(
      type,
      arr.filter((entry) => !entry.once),
    )
    for (const entry of arr) entry.fn(event)
  }
}

function sampleRunStartedEvent(runId = "client-test-run"): LifecycleEvent {
  return {
    type: "run_started",
    timestamp: new Date().toISOString(),
    correlation: { runId },
    mode: "apply",
    errorMode: "fail-fast",
    hostCount: 1,
  }
}

function assertWs(ws: FakeWebSocket | undefined): FakeWebSocket {
  if (!ws) throw new Error("expected websocket to be created")
  return ws
}

test("DashboardClient.probe — returns true when fetch returns 200", async () => {
  const result = await DashboardClient.probe(
    "127.0.0.1",
    9090,
    500,
    async () => new Response("ok", { status: 200 }),
  )
  expect(result).toEqual(true)
})

test("DashboardClient.probe — returns false when fetch errors", async () => {
  const result = await DashboardClient.probe("127.0.0.1", 9090, 500, async () => {
    throw new Error("offline")
  })
  expect(result).toEqual(false)
})

test("DashboardClient.probe — returns false on non-2xx response", async () => {
  const result = await DashboardClient.probe(
    "127.0.0.1",
    9090,
    500,
    async () => new Response("nope", { status: 503 }),
  )
  expect(result).toEqual(false)
})

test("DashboardClient — connect resolves on open and listener sends events", async () => {
  let ws: FakeWebSocket | undefined
  const client = new DashboardClient("ws://dash.local/ws/push", {
    createWebSocket(url: string) {
      ws = new FakeWebSocket(url)
      return ws
    },
  })

  const connecting = client.connect()
  const socket = assertWs(ws)
  socket.open()
  await connecting

  client.listener(sampleRunStartedEvent("run-42"))
  expect(socket.sent.length).toEqual(1)
  const payload = JSON.parse(socket.sent[0]) as LifecycleEvent
  expect(payload.correlation.runId).toEqual("run-42")
})

test("DashboardClient — connect rejects on websocket error", async () => {
  let ws: FakeWebSocket | undefined
  const client = new DashboardClient("ws://dash.local/ws/push", {
    createWebSocket(url: string) {
      ws = new FakeWebSocket(url)
      return ws
    },
  })

  const connecting = client.connect()
  const socket = assertWs(ws)
  socket.error(new Error("connect failed"))
  let rejected = false
  try {
    await connecting
  } catch {
    rejected = true
  }
  expect(rejected).toEqual(true)
})

test("DashboardClient — listener silently drops events when not connected", () => {
  const client = new DashboardClient("ws://dash.local/ws/push", {
    createWebSocket(url: string) {
      return new FakeWebSocket(url)
    },
  })
  client.listener(sampleRunStartedEvent("drop"))
})

test("DashboardClient — close is idempotent", async () => {
  let ws: FakeWebSocket | undefined
  const client = new DashboardClient("ws://dash.local/ws/push", {
    createWebSocket(url: string) {
      ws = new FakeWebSocket(url)
      return ws
    },
  })

  const connecting = client.connect()
  const socket = assertWs(ws)
  socket.open()
  await connecting

  await client.close()
  await client.close()

  expect(socket.closeCalls).toEqual(1)
})
