import { useEventStream } from "./hooks/useEventStream.ts"
import { RunHeader } from "./components/RunHeader.tsx"
import { HostCard } from "./components/HostCard.tsx"
import { RunFooter } from "./components/RunFooter.tsx"
import { ConnectionStatus } from "./components/ConnectionStatus.tsx"
import { RunSidebar } from "./components/RunSidebar.tsx"

/** Render the live dashboard application shell. */
export default function App() {
  const { state, connected, selectRun } = useEventStream()
  const hasSidebar = state.runs.length > 1

  return (
    <div className={`dashboard-layout ${hasSidebar ? "dashboard-layout--with-sidebar" : ""}`}>
      {hasSidebar && (
        <RunSidebar runs={state.runs} activeRunId={state.activeRunId} onSelect={selectRun} />
      )}

      <div className="dashboard">
        <header className="dashboard-header">
          <h1>Ignition Dashboard</h1>
          <ConnectionStatus connected={connected} />
        </header>

        {state.run && <RunHeader run={state.run} />}

        {!state.run && (
          <div className="dashboard-empty">
            <div className="dashboard-empty__dot" />
            <span>Waiting for runs&hellip;</span>
          </div>
        )}

        <div className="host-list">
          {[...state.hosts.entries()].map(([hostId, host]) => (
            <HostCard key={hostId} host={host} />
          ))}
        </div>

        {state.run?.finishedAt && <RunFooter run={state.run} hosts={state.hosts} />}
      </div>
    </div>
  )
}
