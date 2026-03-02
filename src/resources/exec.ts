/**
 * exec() resource — run arbitrary commands on target hosts.
 *
 * This is the foundational resource that other resources build upon.
 * `check()` always returns not-in-desired-state (exec always runs).
 * `apply()` executes the command via SSH. See ISSUE-0006.
 */

import type {
  CheckResult,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceSchema,
} from "../core/types.ts"
import { ResourceError, SSHCommandError } from "../core/errors.ts"
import { executeResource, requireCapability } from "../core/resource.ts"

/** Input options for the exec resource. */
export interface ExecInput {
  /** The command to execute. */
  readonly command: string
  /** Run the command with sudo. */
  readonly sudo?: boolean
  /** Working directory for command execution. */
  readonly cwd?: string
  /** Environment variables to set. */
  readonly env?: Record<string, string>
  /** If false, non-zero exit codes are not treated as failures. Default: true. */
  readonly check?: boolean
  /** Skip apply if this command exits 0 (desired state already met). */
  readonly unless?: string
  /** Only apply if this command exits 0 (precondition met). */
  readonly onlyIf?: string
}

/** Output of a successful exec resource. */
export interface ExecOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Build the full command string from input options. */
function buildCommand(input: ExecInput): string {
  let cmd = input.command

  if (input.env && Object.keys(input.env).length > 0) {
    const envPrefix = Object.entries(input.env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ")
    cmd = `${envPrefix} ${cmd}`
  }

  if (input.cwd) {
    cmd = `cd ${shellQuote(input.cwd)} && ${cmd}`
  }

  if (input.sudo) {
    cmd = `sudo sh -c ${shellQuote(cmd)}`
  }

  return cmd
}

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Schema for the exec resource. See ISSUE-0028. */
export const execSchema: ResourceSchema = {
  description: "Run an arbitrary command on the remote host via SSH.",
  whenToUse: [
    "Running one-off commands that have no dedicated resource type",
    "Executing scripts or shell pipelines",
    "Bootstrapping a host before using other resources",
    "Running commands that need specific environment variables or working directories",
  ],
  doNotUseFor: [
    "Installing packages (use apt instead)",
    "Managing files (use file instead)",
    "Managing systemd services (use service instead)",
    "Creating directories (use directory instead)",
  ],
  triggerPatterns: [
    "run command",
    "execute script",
    "shell command",
    "run a script",
    "execute on server",
  ],
  hints: [
    "Without unless/onlyIf, exec is imperative — it always runs and reports changed",
    "Use unless to skip when desired state is met (e.g. unless: 'command -v pm2' skips if pm2 exists)",
    "Use onlyIf to run only when a precondition is met (e.g. onlyIf: 'test -f /tmp/trigger')",
    "unless and onlyIf are mutually exclusive — providing both throws an error",
    "Guards inherit sudo, cwd, and env from the parent input and run during check (read-only)",
    "check defaults to true — non-zero exit codes are treated as failures unless check: false",
    "sudo wraps the entire command with sudo sh -c, including cwd and env",
    "env vars are prepended as KEY=VALUE before the command",
    "cwd is implemented as cd <path> && <command>",
    "Use check: false for commands where non-zero exit is expected (e.g. grep)",
  ],
  input: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "The command to execute" },
      sudo: { type: "boolean", description: "Run the command with sudo", default: false },
      cwd: { type: "string", description: "Working directory for command execution" },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Environment variables to set",
      },
      check: {
        type: "boolean",
        description: "If false, non-zero exit codes are not treated as failures",
        default: true,
      },
      unless: {
        type: "string",
        description: "Skip apply if this command exits 0 (desired state already met)",
      },
      onlyIf: {
        type: "string",
        description: "Only apply if this command exits 0 (precondition met)",
      },
    },
  },
  output: {
    type: "object",
    properties: {
      exitCode: { type: "number", description: "Exit code of the remote process" },
      stdout: { type: "string", description: "Standard output" },
      stderr: { type: "string", description: "Standard error" },
    },
  },
  examples: [
    {
      title: "Run apt-get update with sudo",
      description: "Update package lists as root",
      input: { command: "apt-get update", sudo: true },
      naturalLanguage: "Update the package lists on the server",
    },
    {
      title: "Run a script in a specific directory",
      description: "Execute a build script with a working directory and env var",
      input: { command: "make install", cwd: "/opt/app", env: { CC: "gcc" } },
    },
    {
      title: "Check if a file exists (non-failing)",
      description: "Use check: false for commands where non-zero exit is acceptable",
      input: { command: "test -f /etc/myapp.conf", check: false },
      naturalLanguage: "Check if /etc/myapp.conf exists without failing",
    },
    {
      title: "Install pm2 only if not already installed",
      description: "Use unless to skip when the desired state is already met",
      input: { command: "npm install -g pm2", unless: "command -v pm2", sudo: true },
      naturalLanguage: "Install pm2 globally if it isn't already installed",
    },
    {
      title: "Run migration only if trigger file exists",
      description: "Use onlyIf to run only when a precondition is met",
      input: { command: "node migrate.js", onlyIf: "test -f /tmp/run-migration", cwd: "/opt/app" },
      naturalLanguage: "Run the migration script only if the trigger file exists",
    },
  ],
  nature: "imperative",
  annotations: {
    readOnly: false,
    destructive: true,
    idempotent: false,
  },
  requiredCapabilities: ["exec"],
}

