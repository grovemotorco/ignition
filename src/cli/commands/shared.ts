/**
 * Shared execution logic for `run` and `check` commands.
 */

import { Command } from "@cliffy/command"
import { resolve } from "node:path"
import type { RunCheckOptions } from "../types.ts"
import {
  buildVarsRecord,
  collectTags,
  collectVarEntry,
  ErrorModeType,
  HostKeyPolicyType,
  OutputFormatType,
  parseDashboardAddress,
  parseDashboardOption,
  requireNonNegativeInt,
  requirePositiveInt,
} from "../parsers.ts"
import { CliExitCode } from "../runtime.ts"
import { loadInventory, resolveTargets } from "../../inventory/loader.ts"
import { createSystemSSHConnection } from "../../ssh/connection.ts"
import { runRecipe } from "../../core/runner.ts"
import { PrettyReporter, QuietReporter } from "../../output/reporter.ts"
import { JsonFormatter, MinimalFormatter } from "../../output/formats.ts"
import { EventBus } from "../../output/events.ts"
import { DashboardServer } from "../../dashboard/server.ts"
import { DashboardClient } from "../../dashboard/client.ts"
import { FileLogSink } from "../../output/log_sink.ts"
import { FileCheckResultCache } from "../../core/cache.ts"
import type { HostKeyPolicy, SSHConnection } from "../../ssh/types.ts"
import type { CheckResultCache, HostContext, RunMode, RunSummary } from "../../core/types.ts"
import type { Inventory, ResolvedHost } from "../../inventory/types.ts"
import { loadConfig, mergeWithConfig } from "../../lib/config.ts"
import { muted, warning } from "../../lib/colors.ts"

// ---------------------------------------------------------------------------
// Recipe command factory
// ---------------------------------------------------------------------------

function createRecipeCommand(mode: RunMode, description: string) {
  return new Command()
    .description(description)
    .type("output-format", OutputFormatType)
    .type("error-mode", ErrorModeType)
    .type("host-key-policy", HostKeyPolicyType)
    .option("-i, --inventory <file:string>", "Inventory file path.")
    .option("-v, --verbose", "Show SSH commands and detailed output.")
    .option("-f, --format <format:output-format>", "Output format (pretty|json|minimal).")
    .option("--error-mode <mode:error-mode>", "How to handle resource failures.")
    .option("--tags <tags:string>", "Filter resources by tag (comma-separated).", {
      collect: true,
      value: collectTags,
    })
    .option("--var <keyValue:string>", "Set variable as key=value (repeatable).", {
      collect: true,
      value: collectVarEntry,
    })
    .option("--confirm", "Prompt before applying changes.")
    .option("--host-key-policy <policy:host-key-policy>", "SSH host key verification policy.")
    .option("--identity <keyPath:string>", "Path to SSH private key.")
    .option("--no-multiplex", "Disable SSH connection multiplexing.")
    .option("--parallelism <n:integer>", "Max concurrent hosts.", {
      value: (value: number) => requirePositiveInt("--parallelism", value),
    })
    .option("--host-timeout <ms:integer>", "Per-host timeout in ms (0 = unlimited).", {
      value: (value: number) => requireNonNegativeInt("--host-timeout", value),
    })
    .option("--resource-timeout <ms:integer>", "Per-resource timeout in ms (0 = unlimited).", {
      value: (value: number) => requireNonNegativeInt("--resource-timeout", value),
    })
    .option("--retries <n:integer>", "Retry attempts for transient failures.", {
      value: (value: number) => requireNonNegativeInt("--retries", value),
    })
    .option("--retry-delay <ms:integer>", "Initial retry backoff in ms.", {
      value: (value: number) => requireNonNegativeInt("--retry-delay", value),
    })
    .option("--cache", "Cache check results across runs.")
    .option("--cache-ttl <ms:integer>", "Cache entry lifetime in ms.", {
      value: (value: number) => requireNonNegativeInt("--cache-ttl", value),
    })
    .option("--cache-clear", "Clear cache before running.")
    .option("--dashboard [address:string]", "Start web dashboard [host:port].", {
      value: parseDashboardOption,
    })
    .option("--log-dir <dir:string>", "Directory for structured NDJSON run logs.")
    .arguments("<recipe:string> <targets...:string>")
    .action(async (options, recipe, ...targets) => {
      const mapped: RunCheckOptions = {
        inventory: options.inventory,
        verbose: options.verbose,
        format: options.format,
        errorMode: options.errorMode,
        tags: options.tags ?? [],
        vars: buildVarsRecord(options.var ?? []),
        confirm: options.confirm,
        hostKeyPolicy: options.hostKeyPolicy,
        identity: options.identity,
        multiplex: options.multiplex === false ? false : undefined,
        parallelism: options.parallelism,
        hostTimeout: options.hostTimeout,
        resourceTimeout: options.resourceTimeout,
        retries: options.retries,
        retryDelay: options.retryDelay,
        cache: options.cache,
        cacheTtl: options.cacheTtl,
        cacheClear: options.cacheClear,
        dashboard: options.dashboard,
        logDir: options.logDir,
      }
      const code = await executeRecipeCommand({ mode, recipe, targets, options: mapped })
      if (code !== 0) throw new CliExitCode(code)
    })
}

