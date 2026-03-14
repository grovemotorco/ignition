/**
 * file() resource — manage files on target hosts.
 *
 * Supports content (inline string), source (local file transfer), and
 * template (TypeScript function) modes. Compares SHA-256 checksums to
 * detect drift.
 */

import type {
  CheckResult,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceSchema,
  TemplateContext,
} from "../core/types.ts"
import { executeResource, requireCapability } from "../core/resource.ts"

/** Input options for the file resource. */
export type FileInput = {
  /** Absolute path on the remote host. */
  path: string
  /** Inline content to write. */
  content?: string | undefined
  /** Local file path to transfer via scp. */
  source?: string | undefined
  /** Template function that returns content string. */
  template?: ((vars: TemplateContext) => string) | undefined
  /** File mode (e.g. "0644"). */
  mode?: string | undefined
  /** Owner user. */
  owner?: string | undefined
  /** Owner group. */
  group?: string | undefined
  /** Whether the file should exist. Default: 'present'. */
  state?: "present" | "absent" | undefined
}

/** Output of a successful file resource. */
export type FileOutput = {
  path: string
  checksum: string
  changed: boolean
}

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Compute SHA-256 hex digest of a string using Web Crypto. */
async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Resolve the desired content from input options. */
function resolveContent(input: FileInput, vars: Record<string, unknown>): string | undefined {
  if (input.content !== undefined) return input.content
  if (input.template) return input.template(vars)
  return undefined
}

