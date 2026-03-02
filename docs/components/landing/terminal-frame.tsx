import type { ReactNode } from "react"

interface TerminalFrameProps {
  title?: string
  children: ReactNode
  className?: string
}

export function TerminalFrame({
  title = "Terminal",
  children,
  className = "",
}: TerminalFrameProps) {
  return (
    <div className={`overflow-hidden border border-(--frame-border) ${className}`}>
      <div className="flex items-center gap-1.5 px-4 py-2.5 bg-surface-dark border-b border-white/10">
        <div className="size-2.5 rounded-full bg-brand" />
        <div className="size-2.5 rounded-full bg-accent-gold" />
        <div className="size-2.5 rounded-full bg-accent-teal" />
        <span className="ml-2 text-xs text-terminal-dim font-mono">{title}</span>
      </div>
      <div className="bg-terminal-bg text-terminal-fg font-mono text-[13px] leading-[1.6] p-4 overflow-x-auto">
        {children}
      </div>
    </div>
  )
}
