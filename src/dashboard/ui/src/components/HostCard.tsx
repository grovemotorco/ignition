import type { HostState } from "../state.ts"
import { ResourceRow } from "./ResourceRow.tsx"

export function HostCard({ host }: { host: HostState }) {
  return (
    <div className={`host-card host-card--${host.status}`}>
      <div className="host-card__header">
        <span className="host-card__name">{host.host.name}</span>
        <span className="host-card__hostname">({host.host.hostname})</span>
        {host.durationMs != null && (
          <span className="host-card__duration">{(host.durationMs / 1000).toFixed(1)}s</span>
        )}
        {host.status === "running" && <span className="host-card__status pulse">running</span>}
        {host.status === "cancelled" && (
          <span className="host-card__status cancelled">cancelled</span>
        )}
      </div>
      <div className="host-card__resources">
        {[...host.resources.entries()].map(([resId, resource]) => (
          <ResourceRow key={resId} resource={resource} />
        ))}
      </div>
      <div className="host-card__summary">
        ok: {host.ok} &middot; changed: {host.changed} &middot; failed: {host.failed}
      </div>
    </div>
  )
}
