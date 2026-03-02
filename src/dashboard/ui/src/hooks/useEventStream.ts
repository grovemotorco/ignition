import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import {
  createInitialState,
  type DashboardState,
  eventReducer,
  type LifecycleEvent,
  type RunSummary,
} from "../state.ts"

export function useEventStream(): {
  state: DashboardState
  connected: boolean
  selectRun: (runId: string) => void
} {
  const [state, dispatch] = useReducer(eventReducer, null, createInitialState)
  const [connected, setConnected] = useState(false)
  const reconnectDelay = useRef(1000)

  const outputQueue = useRef<LifecycleEvent[]>([])
  const rafId = useRef<number>(0)

  useEffect(() => {
    let ws: WebSocket
    let timer: number
    const wsScheme = location.protocol === "https:" ? "wss" : "ws"

    function flushOutputQueue() {
      const batch = outputQueue.current
      if (batch.length === 0) return
      outputQueue.current = []
      rafId.current = 0
      for (const event of batch) {
        dispatch(event)
      }
    }

    function connect() {
      ws = new WebSocket(`${wsScheme}://${location.host}/ws`)

      ws.onopen = async () => {
        reconnectDelay.current = 1000
        setConnected(true)

        // Fetch run history for sidebar
        try {
          const res = await fetch("/api/runs")
          if (res.ok) {
            const runs: RunSummary[] = await res.json()
            dispatch({ type: "SET_RUNS", runs })
          }
        } catch {
          // Non-critical — sidebar just won't populate
        }
      }

      ws.onclose = () => {
        setConnected(false)
        timer = setTimeout(connect, reconnectDelay.current) as unknown as number
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000)
      }

      ws.onmessage = (e: MessageEvent) => {
        const event: LifecycleEvent = JSON.parse(e.data)
        if (event.type === "resource_output") {
          outputQueue.current.push(event)
          if (!rafId.current) {
            rafId.current = requestAnimationFrame(flushOutputQueue)
          }
        } else {
          dispatch(event)
        }
      }
    }

    connect()
    return () => {
      clearTimeout(timer)
      if (rafId.current) cancelAnimationFrame(rafId.current)
      ws?.close()
    }
  }, [])

  const selectRun = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`)
      if (res.ok) {
        const events: LifecycleEvent[] = await res.json()
        dispatch({ type: "SELECT_RUN", runId, events })
      }
    } catch {
      // Failed to fetch historical run
    }
  }, [])

  return { state, connected, selectRun }
}