/** ResourceDefinition for exec. */
export const execDefinition: ResourceDefinition<ExecInput, ExecOutput> = {
  type: "exec",
  schema: execSchema,

  formatName(input: ExecInput): string {
    return input.command
  },

  async check(ctx: ExecutionContext, input: ExecInput): Promise<CheckResult<ExecOutput>> {
    if (input.unless && input.onlyIf) {
      throw new ResourceError("exec", input.command, "unless and onlyIf are mutually exclusive")
    }

    // No guard — exec always runs (unchanged behavior)
    if (!input.unless && !input.onlyIf) {
      return {
        inDesiredState: false,
        current: { executed: false },
        desired: { command: input.command },
      }
    }

    const guardCmd = buildCommand({
      command: (input.unless ?? input.onlyIf)!,
      sudo: input.sudo,
      cwd: input.cwd,
      env: input.env,
    })
    const result = await ctx.connection.exec(guardCmd)

    if (input.unless) {
      // unless exits 0 → desired state met, skip apply
      return result.exitCode === 0
        ? {
            inDesiredState: true,
            current: { guardPassed: true },
            desired: { command: input.command },
          }
        : {
            inDesiredState: false,
            current: { guardPassed: false },
            desired: { command: input.command },
          }
    }

    // onlyIf exits non-zero → precondition not met, skip apply
    return result.exitCode !== 0
      ? {
          inDesiredState: true,
          current: { preconditionNotMet: true },
          desired: { command: input.command },
        }
      : {
          inDesiredState: false,
          current: { preconditionMet: true },
          desired: { command: input.command },
        }
  },

  async apply(ctx: ExecutionContext, input: ExecInput): Promise<ExecOutput> {
    requireCapability(ctx, "exec", "exec")
    const cmd = buildCommand(input)
    const result = await ctx.connection.exec(cmd)

    const shouldCheck = input.check !== false
    if (shouldCheck && result.exitCode !== 0) {
      throw new SSHCommandError(input.command, result.exitCode, result.stdout, result.stderr)
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  },
}

/**
 * Create a bound `exec()` function for a given execution context.
 *
 * Usage in recipes:
 * ```ts
 * const exec = createExec(ctx)
 * await exec({ command: 'apt-get update', sudo: true })
 * ```
 */
export function createExec(
  ctx: ExecutionContext,
): (
  input: ExecInput,
  meta?: ResourceCallMeta,
) => Promise<import("../core/types.ts").ResourceResult<ExecOutput>> {
  return (input: ExecInput, meta?: ResourceCallMeta) =>
    executeResource(ctx, execDefinition, input, ctx.resourcePolicy, meta)
}
