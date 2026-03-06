/** Show whether the dashboard is currently connected to the event stream. */
export function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <span className={`connection-status ${connected ? "connected" : "disconnected"}`}>
      {connected ? "Connected" : "Reconnecting\u2026"}
    </span>
  )
}
