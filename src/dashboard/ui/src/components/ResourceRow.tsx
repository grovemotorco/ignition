import { useEffect, useMemo, useRef, useState } from "react"
import type { UIEvent } from "react"
import type { ResourceState } from "../state.ts"

const STATUS_ICONS: Record<string, string> = {
  ok: "\u25CF",
  changed: "\u2713",
  failed: "\u2717",
  running: "\u27F3",
}

/** Threshold in pixels — auto-scroll only when near the bottom. */
const SCROLL_THRESHOLD = 40
const LINE_HEIGHT = 20
const OVERSCAN_LINES = 40
const OUTPUT_MAX_HEIGHT = 300

export function ResourceRow({ resource }: { resource: ResourceState }) {
  const lines = useMemo(() => {
    const pending: ResourceState["output"] = []
    if (resource.outputPending.stdout.length > 0) {
      pending.push({ stream: "stdout" as const, text: resource.outputPending.stdout })
    }
    if (resource.outputPending.stderr.length > 0) {
      pending.push({ stream: "stderr" as const, text: resource.outputPending.stderr })
    }
    return pending.length > 0 ? [...resource.output, ...pending] : resource.output
  }, [resource.output, resource.outputPending.stderr, resource.outputPending.stdout])

  const hasOutput = lines.length > 0
  const [expanded, setExpanded] = useState(resource.status === "failed" && hasOutput)
  const [scrollTop, setScrollTop] = useState(0)
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (resource.status === "failed" && hasOutput) {
      setExpanded(true)
    }
  }, [resource.status, hasOutput])

  // Auto-scroll to bottom when new output arrives (only if already near bottom)
  useEffect(() => {
    const el = outputRef.current
    if (!el || !expanded) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
    if (nearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines.length, expanded])

  const isStreaming = resource.status === "running" && hasOutput
  const startIndex = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN_LINES)
  const endIndex = Math.min(
    lines.length,
    Math.ceil((scrollTop + OUTPUT_MAX_HEIGHT) / LINE_HEIGHT) + OVERSCAN_LINES,
  )
  const visibleLines = lines.slice(startIndex, endIndex)
  const topSpacer = startIndex * LINE_HEIGHT
  const bottomSpacer = (lines.length - endIndex) * LINE_HEIGHT

  return (
    <div className={`resource-row resource-row--${resource.status}`}>
      <span className="resource-row__icon">{STATUS_ICONS[resource.status] ?? "\u25CB"}</span>
      <span className="resource-row__type">{resource.type}</span>
      <span className="resource-row__name">{resource.name}</span>
      <span className="resource-row__status">{resource.status}</span>
      {resource.durationMs != null && (
        <span className="resource-row__duration">{(resource.durationMs / 1000).toFixed(1)}s</span>
      )}
      {resource.cacheHit && <span className="resource-row__cache">cached</span>}
      {hasOutput && (
        <button
          type="button"
          className="resource-row__output-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "\u25BE" : "\u25B8"} output ({lines.length})
        </button>
      )}
      {resource.error && <div className="resource-row__error">{resource.error.message}</div>}
      {resource.retries.length > 0 && (
        <div className="resource-row__retries">
          {resource.retries.map((r, i) => (
            <span key={i} className="resource-row__retry">
              retry #{r.attempt} ({r.phase}): {r.error}
            </span>
          ))}
        </div>
      )}
      {expanded && (
        <div
          ref={outputRef}
          className="resource-row__output"
          onScroll={(event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {topSpacer > 0 && <div style={{ height: `${topSpacer}px` }} />}
          {visibleLines.map((o, i) => (
            <span
              key={startIndex + i}
              className={`resource-row__output-line resource-row__output-line--${o.stream}`}
            >
              {o.text}
            </span>
          ))}
          {bottomSpacer > 0 && <div style={{ height: `${bottomSpacer}px` }} />}
          {isStreaming && <span className="resource-row__streaming">streaming...</span>}
        </div>
      )}
    </div>
  )
}