export const run = createRecipeCommand("apply", "Apply a recipe to target hosts.")
export const check = createRecipeCommand("check", "Dry-run a recipe against target hosts.")

// ---------------------------------------------------------------------------
// Execution logic
// ---------------------------------------------------------------------------

export interface ExecuteRecipeArgs {
  readonly mode: RunMode
  readonly recipe: string
  readonly targets: readonly string[]
  readonly options: RunCheckOptions
}

async function connectHost(
  host: ResolvedHost,
  hostKeyPolicy: HostKeyPolicy,
  multiplex: boolean,
): Promise<SSHConnection> {
  return await createSystemSSHConnection({
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    privateKey: host.privateKey,
    hostKeyPolicy,
    multiplexing: multiplex,
  })
}

function toHostContext(host: ResolvedHost): HostContext {
  return {
    name: host.name,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    vars: host.vars,
  }
}

function formatOutput(summary: RunSummary, mode: RunMode, format: string): string | undefined {
  switch (format) {
    case "json":
      return new JsonFormatter().format(summary)
    case "minimal":
      return new MinimalFormatter(mode).format(summary)
    case "pretty":
      return undefined
    default:
      return undefined
  }
}

interface ResolveResult {
  hosts: ResolvedHost[]
  inventory: Inventory
}

async function resolveHosts(
  targets: readonly string[],
  inventoryFile?: string,
  verbose?: boolean,
): Promise<ResolveResult> {
  let inventory: Inventory = {}
  let inventoryUrl: string | undefined

  if (inventoryFile) {
    const inventoryPath = resolve(process.cwd(), inventoryFile)
    inventoryUrl = new URL(`file://${inventoryPath}`).href
    if (verbose) {
      console.error(muted(`  Loading inventory from: ${inventoryPath}`))
    }
    const loaded = await loadInventory(inventoryUrl)
    inventory = loaded.inventory
    if (verbose) {
      const groupCount = Object.keys(inventory.groups ?? {}).length
      const hostCount = Object.keys(inventory.hosts ?? {}).length
      console.error(
        muted(`  Inventory loaded: ${groupCount} group(s), ${hostCount} standalone host(s)`),
      )
    }
  }

  if (verbose) {
    console.error(muted(`  Resolving targets: ${targets.join(", ")}`))
  }

  const hosts = inventoryUrl
    ? resolveTargets(inventory, targets, inventoryUrl)
    : resolveTargets({}, targets)

  if (verbose) {
    console.error(
      muted(`  Resolved ${hosts.length} host(s): ${hosts.map((h) => h.name).join(", ")}`),
    )
  }

  return { hosts, inventory }
}

