import type { HostState, RunState } from "../state.ts"

export function RunFooter({ run, hosts }: { run: RunState; hosts: Map<string, HostState> }) {
  const totalFailed = [...hosts.values()].reduce((sum, h) => sum + h.failed, 0)
  return (
    <div className={`run-footer ${run.hasFailures ? "run-footer--failed" : "run-footer--ok"}`}>
      <span>Run finished</span>
      <span>
        &middot; {hosts.size} host{hosts.size !== 1 ? "s" : ""}
      </span>
      {totalFailed > 0 && (
        <span>
          &middot; {totalFailed} failure{totalFailed !== 1 ? "s" : ""}
        </span>
      )}
      {run.durationMs != null && <span>&middot; {(run.durationMs / 1000).toFixed(1)}s</span>}
    </div>
  )
}
