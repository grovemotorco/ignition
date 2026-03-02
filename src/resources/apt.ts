/**
 * apt() resource — manage Debian/Ubuntu packages via apt.
 *
 * `check()` queries dpkg/apt-cache for installed vs desired package state.
 * `apply()` installs, removes, or upgrades packages via apt-get.
 * See ISSUE-0008.
 */

import type {
  CheckResult,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceSchema,
} from "../core/types.ts"
import { executeResource, requireCapability } from "../core/resource.ts"
import { ResourceError } from "../core/errors.ts"

/** Input options for the apt resource. */
export interface AptInput {
  /** Package name or list of package names. */
  readonly name: string | string[]
  /** Desired state. Default: 'present'. */
  readonly state?: "present" | "absent" | "latest"
  /** Run apt-get update before install. Default: false. */
  readonly update?: boolean
}

/** Output of a successful apt resource. */
export interface AptOutput {
  /** Map of package name → installed version. */
  readonly packages: Record<string, string>
  readonly changed: boolean
}

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Normalize name input to string array. */
function normalizeNames(name: string | string[]): string[] {
  return Array.isArray(name) ? name : [name]
}

/** Format package list for error messages. */
function formatPackageNames(name: string | string[]): string {
  return normalizeNames(name).join(", ")
}

/**
 * Fail fast on hosts that explicitly report a non-apt package manager.
 *
 * When facts are unknown (`pkgManager` null/undefined), we allow execution to
 * continue and defer to command-level failures if apt is actually unavailable.
 */
function assertAptCompatibleHost(ctx: ExecutionContext, name: string | string[]): void {
  const pkgManager = ctx.facts?.pkgManager
  if (pkgManager && pkgManager !== "apt") {
    const distro = ctx.facts?.distroId || ctx.facts?.distro || "unknown"
    throw new ResourceError(
      "apt",
      formatPackageNames(name),
      `apt resource requires apt-compatible host; detected package manager '${pkgManager}' (distro: ${distro})`,
    )
  }
}

/** Parse dpkg-query output into a map of package → version (only installed). */
function parseDpkgOutput(stdout: string): Map<string, string> {
  const installed = new Map<string, string>()
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue
    const parts = line.split("\t")
    if (parts.length >= 3) {
      const [pkg, status, version] = parts
      if (status.includes("install ok installed")) {
        installed.set(pkg, version)
      }
    }
  }
  return installed
}

/** Parse apt-cache policy output into a map of package → { installed, candidate }. */
function parseAptCachePolicy(
  stdout: string,
): Map<string, { installed: string; candidate: string }> {
  const result = new Map<string, { installed: string; candidate: string }>()
  let currentPkg = ""
  let installed = ""
  let candidate = ""

  for (const line of stdout.split("\n")) {
    const pkgMatch = line.match(/^(\S+):$/)
    if (pkgMatch) {
      if (currentPkg) {
        result.set(currentPkg, { installed, candidate })
      }
      currentPkg = pkgMatch[1]
      installed = ""
      candidate = ""
      continue
    }
    const installedMatch = line.match(/^\s+Installed:\s+(.+)$/)
    if (installedMatch) {
      installed = installedMatch[1]
      continue
    }
    const candidateMatch = line.match(/^\s+Candidate:\s+(.+)$/)
    if (candidateMatch) {
      candidate = candidateMatch[1]
    }
  }
  if (currentPkg) {
    result.set(currentPkg, { installed, candidate })
  }

  return result
}

/** Schema for the apt resource. See ISSUE-0028. */
export const aptSchema: ResourceSchema = {
  description: "Manage Debian/Ubuntu packages via apt-get.",
  whenToUse: [
    "Installing or removing system packages",
    "Ensuring specific packages are present on the host",
    "Upgrading packages to the latest version",
    "Managing multiple packages at once",
  ],
  doNotUseFor: [
    "Running arbitrary commands (use exec instead)",
    "Managing files or configs (use file instead)",
    "Managing services after package install (use service instead)",
    "Non-Debian/Ubuntu systems (apt is Debian/Ubuntu only)",
  ],
  triggerPatterns: [
    "install package",
    "install nginx",
    "ensure curl is installed",
    "remove package",
    "upgrade package",
    "apt install",
  ],
  hints: [
    'state defaults to "present" — only set "absent" for removal',
    'state: "absent" is destructive (runs apt-get remove)',
    'state: "latest" checks apt-cache policy and upgrades if a newer version is available',
    "Package names are Debian/Ubuntu apt package names",
    "name can be a string or an array of strings for multiple packages",
    "Set update: true to run apt-get update before installing (useful for fresh hosts)",
    "All apt-get commands run with DEBIAN_FRONTEND=noninteractive and -y -qq flags",
  ],
  input: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        oneOf: [
          { type: "string", description: "Package name" },
          { type: "array", items: { type: "string" }, description: "List of package names" },
        ],
        description: "Package name or list of package names",
      },
      state: {
        type: "string",
        enum: ["present", "absent", "latest"],
        default: "present",
        description: "Desired state",
      },
      update: {
        type: "boolean",
        default: false,
        description: "Run apt-get update before install",
      },
    },
  },
  output: {
    type: "object",
    properties: {
      packages: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Map of package name to installed version",
      },
      changed: { type: "boolean", description: "Whether packages were modified" },
    },
  },
  examples: [
    {
      title: "Install nginx",
      description: "Ensure nginx is installed",
      input: { name: "nginx", state: "present" },
      naturalLanguage: "Install nginx on the server",
    },
    {
      title: "Install multiple packages",
      description: "Install several packages at once with an apt update first",
      input: { name: ["nginx", "curl", "git"], update: true },
    },
    {
      title: "Remove a package",
      description: "Remove a package from the system",
      input: { name: "apache2", state: "absent" },
      naturalLanguage: "Remove apache2 from the server",
    },
  ],
  nature: "declarative",
  annotations: {
    readOnly: false,
    destructive: true,
    idempotent: true,
  },
  requiredCapabilities: ["exec"],
}

