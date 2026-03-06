import { Cli, z } from "incur"
import { resolve } from "node:path"
import { loadInventory, resolveTargets } from "../../inventory/loader.ts"
import { createSystemSSHConnection } from "../../ssh/connection.ts"
import { runRecipe } from "../../core/runner.ts"
import { PrettyReporter, QuietReporter } from "../../output/reporter.ts"
import { EventBus } from "../../output/events.ts"
import { DashboardClient } from "../../dashboard/client.ts"
import { FileLogSink } from "../../output/log_sink.ts"
import { FileCheckResultCache } from "../../core/cache.ts"
import type { HostKeyPolicy, SSHConnection } from "../../ssh/types.ts"
import type { CheckResultCache, HostContext, RunMode } from "../../core/types.ts"
import type { Inventory, ResolvedHost } from "../../inventory/types.ts"
import { loadConfig, mergeWithConfig } from "../../lib/config.ts"
import type { RunCheckOptions } from "../../lib/types.ts"
import { muted } from "../../lib/colors.ts"
import { stderrPrompt } from "../../lib/prompt.ts"
import { disabledLogger, loggerVarsSchema, type HumanLogger } from "../logger.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseVar(raw: string): [string, unknown] {
  const eqIdx = raw.indexOf("=")
  if (eqIdx === -1) return [raw, true]

  const key = raw.slice(0, eqIdx)
  const value = raw.slice(eqIdx + 1)

  if (value === "true") return [key, true]
  if (value === "false") return [key, false]

  const num = Number(value)
  if (!isNaN(num) && value.length > 0) return [key, num]

  return [key, value]
}

function buildVarsRecord(entries: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const raw of entries) {
    const [key, value] = parseVar(raw)
    vars[key] = value
  }
  return vars
}

// ---------------------------------------------------------------------------
// Host resolution
// ---------------------------------------------------------------------------

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

type ResolveResult = {
  hosts: ResolvedHost[]
  inventory: Inventory
}

