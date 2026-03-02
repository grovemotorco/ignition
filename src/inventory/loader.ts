/**
 * Inventory loader — dynamically imports an inventory .ts file, validates its
 * shape, and resolves target specifiers to concrete host connection details.
 *
 * The loaded module must default-export an `Inventory` object. Target resolution
 * supports `@group` references, host names, comma-separated lists, and ad-hoc
 * `user@host:port` targets. See ADR-0007 and ISSUE-0010.
 */

import { InventoryError } from "../core/errors.ts"
import type { Host, Inventory, InventoryModule, ResolvedHost } from "./types.ts"

/** Default SSH user when none is specified. */
const DEFAULT_USER = "root"
/** Default SSH port when none is specified. */
const DEFAULT_PORT = 22

/**
 * Load an inventory module from a `.ts` file path via dynamic `import()`.
 *
 * Validates:
 * - The module has a default export that is an object.
 *
 * Returns an `InventoryModule` with the resolved inventory and path.
 * Throws `InventoryError` on any failure.
 */
export async function loadInventory(path: string): Promise<InventoryModule> {
  let mod: any
  try {
    mod = await import(path)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    throw new InventoryError(path, `Failed to load inventory: ${error.message}`, error)
  }

  return validateInventoryModule(mod, path)
}

/** Validate an inventory module's shape and extract the inventory. */
function validateInventoryModule(mod: any, path: string): InventoryModule {
  // Validate default export
  if (typeof mod.default !== "object" || mod.default === null || Array.isArray(mod.default)) {
    throw new InventoryError(
      path,
      `Inventory file must default-export an object, got ${Array.isArray(mod.default) ? "array" : typeof mod.default}`,
    )
  }

  return {
    inventory: mod.default as Inventory,
    path,
  }
}

/**
 * Parse an ad-hoc target string like `user@host:port` or `host` into a
 * `ResolvedHost`. Supports:
 * - `hostname`
 * - `user@hostname`
 * - `hostname:port`
 * - `user@hostname:port`
 */
function parseAdHocTarget(target: string): ResolvedHost {
  let user = DEFAULT_USER
  let hostname = target
  let port = DEFAULT_PORT

  // Extract user@ prefix
  const atIdx = hostname.indexOf("@")
  if (atIdx !== -1) {
    user = hostname.slice(0, atIdx)
    hostname = hostname.slice(atIdx + 1)
  }

  // Extract :port suffix
  const colonIdx = hostname.lastIndexOf(":")
  if (colonIdx !== -1) {
    const portStr = hostname.slice(colonIdx + 1)
    const parsed = parseInt(portStr, 10)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed
      hostname = hostname.slice(0, colonIdx)
    }
  }

  return {
    name: target,
    hostname,
    user,
    port,
    vars: {},
  }
}

/**
 * Resolve a single host entry from inventory into a `ResolvedHost`, merging
 * variables with the correct precedence: host vars > group vars > global vars.
 */
function resolveHost(
  name: string,
  host: Host,
  inventory: Inventory,
  groupVars?: Record<string, unknown>,
): ResolvedHost {
  const user = host.user ?? inventory.defaults?.user ?? DEFAULT_USER
  const port = host.port ?? inventory.defaults?.port ?? DEFAULT_PORT
  const privateKey = host.privateKey ?? inventory.defaults?.privateKey

  // Merge variables: host vars > group vars > global vars
  const vars: Record<string, unknown> = {
    ...inventory.vars,
    ...groupVars,
    ...host.vars,
  }

  return {
    name,
    hostname: host.hostname,
    user,
    port,
    ...(privateKey !== undefined ? { privateKey } : {}),
    vars,
  }
}

/**
 * Look up a host by name across all inventory locations (standalone hosts and
 * group hosts). Returns the host entry and its group vars if found in a group.
 */
function findHost(
  name: string,
  inventory: Inventory,
): { host: Host; groupVars?: Record<string, unknown> } | undefined {
  // Check standalone hosts first
  if (inventory.hosts?.[name]) {
    return { host: inventory.hosts[name] }
  }

  // Check group hosts
  if (inventory.groups) {
    for (const group of Object.values(inventory.groups)) {
      if (group.hosts[name]) {
        return { host: group.hosts[name], groupVars: group.vars }
      }
    }
  }

  return undefined
}

/**
 * Resolve target specifiers against an inventory to produce concrete hosts.
 *
 * Supports:
 * - `@groupName` -- all hosts in the named group
 * - `hostName` -- a named host in the inventory (standalone or in a group)
 * - `user@host:port` -- ad-hoc target (bypasses inventory)
 * - Comma-separated lists -- `web-1,web-2,@db`
 *
 * Throws `InventoryError` if a target cannot be resolved.
 */
export function resolveTargets(
  inventory: Inventory,
  targets: readonly string[],
  inventoryPath = "<inline>",
): ResolvedHost[] {
  const resolved: ResolvedHost[] = []
  const seen = new Set<string>()

  for (const raw of targets) {
    // Split comma-separated targets
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const target of parts) {
      if (target.startsWith("@")) {
        // Group reference
        const groupName = target.slice(1)
        const group = inventory.groups?.[groupName]
        if (!group) {
          const available = Object.keys(inventory.groups ?? {})
          const suggestion = findClosest(groupName, available)
          let msg = `Unknown group "${groupName}" in target "${target}"`
          if (suggestion) {
            msg += `. Did you mean @${suggestion}?`
          } else if (available.length > 0) {
            msg += `. Available groups: ${available.map((g) => `@${g}`).join(", ")}`
          }
          throw new InventoryError(inventoryPath, msg)
        }

        for (const [hostName, host] of Object.entries(group.hosts)) {
          if (!seen.has(hostName)) {
            seen.add(hostName)
            resolved.push(resolveHost(hostName, host, inventory, group.vars))
          }
        }
      } else {
        // Try named host lookup
        const found = findHost(target, inventory)
        if (found) {
          if (!seen.has(target)) {
            seen.add(target)
            resolved.push(resolveHost(target, found.host, inventory, found.groupVars))
          }
        } else if (target.includes("@") || target.includes(":")) {
          // Ad-hoc target
          if (!seen.has(target)) {
            seen.add(target)
            resolved.push(parseAdHocTarget(target))
          }
        } else {
          const allHosts = collectHostNames(inventory)
          const suggestion = findClosest(target, allHosts)
          let msg = `Unknown host "${target}" -- not found in inventory and not an ad-hoc target`
          if (suggestion) {
            msg += `. Did you mean "${suggestion}"?`
          }
          throw new InventoryError(inventoryPath, msg)
        }
      }
    }
  }

  return resolved
}

/** Collect all host names from standalone hosts and group hosts. */
function collectHostNames(inventory: Inventory): string[] {
  const names: string[] = []
  if (inventory.hosts) {
    names.push(...Object.keys(inventory.hosts))
  }
  if (inventory.groups) {
    for (const group of Object.values(inventory.groups)) {
      names.push(...Object.keys(group.hosts))
    }
  }
  return names
}

/**
 * Find the closest match to `input` from `candidates` using Levenshtein distance.
 * Returns undefined if no candidate is within a reasonable threshold.
 */
function findClosest(input: string, candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined

  let best: string | undefined
  let bestDist = Infinity

  for (const candidate of candidates) {
    const dist = levenshtein(input.toLowerCase(), candidate.toLowerCase())
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }

  // Threshold: allow up to ~40% of the input length, minimum 2
  const threshold = Math.max(2, Math.ceil(input.length * 0.4))
  return bestDist <= threshold ? best : undefined
}

/** Simple Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[])

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }

  return dp[m][n]
}
