import { test, expect } from "bun:test"
import { DashboardServer } from "../../src/dashboard/server.ts"
import type { RunSummary } from "../../src/dashboard/server.ts"
import type { LifecycleEvent, RunFinishedEvent, RunStartedEvent } from "../../src/output/events.ts"

interface FakeSocket {
  readonly data: { type: "consumer" | "producer" }
  readonly sent: string[]
  readyState: number
  send(data: string): void
  close(): void
}

interface ServeHarness {
  readonly deps: object
  readonly serverLike: {
    port: number
    stop(): void
    upgrade(req: Request, opts: { data: { type: "consumer" | "producer" } }): boolean
  }
  readonly upgradeCalls: Array<{ pathname: string; type: "consumer" | "producer" }>
  get stopCalls(): number
  get options(): {
    fetch: (
      req: Request,
      server: { upgrade(req: Request, opts: { data: { type: "consumer" | "producer" } }): boolean },
    ) => Response | Promise<Response> | undefined
    websocket: {
      open(ws: FakeSocket): void
      message(ws: FakeSocket, msg: string | Buffer): void
      close(ws: FakeSocket): void
    }
  }
}

function makeRunStartedEvent(runId = "test-run"): RunStartedEvent {
  return {
    type: "run_started",
    timestamp: new Date().toISOString(),
    correlation: { runId },
    mode: "apply",
    errorMode: "fail-fast",
    hostCount: 1,
  }
}

function makeRunFinishedEvent(runId: string): RunFinishedEvent {
  return {
    type: "run_finished",
    timestamp: new Date().toISOString(),
    correlation: { runId },
    durationMs: 10,
    hasFailures: false,
    hostCount: 1,
  }
}

function makeSocket(type: "consumer" | "producer"): FakeSocket {
  const sent: string[] = []
  return {
    data: { type },
    sent,
    readyState: 1,
    send(data: string): void {
      sent.push(data)
    },
    close(): void {
      this.readyState = 3
    },
  }
}

function createServeHarness(opts?: { upgradeResult?: boolean; port?: number }): ServeHarness {
  const upgradeResult = opts?.upgradeResult ?? true
  const port = opts?.port ?? 49090
  let stopCalls = 0
  const upgradeCalls: Array<{ pathname: string; type: "consumer" | "producer" }> = []
  let captured:
    | {
        fetch: (
          req: Request,
          server: {
            upgrade(req: Request, opts: { data: { type: "consumer" | "producer" } }): boolean
          },
        ) => Response | Promise<Response> | undefined
        websocket: {
          open(ws: FakeSocket): void
          message(ws: FakeSocket, msg: string | Buffer): void
          close(ws: FakeSocket): void
        }
      }
    | undefined

  const serverLike = {
    port,
    stop(): void {
      stopCalls++
    },
    upgrade(req: Request, upgradeOpts: { data: { type: "consumer" | "producer" } }): boolean {
      upgradeCalls.push({
        pathname: new URL(req.url).pathname,
        type: upgradeOpts.data.type,
      })
      return upgradeResult
    },
  }

  return {
    deps: {
      serve(options: unknown) {
        const o = options as {
          fetch: (
            req: Request,
            server: {
              upgrade(req: Request, opts: { data: { type: "consumer" | "producer" } }): boolean
            },
          ) => Response | Promise<Response> | undefined
          websocket: {
            open(ws: FakeSocket): void
            message(ws: FakeSocket, msg: string | Buffer): void
            close(ws: FakeSocket): void
          }
        }
        captured = {
          fetch: o.fetch,
          websocket: o.websocket,
        }
        return serverLike
      },
    },
    serverLike,
    upgradeCalls,
    get stopCalls(): number {
      return stopCalls
    },
    get options() {
      if (!captured) throw new Error("serve() was not called; did you start the server?")
      return captured
    },
  }
}

function assertResponse(res: Response | undefined): Response {
  if (!res) throw new Error("expected HTTP response")
  return res
}

test("DashboardServer — starts and stops without error", async () => {
  const harness = createServeHarness({ port: 49100 })
  const server = new DashboardServer({ port: 0, staticDir: null }, harness.deps)
  await server.start()
  expect(server.port).toEqual(49100)
  await server.shutdown()
  expect(harness.stopCalls).toEqual(1)
})

test("DashboardServer — /ws upgrades as consumer", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const res = await harness.options.fetch(new Request("http://dash.local/ws"), harness.serverLike)
  expect(res).toEqual(undefined)
  expect(harness.upgradeCalls.length).toEqual(1)
  expect(harness.upgradeCalls[0].pathname).toEqual("/ws")
  expect(harness.upgradeCalls[0].type).toEqual("consumer")
})

test("DashboardServer — /ws/push upgrades as producer", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const res = await harness.options.fetch(
    new Request("http://dash.local/ws/push"),
    harness.serverLike,
  )
  expect(res).toEqual(undefined)
  expect(harness.upgradeCalls.length).toEqual(1)
  expect(harness.upgradeCalls[0].pathname).toEqual("/ws/push")
  expect(harness.upgradeCalls[0].type).toEqual("producer")
})