export async function executeRecipeCommand(args: ExecuteRecipeArgs): Promise<number> {
  const { mode } = args
  const config = await loadConfig(process.cwd())
  const options = mergeWithConfig(args.options, config)

  const recipePath = resolve(process.cwd(), args.recipe)
  const recipeUrl = new URL(`file://${recipePath}`).href

  const { hosts: resolvedHosts, inventory } = await resolveHosts(
    args.targets,
    options.inventory,
    options.verbose,
  )

  if (resolvedHosts.length === 0) {
    console.error(warning("No hosts matched the target specifier(s)."))
    const groups = Object.keys(inventory.groups ?? {})
    const hosts = Object.keys(inventory.hosts ?? {})
    if (groups.length > 0) {
      console.error(muted(`  Available groups: ${groups.map((g) => `@${g}`).join(", ")}`))
    }
    if (hosts.length > 0) {
      console.error(muted(`  Available hosts: ${hosts.join(", ")}`))
    }
    if (groups.length === 0 && hosts.length === 0 && options.inventory) {
      console.error(muted("  The inventory appears to be empty."))
    }
    return 1
  }

  if (mode === "apply" && options.confirm) {
    const hostNames = resolvedHosts.map((h) => h.name).join(", ")
    console.log(`Will apply to: ${hostNames}`)
    const answer = prompt("Continue? [y/N]")
    if (answer?.toLowerCase() !== "y") {
      console.log("Aborted.")
      return 0
    }
  }

  // Apply --identity to hosts that don't already have a privateKey from inventory
  const finalHosts = options.identity
    ? resolvedHosts.map((h) => (h.privateKey ? h : { ...h, privateKey: options.identity }))
    : resolvedHosts

  const hosts: Array<{ host: HostContext; connection: SSHConnection }> = []
  for (const resolved of finalHosts) {
    const connection = await connectHost(resolved, options.hostKeyPolicy, options.multiplex)
    hosts.push({ host: toHostContext(resolved), connection })
  }

  const reporter = options.format === "pretty" ? new PrettyReporter({ mode }) : new QuietReporter()

  let cache: CheckResultCache | undefined
  if (mode === "check" && options.cache) {
    cache = new FileCheckResultCache({ ttlMs: options.cacheTtl })
    if (options.cacheClear) {
      cache.clear()
    }
  }

  let dashboard: DashboardServer | undefined
  let dashboardClient: DashboardClient | undefined
  let dashboardUnsub: (() => void) | undefined
  let eventBus: EventBus | undefined
  let viteHandle: { url: string; close(): Promise<void> } | undefined

  if (options.dashboard) {
    const [hostname, port] = parseDashboardAddress(options.dashboard)
    const bus = new EventBus()

    const running = await DashboardClient.probe(hostname, port)
    if (running) {
      try {
        dashboardClient = new DashboardClient(`ws://${hostname}:${port}/ws/push`)
        await dashboardClient.connect()
        dashboardUnsub = bus.on(dashboardClient.listener)
        console.error(`Dashboard (remote): http://${hostname}:${port}`)
        eventBus = bus
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `Dashboard warning: remote connection failed (${message}). Continuing without dashboard.`,
        )
      }
    } else {
      try {
        dashboard = new DashboardServer({ hostname, port })
        await dashboard.start()
        dashboardUnsub = bus.on(dashboard.listener)

        try {
          const { canStartViteDev, startViteDev } = await import("../../dashboard/vite-dev.ts")
          if (await canStartViteDev()) {
            viteHandle = await startViteDev({ apiHostname: hostname, apiPort: dashboard.port })
            console.error(`Dashboard (dev): ${viteHandle.url}`)
          }
        } catch {
          /* production — no vite available */
        }

        if (!viteHandle) {
          console.error(`Dashboard: http://${hostname}:${dashboard.port}`)
        }
        eventBus = bus
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `Dashboard warning: failed to start local server (${message}). Continuing without dashboard.`,
        )
      }
    }
  }

  let logSink: FileLogSink | undefined
  let logSinkUnsub: (() => void) | undefined
  if (options.logDir) {
    if (!eventBus) {
      eventBus = new EventBus()
    }
    logSink = new FileLogSink({ logDir: options.logDir })
    logSinkUnsub = eventBus.on(logSink.listener)
  }

  try {
    const summary = await runRecipe({
      recipe: recipeUrl,
      hosts,
      mode,
      errorMode: options.errorMode,
      verbose: options.verbose,
      reporter,
      vars: options.vars,
      tags: options.tags,
      concurrency: {
        parallelism: options.parallelism,
        hostTimeout: options.hostTimeout,
      },
      resourcePolicy: {
        timeoutMs: options.resourceTimeout,
        retries: options.retries,
        retryDelayMs: options.retryDelay,
      },
      cache,
      eventBus,
    })

    const output = formatOutput(summary, mode, options.format)
    if (output) {
      console.log(output)
    }
    return summary.hasFailures ? 1 : 0
  } finally {
    logSinkUnsub?.()
    logSink?.close()
    dashboardUnsub?.()
    if (viteHandle) await viteHandle.close()
    if (dashboardClient) await dashboardClient.close()
    if (dashboard) await dashboard.shutdown()
  }
}
