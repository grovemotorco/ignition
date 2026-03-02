/**
 * DashboardServer — WebSocket event broadcaster for real-time run monitoring.
 *
 * Manages HTTP serving, WebSocket upgrades, client tracking, event broadcasting,
 * and static file serving for the built React dashboard app. Consumes
 * LifecycleEvent objects via an EventListener-compatible handler registered
 * with EventBus.on(). Supports multi-run history and a `/ws/push` producer
 * endpoint for cross-process event streaming.
 *
 * See ISSUE-0024, specs/web-dashboard.md (WEB-001).
 */

import { join } from "node:path"
import type { ServerWebSocket } from "bun"
import type { EventListener, LifecycleEvent } from "../output/events.ts"
import { DASHBOARD_HTML } from "./assets.ts"

/** WebSocket data payload used to distinguish consumer vs producer sockets. */
interface WsData {
  readonly type: "consumer" | "producer"
}

interface ServerLike {
  readonly port?: number
  stop(): void
}

interface ServerLikeUpgradeTarget {
  upgrade(req: Request, opts: { data: WsData }): boolean
}

interface ServerSocketLike {
  readonly data: WsData
  readonly readyState: number
  send(data: string): void
  close(): void
}

interface ServerLikeWebsocketHandlers {
  open(ws: ServerSocketLike): void
  message(ws: ServerSocketLike, msg: string | Buffer): void
  close(ws: ServerSocketLike): void
}

interface ServerLikeOptions {
  readonly port: number
  readonly hostname: string
  readonly fetch: (
    req: Request,
    server: ServerLikeUpgradeTarget,
  ) => Response | Promise<Response> | undefined
  readonly websocket: ServerLikeWebsocketHandlers
}

type ServeLike = (opts: ServerLikeOptions) => ServerLike

/** Testability seam for injecting a custom `serve` implementation. */
export interface DashboardServerDeps {
  readonly serve: ServeLike
}

/** Configuration options for the dashboard server. */
export interface DashboardServerOptions {
  /** Port to listen on. Default: 9090. */
  readonly port: number
  /** Hostname to bind. Default: "127.0.0.1" (localhost only). */
  readonly hostname: string
  /**
   * Path to pre-built static files (React app dist/).
   * Set to null to disable static serving.
   */
  readonly staticDir: string | null
  /** Maximum number of completed runs to retain. Default: 10. */
  readonly maxHistory: number
}

/** A single recorded run with its events. */
export interface RunRecord {
  readonly runId: string
  readonly events: LifecycleEvent[]
  readonly startedAt: string
  finishedAt?: string
}

/** Summary of a run for the /api/runs listing. */
export interface RunSummary {
  readonly id: string
  readonly mode: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly hasFailures?: boolean
}

const MAX_EVENT_BUFFER = 10_000
const SOCKET_OPEN = 1

function defaultServe(opts: ServerLikeOptions): ServerLike {
  return Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.hostname,
    fetch: (req, server) => opts.fetch(req, server),
    websocket: {
      open: (ws: ServerWebSocket<WsData>) => opts.websocket.open(ws),
      message: (ws: ServerWebSocket<WsData>, msg: string | Buffer) =>
        opts.websocket.message(ws, msg),
      close: (ws: ServerWebSocket<WsData>) => opts.websocket.close(ws),
    },
  })
}

/** Map file extensions to MIME types. */
function contentType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8"
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8"
    case "css":
      return "text/css; charset=utf-8"
    case "json":
      return "application/json; charset=utf-8"
    case "svg":
      return "image/svg+xml"
    case "png":
      return "image/png"
    case "ico":
      return "image/x-icon"
    case "woff2":
      return "font/woff2"
    case "woff":
      return "font/woff"
    default:
      return "application/octet-stream"
  }
}

/**
 * HTTP + WebSocket server that broadcasts LifecycleEvent objects to connected
 * browser clients. Register `server.listener` with `EventBus.on()` to stream
 * run telemetry in real time.
 *
 * Supports multi-run history via `/api/runs` and cross-process event push
 * via `/ws/push`.
 *
 * ```ts
 * const dashboard = new DashboardServer({ port: 9090 })
 * await dashboard.start()
 * const unsubscribe = eventBus.on(dashboard.listener)
 * ```
 */
export class DashboardServer {
  #server: ServerLike | null = null
  #clients: Set<ServerSocketLike> = new Set()
  #producers: Set<ServerSocketLike> = new Set()
  #runs: RunRecord[] = []
  #activeRuns: Map<string, RunRecord> = new Map()
  #opts: Required<DashboardServerOptions>
  #deps: DashboardServerDeps
  #serveEmbeddedFallback: boolean
  #port = 0

