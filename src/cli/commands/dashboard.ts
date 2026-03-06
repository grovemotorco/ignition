import { Cli, z } from "incur"
import { DashboardServer } from "../../dashboard/server.ts"
import { loggerVarsSchema } from "../logger.ts"

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"])

function resolveDashboardHostname(hostname: string): string {
  return WILDCARD_HOSTS.has(hostname) ? "127.0.0.1" : hostname
}

function buildDashboardUrl(hostname: string, port: number): string {
  return `http://${resolveDashboardHostname(hostname)}:${port}`
}

function parseDashboardUrl(url: string): { url: string; hostname: string; port: number } {
  const parsed = new URL(url)
  return {
    url,
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
  }
}

export const dashboard = Cli.create("dashboard", {
  description: "Start persistent web dashboard",
  vars: loggerVarsSchema,
  options: z.object({
    port: z.number().optional().default(9090).describe("Dashboard port"),
    host: z.string().optional().default("127.0.0.1").describe("Dashboard hostname"),
    maxHistory: z.number().optional().default(10).describe("Max run history to retain"),
  }),
  output: z.object({
    url: z.string().describe("Dashboard URL"),
    hostname: z.string(),
    port: z.number(),
  }),
  outputPolicy: "agent-only",
  async *run(c) {
    const { host: hostname, port, maxHistory } = c.options
    const logger = c.var.logger

    const server = new DashboardServer({ port, hostname, maxHistory })
    await server.start()

    const output = parseDashboardUrl(buildDashboardUrl(hostname, server.port))
    yield c.ok(output)

    logger.writeln(`Dashboard running at ${output.url}`)
    logger.writeln("Waiting for runs...")
    logger.writeln("Press Ctrl+C to stop.")

    const { promise, resolve } = Promise.withResolvers<void>()
    let signalCount = 0
    const onSignal = () => {
      signalCount++
      if (signalCount > 1) {
        logger.writeln("")
        logger.writeln("Forcing dashboard shutdown...")
        process.exit(130)
      }
      resolve()
    }
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)

    try {
      await promise
    } finally {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      logger.writeln("")
      logger.writeln("Shutting down dashboard...")
      await server.shutdown()
    }
  },
})
