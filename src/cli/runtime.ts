import { ValidationError } from "@cliffy/command"
import { IgnitionError } from "../core/errors.ts"
import { ConfigValidationError } from "../lib/config.ts"
import { formatError } from "../lib/errors.ts"

export class CliExitCode extends Error {
  constructor(public readonly exitCode: number) {
    super("")
    this.name = "CliExitCode"
  }
}

export function handleCliError(error: unknown): number {
  if (error instanceof CliExitCode) {
    return error.exitCode
  }

  if (error instanceof ValidationError) {
    console.error(error.message)
    return 1
  }

  if (error instanceof IgnitionError) {
    console.error(formatError(error))
    return 1
  }

  if (error instanceof ConfigValidationError) {
    console.error(`Config error: ${error.message}`)
    return 1
  }

  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  return 1
}
