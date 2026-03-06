import type { RunSummary } from "../state.ts"

type RunSidebarProps = {
  runs: RunSummary[]
  activeRunId: string | null
  onSelect: (runId: string) => void
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

/** Render the historical run list used to switch between recorded runs. */
export function RunSidebar({ runs, activeRunId, onSelect }: RunSidebarProps) {
  // Don't render sidebar when there's only 0-1 runs
  if (runs.length <= 1) return null

  return (
    <aside className="run-sidebar">
      <h2 className="run-sidebar__title">Run History</h2>
      <ul className="run-sidebar__list">
        {[...runs].reverse().map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className={`run-sidebar__item ${run.id === activeRunId ? "run-sidebar__item--active" : ""}`}
              onClick={() => onSelect(run.id)}
            >
              <span className="run-sidebar__mode">{run.mode}</span>
              <span className="run-sidebar__time">{formatTime(run.startedAt)}</span>
              {run.finishedAt ? (
                <span
                  className={`run-sidebar__status ${
                    run.hasFailures ? "run-sidebar__status--failed" : "run-sidebar__status--ok"
                  }`}
                >
                  {run.hasFailures ? "failed" : "ok"}
                </span>
              ) : (
                <span className="run-sidebar__status run-sidebar__status--running">running</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
