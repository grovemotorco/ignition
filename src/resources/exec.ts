/**
 * exec() resource — run arbitrary commands on target hosts.
 *
 * This is the foundational resource that other resources build upon.
 * `check()` is read-only during the normal check phase and does not execute
 * user commands unless explicitly opted into unsafe check guards.
 * `apply()` executes the command via SSH and may evaluate apply-time preconditions.
 */

import type {
  CheckResult,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceSchema,
} from "../core/types.ts"
import { ResourceError, SSHCommandError } from "../core/errors.ts"
import { executeResource, requireCapability, skipApply } from "../core/resource.ts"

/** Input options for the exec resource. */
export type ExecInput = {
  /** The command to execute. */
  command: string
  /** Run the command with sudo. */
  sudo?: boolean | undefined
  /** Working directory for command execution. */
  cwd?: string | undefined
  /** POSIX shell preamble to run before the command (e.g., sourcing files, exporting variables). */
  shell?: string | undefined
  /** Environment variables to set. */
  env?: Record<string, string> | undefined
  /** If false, non-zero exit codes are not treated as failures. Default: true. */
  check?: boolean | undefined
  /** Skip apply if this precondition command exits 0. Evaluated during apply(), not check(). */
  unless?: string | undefined
  /** Only apply if this precondition command exits 0. Evaluated during apply(), not check(). */
  onlyIf?: string | undefined
  /** Unsafe escape hatch: skip apply if this command exits 0 during check(), including --check. */
  unsafeCheckUnless?: string | undefined
  /** Unsafe escape hatch: only apply if this command exits 0 during check(), including --check. */
  unsafeCheckOnlyIf?: string | undefined
}

/** Output of a successful exec resource. */
export type ExecOutput = {
  exitCode: number
  stdout: string
  stderr: string
}

type ExecGuardKind = "unless" | "onlyIf" | "unsafeCheckUnless" | "unsafeCheckOnlyIf"

type ExecGuard = {
  kind: ExecGuardKind
  command: string
}

const SHELL_PREAMBLE_FAILURE_SENTINEL = "__IGNITION_SHELL_PREAMBLE_FAILED__"
const shellPreambleFailurePattern = new RegExp(
  `(?:^|\\n)${SHELL_PREAMBLE_FAILURE_SENTINEL}:(\\d+)(?:\\n|$)`,
)

/** Build the full command string from input options. */
function buildCommand(input: ExecInput): string {
  const base = input.shell ? wrapWithShellPreamble(input.command, input.shell) : input.command
  return wrapCommand(input, base)
}

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function configuredGuards(input: ExecInput): ExecGuard[] {
  const guards: ExecGuard[] = []
  if (input.unless) guards.push({ kind: "unless", command: input.unless })
  if (input.onlyIf) guards.push({ kind: "onlyIf", command: input.onlyIf })
  if (input.unsafeCheckUnless) {
    guards.push({ kind: "unsafeCheckUnless", command: input.unsafeCheckUnless })
  }
  if (input.unsafeCheckOnlyIf) {
    guards.push({ kind: "unsafeCheckOnlyIf", command: input.unsafeCheckOnlyIf })
  }
  return guards
}

function assertValidGuards(input: ExecInput): void {
  const guards = configuredGuards(input)
  if (guards.length > 1) {
    throw new ResourceError(
      "exec",
      input.command,
      "only one of unless, onlyIf, unsafeCheckUnless, and unsafeCheckOnlyIf may be provided",
    )
  }
}

function getApplyGuard(input: ExecInput): ExecGuard | undefined {
  if (input.unless) return { kind: "unless", command: input.unless }
  if (input.onlyIf) return { kind: "onlyIf", command: input.onlyIf }
  return undefined
}

function getUnsafeCheckGuard(input: ExecInput): ExecGuard | undefined {
  if (input.unsafeCheckUnless) {
    return { kind: "unsafeCheckUnless", command: input.unsafeCheckUnless }
  }
  if (input.unsafeCheckOnlyIf) {
    return { kind: "unsafeCheckOnlyIf", command: input.unsafeCheckOnlyIf }
  }
  return undefined
}

function buildGuardCommand(input: ExecInput, guard: ExecGuard): string {
  const base = input.shell
    ? wrapWithShellPreamble(guard.command, input.shell, { markPreambleFailure: true })
    : guard.command
  return wrapCommand(input, base)
}