/** ResourceDefinition for apt. */
export const aptDefinition: ResourceDefinition<AptInput, AptOutput> = {
  type: "apt",
  schema: aptSchema,

  formatName(input: AptInput): string {
    const names = normalizeNames(input.name)
    return names.join(", ")
  },

  async check(ctx: ExecutionContext, input: AptInput): Promise<CheckResult<AptOutput>> {
    requireCapability(ctx, "exec", "apt")
    assertAptCompatibleHost(ctx, input.name)
    const state = input.state ?? "present"
    const names = normalizeNames(input.name)
    const pkgList = names.map(shellQuote).join(" ")

    // Query installed status
    const dpkgResult = await ctx.connection.exec(
      `dpkg-query -W -f='\${Package}\\t\${Status}\\t\${Version}\\n' ${pkgList} 2>/dev/null; true`,
    )
    const installed = parseDpkgOutput(dpkgResult.stdout)

    if (state === "absent") {
      const anyInstalled = names.some((n) => installed.has(n))
      if (!anyInstalled) {
        const packages: Record<string, string> = {}
        return {
          inDesiredState: true,
          current: { installed: Object.fromEntries(installed) },
          desired: { state: "absent" },
          output: { packages, changed: false },
        }
      }
      return {
        inDesiredState: false,
        current: { installed: Object.fromEntries(installed) },
        desired: { state: "absent", packages: names.filter((n) => installed.has(n)) },
      }
    }

    if (state === "present") {
      const allInstalled = names.every((n) => installed.has(n))
      if (allInstalled) {
        const packages: Record<string, string> = {}
        for (const n of names) packages[n] = installed.get(n)!
        return {
          inDesiredState: true,
          current: { installed: Object.fromEntries(installed) },
          desired: { state: "present" },
          output: { packages, changed: false },
        }
      }
      return {
        inDesiredState: false,
        current: { installed: Object.fromEntries(installed) },
        desired: { state: "present", missing: names.filter((n) => !installed.has(n)) },
      }
    }

    // state === 'latest'
    const policyResult = await ctx.connection.exec(`apt-cache policy ${pkgList}`)
    const policies = parseAptCachePolicy(policyResult.stdout)

    let allLatest = true
    for (const n of names) {
      const policy = policies.get(n)
      if (!policy || policy.installed === "(none)" || policy.installed !== policy.candidate) {
        allLatest = false
        break
      }
    }

    if (allLatest) {
      const packages: Record<string, string> = {}
      for (const n of names) packages[n] = installed.get(n)!
      return {
        inDesiredState: true,
        current: { installed: Object.fromEntries(installed) },
        desired: { state: "latest" },
        output: { packages, changed: false },
      }
    }

    return {
      inDesiredState: false,
      current: { installed: Object.fromEntries(installed) },
      desired: { state: "latest" },
    }
  },

  async apply(ctx: ExecutionContext, input: AptInput): Promise<AptOutput> {
    requireCapability(ctx, "exec", "apt")
    assertAptCompatibleHost(ctx, input.name)
    const state = input.state ?? "present"
    const names = normalizeNames(input.name)
    const pkgList = names.map(shellQuote).join(" ")

    if (input.update) {
      await ctx.connection.exec("sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq")
    }

    if (state === "absent") {
      await ctx.connection.exec(
        `sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq ${pkgList}`,
      )
    } else {
      // present or latest
      await ctx.connection.exec(
        `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgList}`,
      )
    }

    // Query final versions
    const dpkgResult = await ctx.connection.exec(
      `dpkg-query -W -f='\${Package}\\t\${Version}\\n' ${pkgList} 2>/dev/null; true`,
    )

    const packages: Record<string, string> = {}
    for (const line of dpkgResult.stdout.trim().split("\n")) {
      if (!line.trim()) continue
      const parts = line.split("\t")
      if (parts.length >= 2) {
        packages[parts[0]] = parts[1]
      }
    }

    return { packages, changed: true }
  },
}

/**
 * Create a bound `apt()` function for a given execution context.
 *
 * Usage in recipes:
 * ```ts
 * const apt = createApt(ctx)
 * await apt({ name: ['nginx', 'curl'], state: 'present', update: true })
 * ```
 */
export function createApt(
  ctx: ExecutionContext,
): (
  input: AptInput,
  meta?: ResourceCallMeta,
) => Promise<import("../core/types.ts").ResourceResult<AptOutput>> {
  return (input: AptInput, meta?: ResourceCallMeta) =>
    executeResource(ctx, aptDefinition, input, ctx.resourcePolicy, meta)
}
