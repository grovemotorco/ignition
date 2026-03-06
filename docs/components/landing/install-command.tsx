"use client"

import { useState, useRef, useEffect } from "react"

const methods = [
  { label: "bun", command: "bun install -g @grovemotorco/ignition" },
  { label: "npm", command: "npm install -g @grovemotorco/ignition" },
] as const

export function InstallCommand() {
  const [selected, setSelected] = useState(0)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  function copy() {
    void navigator.clipboard.writeText(methods[selected].command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      ref={ref}
      className="relative inline-flex items-stretch bg-terminal-bg border border-(--frame-border) text-sm font-mono max-w-full"
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 px-3 py-2.5 text-terminal-dim hover:text-terminal-fg transition-colors border-r border-white/10 whitespace-nowrap"
        >
          {methods[selected].label}
          <svg
            className="size-3 opacity-60"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-0 top-full mt-1 z-50 bg-terminal-bg border border-white/10 shadow-xl py-1 min-w-25">
            {methods.map((m, i) => (
              <button
                key={m.label}
                type="button"
                onClick={() => {
                  setSelected(i)
                  setOpen(false)
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-white/5 transition-colors ${
                  i === selected ? "text-brand" : "text-terminal-fg"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="flex items-center px-3 py-2.5 text-terminal-fg select-all truncate">
        {methods[selected].command}
      </span>

      <button
        type="button"
        onClick={copy}
        className="flex items-center px-3 py-2.5 text-terminal-dim hover:text-terminal-fg transition-colors border-l border-white/10"
        aria-label="Copy to clipboard"
      >
        {copied ? (
          <svg
            className="size-4 text-terminal-green"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}
