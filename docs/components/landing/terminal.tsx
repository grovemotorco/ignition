"use client"

import { useEffect, useState } from "react"

type TerminalLine = {
  text: string
  className?: string
  delay: number
}

const lines: TerminalLine[] = [
  { text: "$ ignition run deploy.ts admin@web-1", className: "text-white font-semibold", delay: 0 },
  { text: "", delay: 400 },
  { text: "  web-1  ▸ Running deploy.ts", className: "text-terminal-blue", delay: 600 },
  { text: "", delay: 800 },
  {
    text: "  ✓  apt      nginx                  installed",
    className: "text-terminal-green",
    delay: 1200,
  },
  {
    text: "  ✓  dir      /var/www/app            created",
    className: "text-terminal-green",
    delay: 1800,
  },
  {
    text: "  ✓  file     /var/www/app/index.html changed",
    className: "text-terminal-green",
    delay: 2400,
  },
  {
    text: "  ✓  file     /etc/nginx/sites-available/app.conf changed",
    className: "text-terminal-green",
    delay: 3000,
  },
  {
    text: "  ✓  service  nginx                  started",
    className: "text-terminal-green",
    delay: 3600,
  },
  { text: "", delay: 3800 },
  { text: "  5 resources: 5 changed, 0 ok, 0 failed", className: "text-terminal-fg", delay: 4000 },
  { text: "  completed in 3.2s", className: "text-terminal-dim", delay: 4200 },
  { text: "", delay: 4600 },
  {
    text: "$ ignition run deploy.ts admin@web-1",
    className: "text-white font-semibold",
    delay: 5000,
  },
  { text: "", delay: 5200 },
  { text: "  web-1  ▸ Running deploy.ts", className: "text-terminal-blue", delay: 5400 },
  { text: "", delay: 5600 },
  { text: "  ─  apt      nginx                  ok", className: "text-terminal-dim", delay: 5900 },
  { text: "  ─  dir      /var/www/app            ok", className: "text-terminal-dim", delay: 6200 },
  { text: "  ─  file     /var/www/app/index.html ok", className: "text-terminal-dim", delay: 6500 },
  {
    text: "  ─  file     /etc/nginx/sites-available/app.conf ok",
    className: "text-terminal-dim",
    delay: 6800,
  },
  { text: "  ─  service  nginx                  ok", className: "text-terminal-dim", delay: 7100 },
  { text: "", delay: 7300 },
  { text: "  5 resources: 0 changed, 5 ok, 0 failed", className: "text-terminal-fg", delay: 7500 },
  {
    text: "  completed in 1.1s ── nothing to change",
    className: "text-terminal-green",
    delay: 7700,
  },
]

export function Terminal() {
  const [visibleCount, setVisibleCount] = useState(0)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []

    for (let i = 0; i < lines.length; i++) {
      timers.push(
        setTimeout(() => {
          setVisibleCount(i + 1)
        }, lines[i].delay),
      )
    }

    return () => timers.forEach(clearTimeout)
  }, [])

  return (
    <div className="relative">
      {lines.map((line, i) => (
        <div
          key={i}
          className={i < visibleCount ? (line.className ?? "text-terminal-fg") : "invisible"}
        >
          {line.text || "\u00A0"}
        </div>
      ))}
      {visibleCount > 0 && visibleCount < lines.length && (
        <span
          className="absolute left-0 inline-block w-2 h-4 bg-terminal-fg animate-terminal-blink"
          style={{ top: `calc(${visibleCount} * 1lh)` }}
        />
      )}
    </div>
  )
}
