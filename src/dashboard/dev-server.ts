#!/usr/bin/env bun
/**
 * Mock event server for dashboard UI development.
 *
 * Starts a DashboardServer on :9090 with simulation routes for generating
 * fake run events. Run the Vite dev server separately for the UI:
 *
 *   Terminal 1:  bun run dev:ui                          (this server)
 *   Terminal 2:  bun run --cwd src/dashboard/ui vite     (Vite HMR on :5173)
 *
 * The Vite proxy config in ui/vite.config.ts forwards /ws and /api to :9090.
 * Open http://localhost:5173 in a browser.
 *
 * Simulations are triggered on demand:
 *   POST /api/simulate          — trigger a single simulated run
 *   POST /api/simulate/auto     — start auto-simulation every 15s
 *   POST /api/simulate/stop     — stop auto-simulation
 *
 * Pass `--auto` to start with auto-simulation enabled.
 */

import { DashboardServer } from "./server.ts"
import { EventBus } from "../output/events.ts"

const autoFlag = process.argv.slice(2).includes("--auto")

// ---------------------------------------------------------------------------
// Extend DashboardServer to add simulation routes
// ---------------------------------------------------------------------------

class DevDashboardServer extends DashboardServer {
  #runCounter = 0
  #autoTimer: ReturnType<typeof setInterval> | undefined

  /** Trigger a single simulated run. */
  async simulateRun(): Promise<void> {
    this.#runCounter++
    const bus = new EventBus()
    bus.on(this.listener)
    const mode = this.#runCounter % 2 === 0 ? "check" : "apply"

    console.log(`\nSimulating run #${this.#runCounter} (${mode})...`)

    bus.runStarted(mode, "fail-fast", 2)

    const h1 = bus.nextId()
    bus.hostStarted(h1, {
      name: "web-1",
      hostname: "10.0.1.10",
      user: "deploy",
      port: 22,
      vars: {},
    })

    const h2 = bus.nextId()
    bus.hostStarted(h2, { name: "db-1", hostname: "10.0.2.10", user: "deploy", port: 22, vars: {} })

    // web-1 resources
    const resources1: [string, string][] = [
      ["apt", "nginx"],
      ["file", "/etc/nginx/nginx.conf"],
      ["service", "nginx"],
    ]

    for (const [type, name] of resources1) {
      const rid = bus.nextId()
      bus.resourceStarted(h1, rid, type, name)

      // Simulate streaming output for apt and file resources
      if (type === "apt") {
        await delay(200)
        bus.resourceOutput(h1, rid, type, name, "stdout", "Reading package lists...\n")
        await delay(150)
        bus.resourceOutput(h1, rid, type, name, "stdout", "Building dependency tree...\n")
        await delay(100)
        bus.resourceOutput(h1, rid, type, name, "stdout", "Reading state information...\n")
        await delay(200)
        bus.resourceOutput(h1, rid, type, name, "stdout", `Setting up ${name} ...\n`)
        await delay(100)
      } else if (type === "file") {
        await delay(300)
        bus.resourceOutput(h1, rid, type, name, "stdout", `Comparing ${name}...\n`)
        await delay(100)
        bus.resourceOutput(h1, rid, type, name, "stderr", "warn: file differs from desired state\n")
        await delay(200)
        bus.resourceOutput(h1, rid, type, name, "stdout", `Writing ${name}...\n`)
      } else {
        await delay(400 + Math.random() * 400)
      }

      await delay(200 + Math.random() * 400)
      bus.resourceFinished(h1, rid, {
        type,
        name,
        status: "changed",
        durationMs: 600 + Math.random() * 800,
      })
    }

    bus.hostFinished(
      h1,
      { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} },
      {
        ok: 0,
        changed: 3,
        failed: 0,
        durationMs: 2800,
      },
    )

    // db-1 resources (one fails on odd runs)
    const rid1 = bus.nextId()
    bus.resourceStarted(h2, rid1, "apt", "postgresql-16")
    await delay(200)
    bus.resourceOutput(h2, rid1, "apt", "postgresql-16", "stdout", "Reading package lists...\n")
    await delay(150)
    bus.resourceOutput(
      h2,
      rid1,
      "apt",
      "postgresql-16",
      "stdout",
      "postgresql-16 is already the newest version (16.2-1).\n",
    )
    await delay(150)
    bus.resourceFinished(h2, rid1, {
      type: "apt",
      name: "postgresql-16",
      status: "ok",
      durationMs: 500,
    })

