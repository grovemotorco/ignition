/**
 * Error formatting for user-facing CLI output.
 *
 * Renders IgnitionError instances with contextual details (hostname,
 * file path) and actionable suggestions.
 */

import { IgnitionError } from "../core/errors.ts"
import { error, info, muted } from "./colors.ts"

/**
 * Format an IgnitionError for display in the terminal.
 *
 * Includes the error tag, message, relevant context fields,
 * and a suggestion hint when available.
 */
export function formatError(err: IgnitionError): string {
  const lines: string[] = []

  lines.push(error(`Error [${err.tag}]: ${err.message}`))

  // Show relevant context fields (all values are primitives per error constructors)
  const s = (key: string): string => `${err.context[key] as string | number}`
  if (err.context.host) {
    const portSuffix = err.context.port !== undefined ? `:${s("port")}` : ""
    lines.push(muted(`  Host: ${s("host")}${portSuffix}`))
  }
  if (err.context.path) {
    lines.push(muted(`  File: ${s("path")}`))
  }
  if (err.context.command) {
    lines.push(muted(`  Command: ${s("command")}`))
  }
  if (err.context.resourceType) {
    lines.push(
      muted(
        `  Resource: ${s("resourceType")}${err.context.resourceName ? ` (${s("resourceName")})` : ""}`,
      ),
    )
  }
  if (err.context.capability) {
    lines.push(muted(`  Capability: ${s("capability")}`))
  }

  // Actionable suggestion
  const suggestion = getSuggestion(err)
  if (suggestion) {
    lines.push("")
    lines.push(info(`  Hint: ${suggestion}`))
  }

  return lines.join("\n")
}

/** Get a contextual suggestion for an error type. */
function getSuggestion(err: IgnitionError): string | undefined {
  switch (err.tag) {
    case "SSHConnectionError":
      return "Check that the host is reachable (ssh -v) and SSH is configured correctly."
    case "SSHCommandError":
      return "The remote command failed. Use --trace to see full SSH output."
    case "TransferError":
      return "File transfer failed. Verify the remote path is writable."
    case "RecipeLoadError":
      return "Verify the recipe file exists, has a valid default export, and can resolve imports (run `ignition init` if @grovemotorco/ignition is missing)."
    case "InventoryError":
      return "Check the inventory file format. Run `ignition schema inventory` for the expected shape."
    case "ResourceError":
      return "A resource operation failed. Check the resource input and remote host state."
    case "CapabilityError":
      return "The current transport does not support this operation. Check your SSH configuration."
    default:
      return undefined
  }
}
