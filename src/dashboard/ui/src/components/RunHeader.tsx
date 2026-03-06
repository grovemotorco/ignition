import type { RunState } from "../state.ts"

/** Render the active run metadata header. */
export function RunHeader({ run }: { run: RunState }) {
  const time = new Date(run.startedAt).toLocaleTimeString()
  return (
    <div className="run-header">
      <span className="run-header__id">Run {run.id.slice(0, 12)}</span>
      <span className="run-header__mode">{run.mode}</span>
      <span className="run-header__error-mode">{run.errorMode}</span>
      <span className="run-header__hosts">
        {run.hostCount} host{run.hostCount !== 1 ? "s" : ""}
      </span>
      <span className="run-header__time">started {time}</span>
    </div>
  )
}