test("DashboardServer — failed upgrade returns 400", async () => {
  const harness = createServeHarness({ upgradeResult: false })
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const res = await harness.options.fetch(new Request("http://dash.local/ws"), harness.serverLike)
  const response = assertResponse(res)
  expect(response.status).toEqual(400)
})

test("DashboardServer — /api/health returns ok", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const res = await harness.options.fetch(
    new Request("http://dash.local/api/health"),
    harness.serverLike,
  )
  const response = assertResponse(res)
  expect(response.status).toEqual(200)
  expect(await response.json()).toEqual({ status: "ok" })
})

test("DashboardServer — consumer replay gets existing run events", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  server.listener(makeRunStartedEvent("run-1"))
  const consumer = makeSocket("consumer")
  harness.options.websocket.open(consumer)

  expect(server.clientCount).toEqual(1)
  expect(consumer.sent.length).toEqual(1)
  expect((JSON.parse(consumer.sent[0]) as LifecycleEvent).type).toEqual("run_started")
})

test("DashboardServer — broadcasts lifecycle events to connected consumers", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const consumer = makeSocket("consumer")
  harness.options.websocket.open(consumer)
  server.listener(makeRunStartedEvent("run-broadcast"))

  expect(consumer.sent.length).toEqual(1)
  const msg = JSON.parse(consumer.sent[0]) as LifecycleEvent
  expect(msg.correlation.runId).toEqual("run-broadcast")
})

test("DashboardServer — producer messages are ingested and routed by runId", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const producer = makeSocket("producer")
  harness.options.websocket.open(producer)
  harness.options.websocket.message(producer, JSON.stringify(makeRunStartedEvent("push-run-1")))

  expect(server.producerCount).toEqual(1)
  expect(server.currentRun?.runId).toEqual("push-run-1")
})

test("DashboardServer — malformed producer messages are ignored", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const producer = makeSocket("producer")
  harness.options.websocket.open(producer)
  harness.options.websocket.message(producer, "{not-json")

  expect(server.currentRun).toEqual(null)
})

test("DashboardServer — websocket close updates client and producer counts", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const consumer = makeSocket("consumer")
  const producer = makeSocket("producer")
  harness.options.websocket.open(consumer)
  harness.options.websocket.open(producer)
  expect(server.clientCount).toEqual(1)
  expect(server.producerCount).toEqual(1)

  harness.options.websocket.close(consumer)
  harness.options.websocket.close(producer)
  expect(server.clientCount).toEqual(0)
  expect(server.producerCount).toEqual(0)
})

test("DashboardServer — /api/events returns current run buffer", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  server.listener(makeRunStartedEvent("run-events"))
  const res = await harness.options.fetch(
    new Request("http://dash.local/api/events"),
    harness.serverLike,
  )
  const response = assertResponse(res)
  const events = (await response.json()) as LifecycleEvent[]
  expect(events.length).toEqual(1)
  expect(events[0].correlation.runId).toEqual("run-events")
})

test("DashboardServer — /api/runs includes finished and active runs", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  server.listener(makeRunStartedEvent("run-1"))
  server.listener(makeRunFinishedEvent("run-1"))
  server.listener(makeRunStartedEvent("run-2"))

  const res = await harness.options.fetch(
    new Request("http://dash.local/api/runs"),
    harness.serverLike,
  )
  const response = assertResponse(res)
  const summaries = (await response.json()) as RunSummary[]
  expect(summaries.length).toEqual(2)
  expect(summaries[0].id).toEqual("run-1")
  expect(summaries[1].id).toEqual("run-2")
  expect(summaries[0].finishedAt !== undefined).toEqual(true)
  expect(summaries[1].finishedAt).toEqual(undefined)
})

test("DashboardServer — /api/runs/:runId/events returns 404 for unknown run", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null }, harness.deps)
  await server.start()

  const res = await harness.options.fetch(
    new Request("http://dash.local/api/runs/nope/events"),
    harness.serverLike,
  )
  const response = assertResponse(res)
  expect(response.status).toEqual(404)
})

test("DashboardServer — maxHistory trims old runs", async () => {
  const harness = createServeHarness()
  const server = new DashboardServer({ staticDir: null, maxHistory: 2 }, harness.deps)
  await server.start()

  server.listener(makeRunStartedEvent("run-1"))
  server.listener(makeRunFinishedEvent("run-1"))
  server.listener(makeRunStartedEvent("run-2"))
  server.listener(makeRunFinishedEvent("run-2"))
  server.listener(makeRunStartedEvent("run-3"))
  server.listener(makeRunFinishedEvent("run-3"))

  expect(server.runs.length).toEqual(2)
  expect(server.runs[0].runId).toEqual("run-2")
  expect(server.runs[1].runId).toEqual("run-3")
})
