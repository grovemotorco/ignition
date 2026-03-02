/**
 * directory() resource — manage directories on target hosts.
 *
 * `check()` tests whether the directory exists with the desired attributes.
 * `apply()` creates/removes the directory and sets ownership/permissions.
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

/** Input options for the directory resource. */
export interface DirectoryInput {
  /** Absolute path to the directory. */
  readonly path: string
  /** File mode (e.g. "0755"). */
  readonly mode?: string
  /** Owner user. */
  readonly owner?: string
  /** Owner group. */
  readonly group?: string
  /** Whether the directory should exist. Default: 'present'. */
  readonly state?: "present" | "absent"
  /** Use mkdir -p for recursive creation. Default: true. */
  readonly recursive?: boolean
}

/** Output of a successful directory resource. */
export interface DirectoryOutput {
  readonly path: string
  readonly changed: boolean
}

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Schema for the directory resource. See ISSUE-0028. */
export const directorySchema: ResourceSchema = {
  description: "Manage directories — create, remove, and set ownership/permissions.",
  whenToUse: [
    "Creating directories for application deployment",
    "Ensuring directories exist with correct ownership and permissions",
    "Removing directories (state: absent)",
    "Setting up directory trees before deploying files",
  ],
  doNotUseFor: [
    "Managing files (use file instead)",
    "Running commands (use exec instead)",
    "Creating directories as part of file operations (file handles parent dirs)",
  ],
  triggerPatterns: [
    "create directory",
    "make directory",
    "mkdir",
    "ensure directory exists",
    "set directory permissions",
    "remove directory",
  ],
  hints: [
    'state defaults to "present" — only set "absent" to remove',
    'state: "absent" is destructive (runs rm -rf)',
    "recursive defaults to true — uses mkdir -p by default",
    "Set recursive: false to fail if parent directories do not exist",
    'mode should be an octal string like "0755", not a number',
    "owner and group are set independently — you can set one without the other",
  ],
  input: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute path to the directory" },
      mode: { type: "string", description: 'File mode (e.g. "0755")' },
      owner: { type: "string", description: "Owner user" },
      group: { type: "string", description: "Owner group" },
      state: {
        type: "string",
        enum: ["present", "absent"],
        default: "present",
        description: "Whether the directory should exist",
      },
      recursive: {
        type: "boolean",
        default: true,
        description: "Use mkdir -p for recursive creation",
      },
    },
  },
  output: {
    type: "object",
    properties: {
      path: { type: "string", description: "The directory path" },
      changed: { type: "boolean", description: "Whether the directory was modified" },
    },
  },
  examples: [
    {
      title: "Create an application directory",
      description: "Create a directory with specific ownership and permissions",
      input: { path: "/var/www/app", owner: "www-data", group: "www-data", mode: "0755" },
      naturalLanguage: "Create the /var/www/app directory owned by www-data",
    },
    {
      title: "Remove a directory",
      description: "Recursively remove a directory",
      input: { path: "/tmp/old-deploy", state: "absent" },
      naturalLanguage: "Remove the old deployment directory",
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

/** ResourceDefinition for directory. */
export const directoryDefinition: ResourceDefinition<DirectoryInput, DirectoryOutput> = {
  type: "directory",
  schema: directorySchema,

  formatName(input: DirectoryInput): string {
    return input.path
  },

  async check(ctx: ExecutionContext, input: DirectoryInput): Promise<CheckResult<DirectoryOutput>> {
    requireCapability(ctx, "exec", "directory")
    const state = input.state ?? "present"
    const existResult = await ctx.connection.exec(
      `test -d ${shellQuote(input.path)} && echo EXISTS || echo MISSING`,
    )
    const exists = existResult.stdout.trim() === "EXISTS"

    if (state === "absent") {
      if (!exists) {
        return {
          inDesiredState: true,
          current: { exists: false },
          desired: { state: "absent" },
          output: { path: input.path, changed: false },
        }
      }
      return {
        inDesiredState: false,
        current: { exists: true },
        desired: { state: "absent" },
      }
    }

    // state === 'present'
    if (!exists) {
      return {
        inDesiredState: false,
        current: { exists: false },
        desired: { state: "present", mode: input.mode, owner: input.owner, group: input.group },
      }
    }

    // Directory exists — check attributes if specified
    const diffs: Record<string, unknown> = {}
    const current: Record<string, unknown> = { exists: true }

    if (input.mode || input.owner || input.group) {
      const statResult = await ctx.connection.exec(`stat -c '%a %U %G' ${shellQuote(input.path)}`)
      const parts = statResult.stdout.trim().split(" ")
      const [currentMode, currentOwner, currentGroup] = parts

      current.mode = currentMode
      current.owner = currentOwner
      current.group = currentGroup

      if (input.mode && currentMode !== input.mode) {
        diffs.mode = input.mode
      }
      if (input.owner && currentOwner !== input.owner) {
        diffs.owner = input.owner
      }
      if (input.group && currentGroup !== input.group) {
        diffs.group = input.group
      }
    }

    if (Object.keys(diffs).length > 0) {
      return {
        inDesiredState: false,
        current,
        desired: { state: "present", ...diffs },
      }
    }

    return {
      inDesiredState: true,
      current,
      desired: { state: "present" },
      output: { path: input.path, changed: false },
    }
  },

  async apply(ctx: ExecutionContext, input: DirectoryInput): Promise<DirectoryOutput> {
    requireCapability(ctx, "exec", "directory")
    const state = input.state ?? "present"

    if (state === "absent") {
      await ctx.connection.exec(`rm -rf ${shellQuote(input.path)}`)
      return { path: input.path, changed: true }
    }

    // Create directory
    const recursive = input.recursive !== false
    const mkdirCmd = recursive ? "mkdir -p" : "mkdir"
    await ctx.connection.exec(`${mkdirCmd} ${shellQuote(input.path)}`)

    // Set attributes
    if (input.mode) {
      await ctx.connection.exec(`chmod ${shellQuote(input.mode)} ${shellQuote(input.path)}`)
    }
    if (input.owner) {
      await ctx.connection.exec(`chown ${shellQuote(input.owner)} ${shellQuote(input.path)}`)
    }
    if (input.group) {
      await ctx.connection.exec(`chgrp ${shellQuote(input.group)} ${shellQuote(input.path)}`)
    }

    return { path: input.path, changed: true }
  },
}

/**
 * Create a bound `directory()` function for a given execution context.
 *
 * Usage in recipes:
 * ```ts
 * const directory = createDirectory(ctx)
 * await directory({ path: '/var/www/app', owner: 'www-data', mode: '0755' })
 * ```
 */
export function createDirectory(
  ctx: ExecutionContext,
): (
  input: DirectoryInput,
  meta?: ResourceCallMeta,
) => Promise<import("../core/types.ts").ResourceResult<DirectoryOutput>> {
  return (input: DirectoryInput, meta?: ResourceCallMeta) =>
    executeResource(ctx, directoryDefinition, input, ctx.resourcePolicy, meta)
}
