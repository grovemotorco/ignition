/**
 * DashboardClient — WebSocket producer that pushes LifecycleEvents to a
 * persistent DashboardServer.
 *
 * Used by CLI run/check commands to stream events to a separately running
 * `ignition dashboard` process. Register `client.listener` with
 * `EventBus.on()` to forward events over the network.
 *
 * Includes a static `probe()` method that checks whether a dashboard server
 * is reachable at a given address.
 */

import type { EventListener, LifecycleEvent } from "../output/events.ts"

interface WebSocketLike {
  readonly readyState: number
  addEventListener(
    type: "open" | "error" | "close",
    listener: (event: Event | ErrorEvent) => void,
    opts?: { once?: boolean },
  ): void
  send(data: string): void
  close(): void
}

type WebSocketFactory = (url: string) => WebSocketLike
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3

/** Testability seam for injecting custom network primitives. */
export interface DashboardClientDeps {
  readonly createWebSocket: WebSocketFactory
  readonly fetch: FetchLike
}

/**
 * WebSocket client that pushes LifecycleEvent JSON messages to a
 * DashboardServer's `/ws/push` endpoint.
 *
 * ```ts
 * const client = new DashboardClient('ws://127.0.0.1:9090/ws/push')
 * await client.connect()
 * const unsub = eventBus.on(client.listener)
 * // ... run completes ...
 * unsub()
 * await client.close()
 * ```
 */
export class DashboardClient {
  readonly #url: string
  #ws: WebSocketLike | null = null
  #deps: DashboardClientDeps

  constructor(url: string, deps?: Partial<DashboardClientDeps>) {
    this.#url = url
    this.#deps = {
      createWebSocket:
        deps?.createWebSocket ?? ((websocketUrl: string) => new WebSocket(websocketUrl)),
      fetch: deps?.fetch ?? fetch,
    }
  }

  /** EventListener-compatible handler. Register with EventBus.on(). */
  readonly listener: EventListener = (event: LifecycleEvent): void => {
    if (this.#ws && this.#ws.readyState === WS_OPEN) {
      this.#ws.send(JSON.stringify(event))
    }
  }

  /** Connect to the dashboard server. Resolves when the WebSocket is open. */
  async connect(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.#ws = this.#deps.createWebSocket(this.#url)
    this.#ws.addEventListener("open", () => resolve(), { once: true })
    this.#ws.addEventListener("error", (e) => reject(e), { once: true })
    await promise
  }

  /** Close the connection gracefully. */
  async close(): Promise<void> {
    if (!this.#ws) return
    if (this.#ws.readyState === WS_CLOSED || this.#ws.readyState === WS_CLOSING) {
      this.#ws = null
      return
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#ws.addEventListener("close", () => resolve(), { once: true })
    this.#ws.close()
    await promise
    this.#ws = null
  }

  /**
   * Probe whether a dashboard server is reachable at the given address.
   * Returns true if `/api/health` responds with 200 within the timeout.
   */
  static async probe(
    hostname: string,
    port: number,
    timeoutMs = 500,
    fetchImpl: FetchLike = fetch,
  ): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`http://${hostname}:${port}/api/health`, {
        signal: controller.signal,
      })
      await res.body?.cancel()
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