  constructor(opts?: Partial<DashboardServerOptions>, deps?: Partial<DashboardServerDeps>) {
    // Distinguish omitted staticDir (serve embedded fallback) from explicit null (disable static routes).
    this.#serveEmbeddedFallback = opts?.staticDir === undefined
    this.#opts = {
      port: opts?.port ?? 9090,
      hostname: opts?.hostname ?? "127.0.0.1",
      staticDir: opts?.staticDir === undefined ? null : opts.staticDir,
      maxHistory: opts?.maxHistory ?? 10,
    }
    this.#deps = {
      serve: deps?.serve ?? defaultServe,
    }
  }

  /** EventListener-compatible handler. Register with EventBus.on(). */
  readonly listener: EventListener = (event: LifecycleEvent): void => {
    this.#ingestEvent(event)
  }

  /** Start the HTTP/WebSocket server. Resolves when the server is listening. */
  async start(): Promise<void> {
    this.#server = this.#deps.serve({
      port: this.#opts.port,
      hostname: this.#opts.hostname,
      fetch: (req: Request, server: ServerLikeUpgradeTarget) => {
        const url = new URL(req.url)

        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: { type: "consumer" as const } })) {
            return undefined
          }
          return new Response("WebSocket upgrade failed", { status: 400 })
        }

        if (url.pathname === "/ws/push") {
          if (server.upgrade(req, { data: { type: "producer" as const } })) {
            return undefined
          }
          return new Response("WebSocket upgrade failed", { status: 400 })
        }

        return this.#handleRequest(url, req)
      },
      websocket: {
        open: (ws: ServerSocketLike) => {
          if (ws.data.type === "consumer") {
            this.#clients.add(ws)
            // Replay one run (latest active, or latest finished) for backward compatibility.
            for (const event of this.#replayEvents()) {
              ws.send(JSON.stringify(event))
            }
          } else {
            this.#producers.add(ws)
          }
        },
        message: (ws: ServerSocketLike, msg: string | Buffer) => {
          if (ws.data.type === "producer") {
            try {
              const event: LifecycleEvent = JSON.parse(
                typeof msg === "string" ? msg : msg.toString(),
              )
              this.#ingestEvent(event)
            } catch {
              // Ignore malformed messages
            }
          }
        },
        close: (ws: ServerSocketLike) => {
          if (ws.data.type === "consumer") {
            this.#clients.delete(ws)
          } else {
            this.#producers.delete(ws)
          }
        },
      },
    })
    this.#port = this.#server.port ?? this.#opts.port
  }

  /** The effective bound port (useful when configured with `port: 0`). */
  get port(): number {
    return this.#port
  }

  /** Number of currently connected WebSocket consumer clients. */
  get clientCount(): number {
    return this.#clients.size
  }

  /** Number of currently connected WebSocket producer clients. */
  get producerCount(): number {
    return this.#producers.size
  }

  /** Completed run history (most recent last). */
  get runs(): readonly RunRecord[] {
    return this.#runs
  }

  /** The most recently started in-progress run, if any. */
  get currentRun(): RunRecord | null {
    let latest: RunRecord | null = null
    for (const run of this.#activeRuns.values()) {
      latest = run
    }
    return latest
  }

  /** Gracefully shut down the server and close all connections. */
  async shutdown(): Promise<void> {
    for (const ws of this.#clients) {
      try {
        ws.close()
      } catch {
        // already closed
      }
    }
    for (const ws of this.#producers) {
      try {
        ws.close()
      } catch {
        // already closed
      }
    }
    this.#clients.clear()
    this.#producers.clear()
    this.#activeRuns.clear()
    if (this.#server) {
      this.#server.stop()
      this.#server = null
    }
  }

  /** Process an incoming event: route by runId, store, archive, and broadcast. */
  #ingestEvent(event: LifecycleEvent): void {
    const runId = event.correlation.runId

    if (event.type === "run_started") {
      const run: RunRecord = {
        runId,
        events: [],
        startedAt: event.timestamp,
      }
      this.#appendEvent(run, event)
      this.#activeRuns.set(runId, run)
      this.#broadcast(event)
      return
    }

    let run = this.#activeRuns.get(runId)
    if (!run) {
      // If run_started was missed, create a synthetic active run so events stay isolated by runId.
      run = {
        runId,
        events: [],
        startedAt: event.timestamp,
      }
      this.#activeRuns.set(runId, run)
    }
    this.#appendEvent(run, event)

    if (event.type === "run_finished") {
      run.finishedAt = event.timestamp
      this.#activeRuns.delete(runId)
      this.#archiveRun(run)
    }

    this.#broadcast(event)
  }

  #appendEvent(run: RunRecord, event: LifecycleEvent): void {
    if (run.events.length >= MAX_EVENT_BUFFER) {
      // Prefer dropping output chunks to preserve lifecycle reconstructability.
      const outputIndex = run.events.findIndex((e) => e.type === "resource_output")
      if (outputIndex >= 0) {
        run.events.splice(outputIndex, 1)
      } else if (event.type === "resource_output") {
        // If only lifecycle events remain, drop incoming output first.
        return
      } else {
        run.events.shift()
      }
    }
    run.events.push(event)
  }

  #archiveRun(run: RunRecord): void {
    const existing = this.#runs.findIndex((r) => r.runId === run.runId)
    if (existing >= 0) {
      this.#runs[existing] = run
      return
    }
    this.#runs.push(run)
    while (this.#runs.length > this.#opts.maxHistory) {
      this.#runs.shift()
    }
  }

  #replayEvents(): LifecycleEvent[] {
    const live = this.currentRun
    if (live) return live.events
    return this.#runs.at(-1)?.events ?? []
  }

  #broadcast(event: LifecycleEvent): void {
    const json = JSON.stringify(event)
    for (const ws of this.#clients) {
      if (ws.readyState === SOCKET_OPEN) {
        ws.send(json)
      }
    }
  }

  /**
   * Override point for subclasses to handle additional routes.
   * Return a Response to handle the request, or null to fall through
   * to the default routing.
   */
  protected handleExtraRoutes(_url: URL, _req: Request): Response | null {
    return null
  }

  #handleRequest(url: URL, req: Request): Response | Promise<Response> {
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok" })
    }

    if (url.pathname === "/api/events") {
      // Backward-compat: return current run events, or most recent finished run
      return Response.json(this.#replayEvents())
    }

    if (url.pathname === "/api/runs") {
      const summaries = this.#buildRunSummaries()
      return Response.json(summaries)
    }

    // /api/runs/:runId/events
    const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
    if (runEventsMatch) {
      const runId = decodeURIComponent(runEventsMatch[1])
      const record = this.#findRun(runId)
      if (!record) {
        return Response.json({ error: "Run not found" }, { status: 404 })
      }
      return Response.json(record.events)
    }

    // Allow subclasses to add routes
    const extra = this.handleExtraRoutes(url, req)
    if (extra) return extra

    if (this.#opts.staticDir) {
      return this.#serveStatic(url.pathname)
    }

    if (this.#serveEmbeddedFallback && DASHBOARD_HTML) {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    return new Response("Not Found", { status: 404 })
  }

  async #serveStatic(pathname: string): Promise<Response> {
    const filePath = pathname === "/" ? "/index.html" : pathname
    const fullPath = join(this.#opts.staticDir!, filePath)

    const file = Bun.file(fullPath)
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": contentType(filePath) },
      })
    }

    // SPA fallback: serve index.html for unmatched routes
    const index = Bun.file(join(this.#opts.staticDir!, "index.html"))
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    return new Response("Not Found", { status: 404 })
  }

  /** Build run summaries for /api/runs (includes current + history). */
  #buildRunSummaries(): RunSummary[] {
    const summaries: RunSummary[] = []
    for (const run of this.#runs) {
      summaries.push(this.#toSummary(run))
    }
    for (const run of this.#activeRuns.values()) {
      summaries.push(this.#toSummary(run))
    }
    return summaries
  }

  #toSummary(run: RunRecord): RunSummary {
    const startEvent = run.events.find((e) => e.type === "run_started") as
      | (LifecycleEvent & { type: "run_started" })
      | undefined
    const finishEvent = run.events.find((e) => e.type === "run_finished") as
      | (LifecycleEvent & { type: "run_finished" })
      | undefined
    return {
      id: run.runId,
      mode: startEvent?.mode ?? "unknown",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      hasFailures: finishEvent?.hasFailures,
    }
  }

  /** Find a run by ID in history or current. */
  #findRun(runId: string): RunRecord | undefined {
    const active = this.#activeRuns.get(runId)
    if (active) return active
    return this.#runs.find((r) => r.runId === runId)
  }
}