    const rid2 = bus.nextId()
    bus.resourceStarted(h2, rid2, "file", "/etc/postgresql/16/main/pg_hba.conf")
    await delay(200)
    const shouldFail = this.#runCounter % 2 !== 0
    bus.resourceOutput(
      h2,
      rid2,
      "file",
      "/etc/postgresql/16/main/pg_hba.conf",
      "stdout",
      "Checking file checksum...\n",
    )
    await delay(100)
    if (shouldFail) {
      bus.resourceOutput(
        h2,
        rid2,
        "file",
        "/etc/postgresql/16/main/pg_hba.conf",
        "stderr",
        "error: EACCES: permission denied, open '/etc/postgresql/16/main/pg_hba.conf'\n",
      )
    } else {
      bus.resourceOutput(
        h2,
        rid2,
        "file",
        "/etc/postgresql/16/main/pg_hba.conf",
        "stdout",
        "Writing config...\n",
      )
    }
    await delay(100)
    bus.resourceFinished(h2, rid2, {
      type: "file",
      name: "/etc/postgresql/16/main/pg_hba.conf",
      status: shouldFail ? "failed" : "changed",
      durationMs: 400,
      error: shouldFail
        ? new Error("Permission denied: /etc/postgresql/16/main/pg_hba.conf")
        : undefined,
    })

    bus.hostFinished(
      h2,
      { name: "db-1", hostname: "10.0.2.10", user: "deploy", port: 22, vars: {} },
      {
        ok: 1,
        changed: shouldFail ? 0 : 1,
        failed: shouldFail ? 1 : 0,
        durationMs: 1200,
      },
    )

    bus.runFinished(3200, shouldFail, 2)
    console.log(`Run #${this.#runCounter} complete (${shouldFail ? "with failures" : "success"}).`)
  }

  /** Start auto-simulation every `intervalMs`. */
  startAutoSimulate(intervalMs = 15_000): void {
    this.stopAutoSimulate()
    console.log(`Auto-simulate enabled (every ${intervalMs / 1000}s)`)
    this.#autoTimer = setInterval(() => this.simulateRun(), intervalMs)
  }

  /** Stop auto-simulation. */
  stopAutoSimulate(): void {
    if (this.#autoTimer !== undefined) {
      clearInterval(this.#autoTimer)
      this.#autoTimer = undefined
      console.log("Auto-simulate stopped")
    }
  }

  get isAutoSimulating(): boolean {
    return this.#autoTimer !== undefined
  }

  /** Override to intercept simulation routes before default handling. */
  protected override handleExtraRoutes(url: URL, req: Request): Response | null {
    if (url.pathname === "/api/simulate" && req.method === "POST") {
      // Fire-and-forget — simulateRun increments #runCounter synchronously
      // at entry, so capture the next run number before calling.
      const run = this.#runCounter + 1
      void this.simulateRun()
      return Response.json({ status: "triggered", run })
    }
    if (url.pathname === "/api/simulate/auto" && req.method === "POST") {
      this.startAutoSimulate()
      return Response.json({ status: "auto-simulate started" })
    }
    if (url.pathname === "/api/simulate/stop" && req.method === "POST") {
      this.stopAutoSimulate()
      return Response.json({ status: "auto-simulate stopped" })
    }
    if (url.pathname === "/api/simulate" && req.method === "GET") {
      return Response.json({ auto: this.isAutoSimulating, runCount: this.#runCounter })
    }
    return null
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = new DevDashboardServer({ port: 9090, staticDir: null })
await server.start()

console.log("")
console.log(`  API server:       http://127.0.0.1:${server.port}`)
console.log(`  WebSocket:        ws://127.0.0.1:${server.port}/ws`)
console.log("")
console.log("Start the UI dev server in another terminal:")
console.log("  bun run --cwd src/dashboard/ui vite")
console.log("")
console.log("Simulate routes:")
console.log("  POST /api/simulate       — trigger one run")
console.log("  POST /api/simulate/auto  — start auto-simulate (every 15s)")
console.log("  POST /api/simulate/stop  — stop auto-simulate")
console.log("  GET  /api/simulate       — check status")

if (autoFlag) {
  await server.simulateRun()
  server.startAutoSimulate()
}

const onSignal = async () => {
  console.log("\nShutting down...")
  server.stopAutoSimulate()
  await server.shutdown()
  process.exit(0)
}
process.on("SIGINT", onSignal)
process.on("SIGTERM", onSignal)

// Keep alive
await new Promise(() => {})