async function resolveHosts(
  targets: string[],
  inventoryFile?: string,
  trace?: boolean,
  logger: HumanLogger = disabledLogger,
): Promise<ResolveResult> {
  let inventory: Inventory = {}
  let inventoryUrl: string | undefined

  if (inventoryFile) {
    const inventoryPath = resolve(process.cwd(), inventoryFile)
    inventoryUrl = new URL(`file://${inventoryPath}`).href
    if (trace) {
      logger.writeln(muted(`  Loading inventory from: ${inventoryPath}`))
    }
    const loaded = await loadInventory(inventoryUrl)
    inventory = loaded.inventory
    if (trace) {
      const groupCount = Object.keys(inventory.groups ?? {}).length
      const hostCount = Object.keys(inventory.hosts ?? {}).length
      logger.writeln(
        muted(`  Inventory loaded: ${groupCount} group(s), ${hostCount} standalone host(s)`),
      )
    }
  }

  if (trace) {
    logger.writeln(muted(`  Resolving targets: ${targets.join(", ")}`))
  }

  const hosts = inventoryUrl
    ? resolveTargets(inventory, targets, inventoryUrl)
    : resolveTargets({}, targets)

  if (trace) {
    logger.writeln(
      muted(`  Resolved ${hosts.length} host(s): ${hosts.map((h) => h.name).join(", ")}`),
    )
  }

  return { hosts, inventory }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/** CLI command that runs a recipe against one or more resolved targets. */
export const run = Cli.create("run", {
  description: "Apply a recipe to target hosts (use --check for dry-run)",
  vars: loggerVarsSchema,
  args: z.object({
    recipe: z.string().describe("Recipe file path"),
    targets: z.string().describe("Target hosts, @groups, or hostnames (comma-separated)"),
  }),
  options: z.object({
    check: z.boolean().optional().describe("Dry-run without applying changes"),
    inventory: z.string().optional().describe("Inventory file path"),
    errorMode: z
      .enum(["fail-fast", "fail-at-end", "ignore"])
      .optional()
      .describe("How to handle resource failures"),
    tags: z.array(z.string()).optional().describe("Filter resources by tag"),
    var: z.array(z.string()).optional().describe("Set variable as key=value"),
    confirm: z.boolean().optional().describe("Prompt before applying changes"),
    hostKeyPolicy: z
      .enum(["strict", "accept-new", "off"])
      .optional()
      .describe("SSH host key verification policy"),
    identity: z.string().optional().describe("Path to SSH private key"),
    noMultiplex: z.boolean().optional().describe("Disable SSH connection multiplexing"),
    parallelism: z.number().int().min(1).optional().describe("Max concurrent hosts"),
    hostTimeout: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Per-host timeout in ms (0 = unlimited)"),
    resourceTimeout: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Per-resource timeout in ms (0 = unlimited)"),
    retries: z.number().int().min(0).optional().describe("Retry attempts for transient failures"),
    retryDelay: z.number().int().min(0).optional().describe("Initial retry backoff in ms"),
    cache: z.boolean().optional().describe("Cache check results across runs"),
    cacheTtl: z.number().int().min(0).optional().describe("Cache entry lifetime in ms"),
    cacheClear: z.boolean().optional().describe("Clear cache before running"),
    dashboardHost: z.string().optional().describe("Dashboard server hostname (default: 127.0.0.1)"),
    dashboardPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("Dashboard server port (default: 9090)"),
    logDir: z.string().optional().describe("Directory for structured NDJSON run logs"),
    trace: z.boolean().optional().describe("Show SSH commands and detailed execution output"),
  }),
  output: z.object({
    mode: z.enum(["apply", "check"]),
    hasFailures: z.boolean(),
    hosts: z.array(
      z.object({
        name: z.string(),
        ok: z.number(),
        changed: z.number(),
        failed: z.number(),
      }),
    ),
  }),
  async run(c) {
    const mode: RunMode = c.options.check ? "check" : "apply"
    const logger = c.var.logger

    const targets = c.args.targets
      .split(",")
      .map((t: string) => t.trim())
      .filter(Boolean)

    // 1. Load config and merge with CLI options
    const config = await loadConfig(process.cwd())
    const cliOpts: RunCheckOptions = {
      inventory: c.options.inventory,
      trace: c.options.trace,
      errorMode: c.options.errorMode,
      tags: c.options.tags ?? [],
      vars: buildVarsRecord(c.options.var ?? []),
      confirm: c.options.confirm,
      hostKeyPolicy: c.options.hostKeyPolicy,
      identity: c.options.identity,
      multiplex: c.options.noMultiplex ? false : undefined,
      parallelism: c.options.parallelism,
      hostTimeout: c.options.hostTimeout,
      resourceTimeout: c.options.resourceTimeout,
      retries: c.options.retries,
      retryDelay: c.options.retryDelay,
      cache: c.options.cache,
      cacheTtl: c.options.cacheTtl,
      cacheClear: c.options.cacheClear,
      dashboardHost: c.options.dashboardHost,
      dashboardPort: c.options.dashboardPort,
      logDir: c.options.logDir,
    }
    const options = mergeWithConfig(cliOpts, config)

    // 2. Resolve recipe file
    const recipePath = resolve(process.cwd(), c.args.recipe)
    const recipeUrl = new URL(`file://${recipePath}`).href

    // 3. Resolve hosts from inventory + targets
    const { hosts: resolvedHosts, inventory } = await resolveHosts(
      targets,
      options.inventory,
      options.trace,
      logger,
    )

    if (resolvedHosts.length === 0) {
      const groups = Object.keys(inventory.groups ?? {})
      const hosts = Object.keys(inventory.hosts ?? {})
      let message = "No hosts matched the target specifier(s)."
      if (groups.length > 0) {
        message += `\n  Available groups: ${groups.map((g) => `@${g}`).join(", ")}`
      }
      if (hosts.length > 0) {
        message += `\n  Available hosts: ${hosts.join(", ")}`
      }
      if (groups.length === 0 && hosts.length === 0 && options.inventory) {
        message += "\n  The inventory appears to be empty."
      }
      return c.error({ code: "NO_HOSTS", message })
    }

    // 4. Confirmation prompt (apply mode only)
    if (mode === "apply" && options.confirm) {
      const hostNames = resolvedHosts.map((h) => h.name).join(", ")
      logger.writeln(`Will apply to: ${hostNames}`)
      const answer = await stderrPrompt("Continue? [y/N] ")
      if (answer === null) {
        return c.error({
          code: "CONFIRM_NO_TTY",
          message:
            "Cannot prompt for confirmation: stdin is not a terminal. Remove --confirm or pipe 'y'.",
        })
      }
      if (answer.toLowerCase() !== "y") {
        logger.writeln("Aborted.")
        return c.ok({ mode, hasFailures: false, hosts: [] })
      }
    }

    // 5. Apply --identity to hosts without a privateKey from inventory
    const finalHosts = options.identity
      ? resolvedHosts.map((h) => (h.privateKey ? h : { ...h, privateKey: options.identity }))
      : resolvedHosts

    // 6. SSH connections
    const connectedHosts: Array<{ host: HostContext; connection: SSHConnection }> = []
    for (const resolved of finalHosts) {
      const connection = await connectHost(resolved, options.hostKeyPolicy, options.multiplex)
      connectedHosts.push({ host: toHostContext(resolved), connection })
    }

    // 7. Reporter selection
    const pretty = !c.agent && !c.formatExplicit
    const reporter = pretty ? new PrettyReporter({ mode }) : new QuietReporter()

    // 8. Cache setup (check mode only)
    let cache: CheckResultCache | undefined
    if (mode === "check" && options.cache) {
      cache = new FileCheckResultCache({ ttlMs: options.cacheTtl })
      if (options.cacheClear) {
        cache.clear()
      }
    }

    // 9. EventBus, dashboard client, and log sink setup
    let eventBus: EventBus | undefined
    let dashboardClient: DashboardClient | undefined
    let dashboardUnsub: (() => void) | undefined
    let logSink: FileLogSink | undefined
    let logSinkUnsub: (() => void) | undefined

    {
      const dHost = options.dashboardHost
      const dPort = options.dashboardPort
      const reachable = await DashboardClient.probe(dHost, dPort)
      if (reachable) {
        try {
          if (!eventBus) eventBus = new EventBus()
          dashboardClient = new DashboardClient(`ws://${dHost}:${dPort}/ws/push`)
          await dashboardClient.connect()
          dashboardUnsub = eventBus.on(dashboardClient.listener)
          logger.writeln(muted(`Dashboard: http://${dHost}:${dPort}`))
        } catch {
          dashboardClient = undefined
        }
      }
    }

    if (options.logDir) {
      if (!eventBus) eventBus = new EventBus()
      logSink = new FileLogSink({ logDir: options.logDir })
      logSinkUnsub = eventBus.on(logSink.listener)
    }

    // 10. Run recipe
    try {
      const summary = await runRecipe({
        recipe: recipeUrl,
        hosts: connectedHosts,
        mode,
        errorMode: options.errorMode,
        verbose: options.trace,
        reporter,
        vars: options.vars,
        tags: options.tags ? [...options.tags] : undefined,
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

      const hostResults = summary.hosts.map((h) => ({
        name: h.host.name,
        ok: h.ok,
        changed: h.changed,
        failed: h.failed,
      }))

      if (summary.hasFailures) {
        process.exitCode = 1
        return c.ok(
          { mode, hasFailures: true, hosts: hostResults },
          {
            cta: {
              commands: [
                {
                  command: `run --check ${c.args.recipe} ${c.args.targets}`,
                  description: "Re-run in check mode to inspect",
                },
              ],
            },
          },
        )
      }
      return c.ok({ mode, hasFailures: false, hosts: hostResults })
    } finally {
      logSinkUnsub?.()
      logSink?.close()
      dashboardUnsub?.()
      if (dashboardClient) await dashboardClient.close()
    }
  },
})
