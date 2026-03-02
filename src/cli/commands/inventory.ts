import { Command } from "@cliffy/command"
import { resolve } from "node:path"
import { OutputFormatType } from "../parsers.ts"
import type { OutputFormat } from "../types.ts"
import { CliExitCode } from "../runtime.ts"
import { loadInventory } from "../../inventory/loader.ts"
import type { Inventory } from "../../inventory/types.ts"
import { bold, muted } from "../../lib/colors.ts"

function formatPretty(inventory: Inventory): string {
  const lines: string[] = []

  if (inventory.defaults) {
    lines.push(bold("Defaults:"))
    if (inventory.defaults.user) lines.push(`  user: ${inventory.defaults.user}`)
    if (inventory.defaults.port) lines.push(`  port: ${inventory.defaults.port}`)
    if (inventory.defaults.privateKey) lines.push(`  key:  ${inventory.defaults.privateKey}`)
    lines.push("")
  }

  if (inventory.vars && Object.keys(inventory.vars).length > 0) {
    lines.push(bold("Variables:"))
    for (const [key, value] of Object.entries(inventory.vars)) {
      lines.push(`  ${key}: ${muted(JSON.stringify(value))}`)
    }
    lines.push("")
  }

  if (inventory.groups) {
    for (const [groupName, group] of Object.entries(inventory.groups)) {
      lines.push(bold(`Group @${groupName}:`))
      if (group.vars && Object.keys(group.vars).length > 0) {
        lines.push(`  vars: ${muted(JSON.stringify(group.vars))}`)
      }
      for (const [hostName, host] of Object.entries(group.hosts)) {
        const parts = [`${hostName} ${muted("\u2192")} ${host.hostname}`]
        if (host.user) parts.push(muted(`user=${host.user}`))
        if (host.port) parts.push(muted(`port=${host.port}`))
        lines.push(`  ${parts.join("  ")}`)
      }
      lines.push("")
    }
  }

  if (inventory.hosts && Object.keys(inventory.hosts).length > 0) {
    lines.push(bold("Hosts:"))
    for (const [hostName, host] of Object.entries(inventory.hosts)) {
      const parts = [`${hostName} ${muted("\u2192")} ${host.hostname}`]
      if (host.user) parts.push(muted(`user=${host.user}`))
      if (host.port) parts.push(muted(`port=${host.port}`))
      lines.push(`  ${parts.join("  ")}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function formatJson(inventory: Inventory): string {
  return JSON.stringify(inventory, null, 2)
}

function formatMinimal(inventory: Inventory): string {
  const lines: string[] = []

  if (inventory.groups) {
    for (const [groupName, group] of Object.entries(inventory.groups)) {
      for (const [hostName, host] of Object.entries(group.hosts)) {
        lines.push(`@${groupName}/${hostName} ${host.hostname}`)
      }
    }
  }

  if (inventory.hosts) {
    for (const [hostName, host] of Object.entries(inventory.hosts)) {
      lines.push(`${hostName} ${host.hostname}`)
    }
  }

  return lines.join("\n")
}

export interface InventoryCommandArgs {
  readonly file?: string
  readonly inventory?: string
  readonly format: OutputFormat
}

export async function inventoryCommand(args: InventoryCommandArgs): Promise<number> {
  const file = args.file ?? args.inventory
  if (!file) {
    console.error(
      "No inventory file specified. Use: ignition inventory <file> or --inventory <file>",
    )
    return 1
  }

  const inventoryPath = resolve(process.cwd(), file)
  const inventoryUrl = new URL(`file://${inventoryPath}`).href
  const { inventory } = await loadInventory(inventoryUrl)

  switch (args.format) {
    case "json":
      console.log(formatJson(inventory))
      break
    case "minimal":
      console.log(formatMinimal(inventory))
      break
    case "pretty":
    default:
      console.log(formatPretty(inventory))
      break
  }

  return 0
}

export const inventory = new Command()
  .description("List hosts from an inventory file.")
  .type("output-format", OutputFormatType)
  .option("-i, --inventory <file:string>", "Path to inventory file.")
  .option("-v, --verbose", "Enable verbose output.")
  .option("-f, --format <format:output-format>", "Output format (pretty|json|minimal).", {
    default: "pretty" as const,
  })
  .arguments("[file:string]")
  .action(async (options, file) => {
    const code = await inventoryCommand({
      file,
      inventory: options.inventory,
      format: options.format ?? "pretty",
    })
    if (code !== 0) throw new CliExitCode(code)
  })
