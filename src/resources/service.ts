/**
 * service() resource — manage systemd services on target hosts.
 *
 * `check()` queries systemctl for active/enabled state.
 * `apply()` starts/stops/restarts/reloads and enables/disables services.
 */

import type {
  CheckResult,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceSchema,
} from "../core/types.ts"
import { executeResource, requireCapability } from "../core/resource.ts"

/** Input options for the service resource. */
export type ServiceInput = {
  /** Service name (e.g. "nginx"). */
  name: string
  /** Desired service state. */
  state?: "started" | "stopped" | "restarted" | "reloaded" | undefined
  /** Whether the service should be enabled at boot. */
  enabled?: boolean | undefined
}

/** Output of a successful service resource. */
export type ServiceOutput = {
  name: string
  active: string
  enabled: string
  changed: boolean
}

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Schema for the service resource. */
export const serviceSchema: ResourceSchema = {
  description: "Manage systemd services — start, stop, restart, reload, enable, and disable.",
  whenToUse: [
    "Starting or stopping a systemd service",
    "Enabling or disabling a service at boot",
    "Restarting a service after configuration changes",
    "Reloading a service to pick up config changes without downtime",
  ],
  doNotUseFor: [
    "Installing software (use apt instead)",
    "Running arbitrary commands (use exec instead)",
    "Managing non-systemd services or init scripts",
  ],
  triggerPatterns: [
    "start service",
    "stop service",
    "restart nginx",
    "enable service",
    "reload service",
    "ensure service is running",
  ],
  hints: [
    'state "started" and "stopped" are declarative — they only act if needed (idempotent)',
    'state "restarted" and "reloaded" are imperative — they always run, even if already in the target state',
    "enabled controls boot behavior independently of state — you can set both",
    "Not idempotent overall because restarted/reloaded always execute (imperative actions)",
    "Uses sudo for all systemctl operations (start, stop, enable, disable)",
    "state is optional — you can set only enabled without changing the running state",
  ],
  input: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: 'Service name (e.g. "nginx")' },
      state: {
        type: "string",
        enum: ["started", "stopped", "restarted", "reloaded"],
        description: "Desired service state",
      },
      enabled: {
        type: "boolean",
        description: "Whether the service should be enabled at boot",
      },
    },
  },
  output: {
    type: "object",
    properties: {
      name: { type: "string", description: "Service name" },
      active: { type: "string", description: 'Current active state (e.g. "active", "inactive")' },
      enabled: {
        type: "string",
        description: 'Current enabled state (e.g. "enabled", "disabled")',
      },
      changed: { type: "boolean", description: "Whether the service was modified" },
    },
  },
  examples: [
    {
      title: "Start and enable nginx",
      description: "Ensure nginx is running and enabled at boot",
      input: { name: "nginx", state: "started", enabled: true },
      naturalLanguage: "Start nginx and enable it at boot",
    },
    {
      title: "Restart a service after config change",
      description: "Force restart a service (imperative, always runs)",
      input: { name: "nginx", state: "restarted" },
      naturalLanguage: "Restart nginx to pick up the new configuration",
    },
    {
      title: "Stop and disable a service",
      description: "Stop a service and prevent it from starting at boot",
      input: { name: "apache2", state: "stopped", enabled: false },
    },
  ],
  nature: "imperative",
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
  },
  requiredCapabilities: ["exec"],
}

/** ResourceDefinition for service. */
export const serviceDefinition: ResourceDefinition<ServiceInput, ServiceOutput> = {
  type: "service",
  schema: serviceSchema,

  formatName(input: ServiceInput): string {
    return input.name
  },

  async check(ctx: ExecutionContext, input: ServiceInput): Promise<CheckResult<ServiceOutput>> {
    requireCapability(ctx, "exec", "service")
    const activeResult = await ctx.connection.exec(
      `systemctl is-active ${shellQuote(input.name)} 2>/dev/null || true`,
    )
    const enabledResult = await ctx.connection.exec(
      `systemctl is-enabled ${shellQuote(input.name)} 2>/dev/null || true`,
    )

    const currentActive = activeResult.stdout.trim()
    const currentEnabled = enabledResult.stdout.trim()

    const current: Record<string, unknown> = {
      active: currentActive,
      enabled: currentEnabled,
    }
    const desired: Record<string, unknown> = {}

    let inDesiredState = true

    // restarted/reloaded are imperative — always run
    if (input.state === "restarted" || input.state === "reloaded") {
      desired.state = input.state
      inDesiredState = false
    } else if (input.state === "started" && currentActive !== "active") {
      desired.state = "started"
      inDesiredState = false
    } else if (input.state === "stopped" && currentActive !== "inactive") {
      desired.state = "stopped"
      inDesiredState = false
    }

    if (input.enabled === true && currentEnabled !== "enabled") {
      desired.enabled = true
      inDesiredState = false
    } else if (input.enabled === false && currentEnabled !== "disabled") {
      desired.enabled = false
      inDesiredState = false
    }

    if (inDesiredState) {
      return {
        inDesiredState: true,
        current,
        desired,
        output: {
          name: input.name,
          active: currentActive,
          enabled: currentEnabled,
          changed: false,
        },
      }
    }

    return { inDesiredState: false, current, desired }
  },

  async apply(ctx: ExecutionContext, input: ServiceInput): Promise<ServiceOutput> {
    requireCapability(ctx, "exec", "service")
    // Handle state
    if (input.state === "started") {
      await ctx.connection.exec(`sudo systemctl start ${shellQuote(input.name)}`)
    } else if (input.state === "stopped") {
      await ctx.connection.exec(`sudo systemctl stop ${shellQuote(input.name)}`)
    } else if (input.state === "restarted") {
      await ctx.connection.exec(`sudo systemctl restart ${shellQuote(input.name)}`)
    } else if (input.state === "reloaded") {
      await ctx.connection.exec(`sudo systemctl reload ${shellQuote(input.name)}`)
    }

    // Handle enabled
    if (input.enabled === true) {
      await ctx.connection.exec(`sudo systemctl enable ${shellQuote(input.name)}`)
    } else if (input.enabled === false) {
      await ctx.connection.exec(`sudo systemctl disable ${shellQuote(input.name)}`)
    }

    // Query final state
    const activeResult = await ctx.connection.exec(
      `systemctl is-active ${shellQuote(input.name)} 2>/dev/null || true`,
    )
    const enabledResult = await ctx.connection.exec(
      `systemctl is-enabled ${shellQuote(input.name)} 2>/dev/null || true`,
    )

    return {
      name: input.name,
      active: activeResult.stdout.trim(),
      enabled: enabledResult.stdout.trim(),
      changed: true,
    }
  },
}

/**
 * Create a bound `service()` function for a given execution context.
 *
 * Usage in recipes:
 * ```ts
 * const service = createService(ctx)
 * await service({ name: 'nginx', state: 'started', enabled: true })
 * ```
 */
export function createService(
  ctx: ExecutionContext,
): (
  input: ServiceInput,
  meta?: ResourceCallMeta,
) => Promise<import("../core/types.ts").ResourceResult<ServiceOutput>> {
  return (input: ServiceInput, meta?: ResourceCallMeta) =>
    executeResource(ctx, serviceDefinition, input, ctx.resourcePolicy, meta)
}