/** Schema for the file resource. */
export const fileSchema: ResourceSchema = {
  description: "Manage file content, ownership, and permissions on the remote host.",
  whenToUse: [
    "Creating or updating configuration files",
    "Deploying file content from inline strings or templates",
    "Transferring local files to the remote host via scp",
    "Setting file ownership and permissions",
    "Removing files (state: absent)",
  ],
  doNotUseFor: [
    "Creating directories (use directory instead)",
    "Running commands (use exec instead)",
    "Managing packages (use apt instead)",
  ],
  triggerPatterns: [
    "create file",
    "write config",
    "deploy configuration",
    "upload file",
    "set file permissions",
    "remove file",
    "manage file",
  ],
  hints: [
    "content, source, and template are mutually exclusive — use exactly one for file creation",
    'state defaults to "present" — only set "absent" to delete the file',
    'state: "absent" is destructive (runs rm -f)',
    "Content comparison uses SHA-256 checksums — only updates when content differs",
    'source requires the "transfer" transport capability (scp)',
    "template receives ctx.vars as its argument and must return a string",
    'mode should be an octal string like "0644", not a number',
    "owner and group are set independently — you can set one without the other",
  ],
  input: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute path on the remote host" },
      content: { type: "string", description: "Inline content to write" },
      source: { type: "string", description: "Local file path to transfer via scp" },
      template: {
        type: "string",
        description:
          "Template function that returns content string (TypeScript function reference)",
      },
      mode: { type: "string", description: 'File mode (e.g. "0644")' },
      owner: { type: "string", description: "Owner user" },
      group: { type: "string", description: "Owner group" },
      state: {
        type: "string",
        enum: ["present", "absent"],
        default: "present",
        description: "Whether the file should exist",
      },
    },
  },
  output: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file path" },
      checksum: { type: "string", description: "SHA-256 checksum of the file" },
      changed: { type: "boolean", description: "Whether the file was modified" },
    },
  },
  examples: [
    {
      title: "Write a configuration file",
      description: "Create an nginx config with specific permissions",
      input: {
        path: "/etc/nginx/nginx.conf",
        content: "server { listen 80; }",
        mode: "0644",
        owner: "root",
      },
      naturalLanguage: "Create the nginx config file at /etc/nginx/nginx.conf with mode 0644",
    },
    {
      title: "Remove a file",
      description: "Delete a file from the remote host",
      input: { path: "/tmp/old-config.bak", state: "absent" },
      naturalLanguage: "Remove the old backup config file",
    },
    {
      title: "Transfer a local file",
      description: "Upload a local file to the remote host",
      input: { path: "/opt/app/config.yml", source: "./config.yml" },
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

/** ResourceDefinition for file. */
export const fileDefinition: ResourceDefinition<FileInput, FileOutput> = {
  type: "file",
  schema: fileSchema,

  formatName(input: FileInput): string {
    return input.path
  },

  async check(ctx: ExecutionContext, input: FileInput): Promise<CheckResult<FileOutput>> {
    requireCapability(ctx, "exec", "file")
    const state = input.state ?? "present"

    const existResult = await ctx.connection.exec(
      `test -f ${shellQuote(input.path)} && echo EXISTS || echo MISSING`,
    )
    const exists = existResult.stdout.trim() === "EXISTS"

    if (state === "absent") {
      if (!exists) {
        return {
          inDesiredState: true,
          current: { exists: false },
          desired: { state: "absent" },
          output: { path: input.path, checksum: "", changed: false },
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
        desired: { state: "present" },
      }
    }

    // File exists — check content and attributes
    const diffs: Record<string, unknown> = {}
    const current: Record<string, unknown> = { exists: true }

    // Check content via checksum (only for content/template modes)
    const desiredContent = resolveContent(input, ctx.vars)
    if (desiredContent !== undefined) {
      const remoteChecksumResult = await ctx.connection.exec(
        `sha256sum ${shellQuote(input.path)} | awk '{print $1}'`,
      )
      const remoteChecksum = remoteChecksumResult.stdout.trim()
      const localChecksum = await sha256(desiredContent)

      current.checksum = remoteChecksum

      if (remoteChecksum !== localChecksum) {
        diffs.checksum = localChecksum

        const sizeResult = await ctx.connection.exec(`stat -c '%s' ${shellQuote(input.path)}`)
        const fileSize = parseInt(sizeResult.stdout.trim(), 10)
        if (!isNaN(fileSize) && fileSize <= 65536) {
          const catResult = await ctx.connection.exec(`cat ${shellQuote(input.path)}`)
          current.content = catResult.stdout
          diffs.content = desiredContent
        }
      }
    }

    // Check attributes
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

    // Already in desired state
    const checksum = (current.checksum as string) ?? ""
    return {
      inDesiredState: true,
      current,
      desired: { state: "present" },
      output: { path: input.path, checksum, changed: false },
    }
  },

  async apply(ctx: ExecutionContext, input: FileInput): Promise<FileOutput> {
    requireCapability(ctx, "exec", "file")
    const state = input.state ?? "present"

    if (state === "absent") {
      await ctx.connection.exec(`rm -f ${shellQuote(input.path)}`)
      return { path: input.path, checksum: "", changed: true }
    }

    // Write content
    const desiredContent = resolveContent(input, ctx.vars)
    if (desiredContent !== undefined) {
      await ctx.connection.exec(`cat > ${shellQuote(input.path)}`, { stdin: desiredContent })
    } else if (input.source) {
      requireCapability(ctx, "transfer", "file")
      await ctx.connection.transfer(input.source, input.path)
    }

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

    // Get final checksum
    const checksumResult = await ctx.connection.exec(
      `sha256sum ${shellQuote(input.path)} | awk '{print $1}'`,
    )

    return {
      path: input.path,
      checksum: checksumResult.stdout.trim(),
      changed: true,
    }
  },
}

/**
 * Create a bound `file()` function for a given execution context.
 *
 * Usage in recipes:
 * ```ts
 * const file = createFile(ctx)
 * await file({ path: '/etc/nginx/nginx.conf', content: configStr, mode: '0644' })
 * ```
 */
export function createFile(
  ctx: ExecutionContext,
): (
  input: FileInput,
  meta?: ResourceCallMeta,
) => Promise<import("../core/types.ts").ResourceResult<FileOutput>> {
  return (input: FileInput, meta?: ResourceCallMeta) =>
    executeResource(ctx, fileDefinition, input, ctx.resourcePolicy, meta)
}
