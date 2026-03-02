"use client"

import { useEffect, useState, useCallback } from "react"
import { RecipeCode } from "./recipe-code"
import { Terminal } from "./terminal"

const RECIPE_DURATION = 5000
const TERMINAL_DURATION = 10000

export function HeroToggle() {
  const [active, setActive] = useState<"recipe" | "terminal">("recipe")

  const cycle = useCallback(() => {
    setActive((prev) => (prev === "recipe" ? "terminal" : "recipe"))
  }, [])

  useEffect(() => {
    const duration = active === "recipe" ? RECIPE_DURATION : TERMINAL_DURATION
    const timer = setTimeout(cycle, duration)
    return () => clearTimeout(timer)
  }, [active, cycle])

  return (
    <div className="text-left">
      {/* Tabs */}
      <div className="flex border-b border-(--frame-border)">
        <button
          type="button"
          onClick={() => setActive("recipe")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-mono transition-colors ${
            active === "recipe"
              ? "bg-fd-card text-fd-foreground border-b-2 border-brand -mb-px"
              : "bg-terminal-bg text-terminal-dim hover:text-terminal-fg"
          }`}
        >
          <span className="size-2 rounded-full bg-brand inline-block" />
          deploy.ts
        </button>
        <button
          type="button"
          onClick={() => setActive("terminal")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-mono transition-colors ${
            active === "terminal"
              ? "bg-terminal-bg text-terminal-fg border-b-2 border-brand -mb-px"
              : "bg-fd-card text-fd-muted-foreground hover:text-fd-foreground"
          }`}
        >
          <span className="size-2 rounded-full bg-accent-teal inline-block" />
          Terminal
        </button>
      </div>

      {/* Panels — both always rendered in the same grid cell so the taller one sets the height */}
      <div className="grid *:col-start-1 *:row-start-1">
        <div
          className={`transition-opacity duration-500 ease-in-out ${
            active === "recipe" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
          }`}
        >
          <div className="bg-fd-card p-4 h-full">
            <RecipeCode />
          </div>
        </div>
        <div
          className={`transition-opacity duration-500 ease-in-out ${
            active === "terminal" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
          }`}
        >
          <div className="bg-terminal-bg p-4 h-full font-mono text-[13px] leading-[1.6]">
            <Terminal key={active === "terminal" ? "active" : "inactive"} />
          </div>
        </div>
      </div>
    </div>
  )
}
