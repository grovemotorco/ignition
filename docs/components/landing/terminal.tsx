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
    text: "  ✓  docker   edge-cache             started",
    className: "text-terminal-green",
    delay: 1500,
  },
  {
    text: "  ✓  dir      /var/www/app            created",
    className: "text-terminal-green",
    delay: 1900,
  },
  {
    text: "  ✓  file     /var/www/app/index.html changed",
    className: "text-terminal-green",
    delay: 2500,
  },
  {
    text: "  ✓  file     /etc/nginx/sites-available/app.conf changed",
    className: "text-terminal-green",
    delay: 3100,
  },
  {
    text: "  ✓  service  nginx                  started",
    className: "text-terminal-green",
    delay: 3700,
  },
  { text: "", delay: 3900 },
  { text: "  6 resources: 6 changed, 0 ok, 0 failed", className: "text-terminal-fg", delay: 4100 },
  { text: "  completed in 3.4s", className: "text-terminal-dim", delay: 4300 },
  { text: "", delay: 4700 },
  {
    text: "$ ignition run deploy.ts admin@web-1",
    className: "text-white font-semibold",
    delay: 5100,
  },
  { text: "", delay: 5300 },
  { text: "  web-1  ▸ Running deploy.ts", className: "text-terminal-blue", delay: 5500 },
  { text: "", delay: 5700 },
  { text: "  ─  apt      nginx                  ok", className: "text-terminal-dim", delay: 6000 },
  {
    text: "  ─  docker   edge-cache             ok",
    className: "text-terminal-dim",
    delay: 6300,
  },
  { text: "  ─  dir      /var/www/app            ok", className: "text-terminal-dim", delay: 6600 },
  { text: "  ─  file     /var/www/app/index.html ok", className: "text-terminal-dim", delay: 6900 },
  {
    text: "  ─  file     /etc/nginx/sites-available/app.conf ok",
    className: "text-terminal-dim",
    delay: 7200,
  },
  { text: "  ─  service  nginx                  ok", className: "text-terminal-dim", delay: 7500 },
  { text: "", delay: 7700 },
  { text: "  6 resources: 0 changed, 6 ok, 0 failed", className: "text-terminal-fg", delay: 7900 },
  {
    text: "  completed in 1.1s ── nothing to change",
    className: "text-terminal-green",
    delay: 8100,
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
