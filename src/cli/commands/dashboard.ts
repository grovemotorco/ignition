import { Command } from "@cliffy/command"
import { collectVarEntry, parseDashboardAddress, parseHistoryVar } from "../parsers.ts"
import { CliExitCode } from "../runtime.ts"
import { DashboardServer } from "../../dashboard/server.ts"

export interface DashboardCommandArgs {
  readonly hostname: string
  readonly port: number
  readonly maxHistory: number
}

export async function dashboardCommand(args: DashboardCommandArgs): Promise<number> {
  const { port, hostname, maxHistory } = args

  const server = new DashboardServer({ port, hostname, maxHistory })
  await server.start()

  let viteHandle: { url: string; close(): Promise<void> } | undefined
  try {
    const { canStartViteDev, startViteDev } = await import("../../dashboard/vite-dev.ts")
    if (await canStartViteDev()) {
      viteHandle = await startViteDev({ apiHostname: hostname, apiPort: server.port })
      console.log(`Dashboard (dev): ${viteHandle.url}`)
    }
  } catch {
    /* production — no vite available */
  }

  if (!viteHandle) {
    console.log(`Dashboard running at http://${hostname}:${server.port}`)
  }
  console.log(`Waiting for runs... (connect with --dashboard ${hostname}:${server.port})`)
  console.log("Press Ctrl+C to stop.")

  const { promise, resolve } = Promise.withResolvers<void>()
  const onSignal = () => resolve()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    await promise
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    console.log("\nShutting down dashboard...")
    if (viteHandle) await viteHandle.close()
    await server.shutdown()
  }

  return 0
}

export const dashboard = new Command()
  .description("Start a persistent web dashboard.")
  .option("--var <keyValue:string>", "Variable override as key=value.", {
    collect: true,
    value: collectVarEntry,
  })
  .option("-v, --verbose", "Enable verbose output.")
  .arguments("[address:string]")
  .action(async (options, address) => {
    let hostname = "127.0.0.1"
    let port = 9090

    if (address) {
      ;[hostname, port] = parseDashboardAddress(address)
    }

    const code = await dashboardCommand({
      hostname,
      port,
      maxHistory: parseHistoryVar(options.var ?? []),
    })
    if (code !== 0) throw new CliExitCode(code)
  })