function wrapCommand(input: Pick<ExecInput, "sudo" | "cwd" | "env">, command: string): string {
  let cmd = command

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

function wrapWithShellPreamble(
  command: string,
  shell: string,
  options?: { markPreambleFailure?: boolean },
): string {
  const lines = [
    "__ignition_preamble_failed() {",
    "  __ignition_shell_rc=$1",
    "  trap - EXIT",
  ]

  if (options?.markPreambleFailure) {
    lines.push(
      `  printf '%s:%s\\n' ${shellQuote(SHELL_PREAMBLE_FAILURE_SENTINEL)} "$__ignition_shell_rc" >&2`,
    )
  }

  lines.push('  exit "$__ignition_shell_rc"', "}")

  if (options?.markPreambleFailure) {
    lines.push(
      "__ignition_preamble_phase=1",
      `trap '__ignition_shell_rc=$?; if [ "$__ignition_preamble_phase" = 1 ]; then __ignition_preamble_failed "$__ignition_shell_rc"; fi' EXIT`,
    )
  }

  lines.push(
    'if eval "$1"; then',
    ...(options?.markPreambleFailure ? ["  __ignition_preamble_phase=0", "  trap - EXIT"] : []),
    '  eval "$2"',
    "else",
    "  __ignition_shell_rc=$?",
    ...(options?.markPreambleFailure ? ["  __ignition_preamble_phase=0"] : []),
    '  __ignition_preamble_failed "$__ignition_shell_rc"',
    "fi",
  )

  return `sh -c ${shellQuote(lines.join("\n"))} -- ${shellQuote(shell)} ${shellQuote(command)}`
}

function guardShellPreambleFailure(
  result: ExecOutput,
): { exitCode: number; stderr: string } | undefined {
  const match = result.stderr.match(shellPreambleFailurePattern)
  if (!match) return undefined

  return {
    exitCode: Number(match[1]),
    stderr: result.stderr.replace(shellPreambleFailurePattern, "").trim(),
  }
}

function assertGuardShellPreambleSucceeded(
  input: ExecInput,
  guard: ExecGuard,
  result: ExecOutput,
): void {
  if (!input.shell) return

  const failure = guardShellPreambleFailure(result)
  if (!failure) return

  throw new SSHCommandError(
    `shell preamble for ${guard.kind} guard: ${input.shell}`,
    failure.exitCode,
    result.stdout,
    failure.stderr,
  )
}

function desiredState(input: ExecInput): Record<string, unknown> {
  const desired: Record<string, unknown> = { command: input.command }
  if (input.unless) desired.unless = input.unless
  if (input.onlyIf) desired.onlyIf = input.onlyIf
  if (input.unsafeCheckUnless) desired.unsafeCheckUnless = input.unsafeCheckUnless
  if (input.unsafeCheckOnlyIf) desired.unsafeCheckOnlyIf = input.unsafeCheckOnlyIf
  return desired
}

/** Schema for the exec resource. */
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
    "Without preconditions, exec is imperative — it always runs and reports changed",
    "Use unless to skip during apply when the command's desired state is already met",
    "Use onlyIf to gate apply on an apply-time precondition",
    "unless and onlyIf do not run during check(), so ignition run --check reports them conservatively as would change",
    "unsafeCheckUnless and unsafeCheckOnlyIf are explicit escape hatches that execute during check(), including ignition run --check",
    "Only one of unless, onlyIf, unsafeCheckUnless, and unsafeCheckOnlyIf may be provided",
    "Use shell to source files or export variables that the command needs (e.g., NVM, rbenv, pyenv)",
    "shell is prepended as '<shell> && <command>' — it runs in the same shell session",
    "when shell is set, env vars apply to both the preamble and the command",
    "shell runs via 'sh -c' — use POSIX syntax or invoke another shell explicitly if needed",
    "a failing shell preamble aborts guard evaluation instead of being treated as a false guard",
    "Preconditions and unsafe check guards inherit sudo, cwd, shell, and env from the parent input",
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
      shell: {
        type: "string",
        description:
          "POSIX shell preamble to run before the command (e.g., sourcing files, exporting variables)",
      },
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
        description: "Skip apply if this precondition command exits 0 (evaluated during apply)",
      },
      onlyIf: {
        type: "string",
        description: "Only apply if this precondition command exits 0 (evaluated during apply)",
      },
      unsafeCheckUnless: {
        type: "string",
        description: "Unsafe: skip apply if this command exits 0 during check(), including --check",
      },
      unsafeCheckOnlyIf: {
        type: "string",
        description: "Unsafe: only apply if this command exits 0 during check(), including --check",
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
      description: "Use an apply-time precondition to skip when the desired state is already met",
      input: { command: "npm install -g pm2", unless: "command -v pm2", sudo: true },
      naturalLanguage: "Install pm2 globally if it isn't already installed",
    },
    {
      title: "Run migration only if trigger file exists",
      description: "Use an apply-time precondition to run only when a precondition is met",
      input: { command: "node migrate.js", onlyIf: "test -f /tmp/run-migration", cwd: "/opt/app" },
      naturalLanguage: "Run the migration script only if the trigger file exists",
    },
    {
      title: "Install Node.js via NVM with shell preamble",
      description: "Use shell to source NVM before running nvm commands",
      input: {
        command: "nvm install 24 && nvm alias default 24",
        shell: 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"',
        unless: "node --version | grep -q '^v24'",
      },
      naturalLanguage: "Install Node.js 24 via NVM, skipping if already installed",
    },
    {
      title: "Unsafe check-time probe",
      description:
        "Opt into running a probe during check mode when you accept dry-run side effects",
      input: { command: "npm install -g pm2", unsafeCheckUnless: "command -v pm2", sudo: true },
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
    assertValidGuards(input)

    const unsafeCheckGuard = getUnsafeCheckGuard(input)
    if (unsafeCheckGuard) {
      requireCapability(ctx, "exec", "exec")
      const guardCmd = buildGuardCommand(input, unsafeCheckGuard)
      const result = await ctx.connection.exec(guardCmd)
      assertGuardShellPreambleSucceeded(input, unsafeCheckGuard, result)

      if (unsafeCheckGuard.kind === "unsafeCheckUnless") {
        return result.exitCode === 0
          ? {
              inDesiredState: true,
              current: { unsafeCheckGuardPassed: true },
              desired: desiredState(input),
              output: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
            }
          : {
              inDesiredState: false,
              current: { unsafeCheckGuardPassed: false },
              desired: desiredState(input),
            }
      }

      return result.exitCode !== 0
        ? {
            inDesiredState: true,
            current: { unsafeCheckPreconditionMet: false },
            desired: desiredState(input),
            output: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          }
        : {
            inDesiredState: false,
            current: { unsafeCheckPreconditionMet: true },
            desired: desiredState(input),
          }
    }

    const applyGuard = getApplyGuard(input)
    if (ctx.phase === "post-check" && applyGuard) {
      requireCapability(ctx, "exec", "exec")
      const result = await ctx.connection.exec(buildGuardCommand(input, applyGuard))
      assertGuardShellPreambleSucceeded(input, applyGuard, result)

      if (applyGuard.kind === "unless") {
        return result.exitCode === 0
          ? {
              inDesiredState: true,
              current: { guardPassed: true },
              desired: desiredState(input),
              output: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
            }
          : {
              inDesiredState: false,
              current: { guardPassed: false },
              desired: desiredState(input),
            }
      }

      return result.exitCode !== 0
        ? {
            inDesiredState: true,
            current: { preconditionNotMet: true },
            desired: desiredState(input),
            output: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          }
        : {
            inDesiredState: false,
            current: { preconditionMet: true },
            desired: desiredState(input),
          }
    }

    const current: Record<string, unknown> = { executed: false }
    if (applyGuard) {
      current.preconditionEvaluated = false
    }

    return {
      inDesiredState: false,
      current,
      desired: desiredState(input),
    }
  },

  async apply(ctx: ExecutionContext, input: ExecInput): Promise<ExecOutput> {
    assertValidGuards(input)
    requireCapability(ctx, "exec", "exec")

    const applyGuard = getApplyGuard(input)
    if (applyGuard) {
      const guardResult = await ctx.connection.exec(buildGuardCommand(input, applyGuard))
      assertGuardShellPreambleSucceeded(input, applyGuard, guardResult)
      if (applyGuard.kind === "unless" && guardResult.exitCode === 0) {
        skipApply({
          exitCode: guardResult.exitCode,
          stdout: guardResult.stdout,
          stderr: guardResult.stderr,
        })
      }
      if (applyGuard.kind === "onlyIf" && guardResult.exitCode !== 0) {
        skipApply({
          exitCode: guardResult.exitCode,
          stdout: guardResult.stdout,
          stderr: guardResult.stderr,
        })
      }
    }

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
