import { Command } from "@cliffy/command"
import {
  formatAllForAgent,
  formatCliForAgent,
  formatResourceForAgent,
  formatResourceListForAgent,
  formatResourceListPretty,
  formatResourcePretty,
  getAllResourceSchemas,
  getCliSchema,
  getFullSchema,
  getInventorySchema,
  getRecipeSchema,
  getResourceSchema,
  getResourceTypes,
  getRunSummarySchema,
} from "../../core/registry.ts"
import { SchemaFormatType } from "../parsers.ts"
import type { SchemaFormat } from "../parsers.ts"
import { CliExitCode } from "../runtime.ts"

export type { SchemaFormat } from "../parsers.ts"

export interface SchemaArgs {
  readonly subcommand: "all" | "resources" | "resource" | "recipe" | "inventory" | "cli"
  readonly resourceName?: string
  readonly format: SchemaFormat
}

export function schemaCommand(args: SchemaArgs): number {
  switch (args.subcommand) {
    case "all":
      return handleAll(args.format)
    case "resources":
      return handleResources(args.format)
    case "resource":
      return handleResource(args.resourceName!, args.format)
    case "recipe":
      return handleRecipe(args.format)
    case "inventory":
      return handleInventory(args.format)
    case "cli":
      return handleCli(args.format)
    default:
      return handleAll(args.format)
  }
}

function handleAll(format: SchemaFormat): number {
  switch (format) {
    case "json":
      console.log(JSON.stringify(getFullSchema(), null, "\t"))
      break
    case "agent":
      console.log(formatAllForAgent())
      break
    case "pretty": {
      console.log("Ignition Schema\n")
      console.log(formatResourceListPretty())
      console.log("\nUse `ignition schema resource <name>` for full details.")
      console.log("Use `ignition schema --format agent` for LLM-optimized output.")
      break
    }
  }
  return 0
}

function handleResources(format: SchemaFormat): number {
  switch (format) {
    case "json": {
      const schemas = getAllResourceSchemas()
      const obj: Record<string, unknown> = {}
      for (const [type, schema] of schemas) {
        obj[type] = schema
      }
      console.log(JSON.stringify(obj, null, "\t"))
      break
    }
    case "agent":
      console.log(formatResourceListForAgent())
      break
    case "pretty":
      console.log(formatResourceListPretty())
      break
  }
  return 0
}

function handleResource(name: string, format: SchemaFormat): number {
  const schema = getResourceSchema(name)
  if (!schema) {
    const types = getResourceTypes()
    console.error(`Unknown resource: "${name}". Available resources: ${types.join(", ")}`)
    return 1
  }

  switch (format) {
    case "json":
      console.log(JSON.stringify(schema, null, "\t"))
      break
    case "agent":
      console.log(formatResourceForAgent(name, schema))
      break
    case "pretty":
      console.log(formatResourcePretty(name, schema))
      break
  }
  return 0
}

function handleRecipe(format: SchemaFormat): number {
  const schema = getRecipeSchema()
  const formatValue = String(schema.format)
  const patternValue = String(schema.pattern)
  switch (format) {
    case "json":
      console.log(JSON.stringify(schema, null, "\t"))
      break
    case "agent": {
      const lines: string[] = []
      lines.push("# Recipe Format")
      lines.push("")
      lines.push(`Recipes are TypeScript files (\`.ts\`) that default-export an async function.`)
      lines.push("")
      lines.push(
        "**Signature:** `" + (schema.defaultExport as Record<string, string>).signature + "`",
      )
      lines.push("")
      lines.push("**Complete example:**")
      lines.push("```typescript")
      lines.push(schema.completeExample as string)
      lines.push("```")
      console.log(lines.join("\n"))
      break
    }
    case "pretty": {
      console.log("Recipe Format:")
      console.log(`  Format:    ${formatValue}`)
      console.log(`  Signature: ${(schema.defaultExport as Record<string, string>).signature}`)
      console.log(`  Pattern:   ${patternValue}`)
      break
    }
  }
  return 0
}

function handleInventory(format: SchemaFormat): number {
  const schema = getInventorySchema()
  const formatValue = String(schema.format)
  const precedenceValue = String(schema.variablePrecedence)
  switch (format) {
    case "json":
      console.log(JSON.stringify(schema, null, "\t"))
      break
    case "agent": {
      const lines: string[] = []
      lines.push("# Inventory Format")
      lines.push("")
      lines.push("Inventory files are TypeScript files that default-export an `Inventory` object.")
      lines.push("")
      const ts = schema.targetSyntax as Record<string, string>
      lines.push("**Target syntax:**")
      lines.push(`- Named host: \`${ts.namedHost}\``)
      lines.push(`- Group expansion: \`${ts.groupExpansion}\``)
      lines.push(`- Multiple targets: \`${ts.multiple}\``)
      lines.push(`- Ad-hoc: \`${ts.adHoc}\``)
      lines.push("")
      lines.push("**Variable precedence:** " + (schema.variablePrecedence as string))
      console.log(lines.join("\n"))
      break
    }
    case "pretty": {
      console.log("Inventory Format:")
      console.log(`  Format:     ${formatValue}`)
      console.log(`  Precedence: ${precedenceValue}`)
      const ts = schema.targetSyntax as Record<string, string>
      console.log("  Target syntax:")
      for (const [key, val] of Object.entries(ts)) {
        console.log(`    ${key}: ${val}`)
      }
      break
    }
  }
  return 0
}

function handleCli(format: SchemaFormat): number {
  const schema = getCliSchema()
  switch (format) {
    case "json":
      console.log(JSON.stringify(schema, null, "\t"))
      break
    case "agent":
      console.log(formatCliForAgent())
      break
    case "pretty": {
      console.log("CLI Commands:")
      const cmds = schema.commands as Record<string, Record<string, unknown>>
      for (const [name, cmd] of Object.entries(cmds)) {
        console.log(`  ${name.padEnd(12)} ${String(cmd.brief)}`)
      }
      break
    }
  }
  return 0
}

export function outputSchemaCommand(format: SchemaFormat): number {
  const schema = getRunSummarySchema()
  switch (format) {
    case "json":
      console.log(JSON.stringify(schema, null, "\t"))
      break
    case "agent": {
      const lines: string[] = []
      lines.push("# Output Contracts")
      lines.push("")
      lines.push("**ResourceResult status values:**")
      lines.push('- `"ok"` — already in desired state, no changes made')
      lines.push('- `"changed"` — apply() converged to desired state')
      lines.push('- `"failed"` — error during check() or apply()')
      lines.push("")
      lines.push('**Error serialization:** `{ "message": string, "name": string }`')
      console.log(lines.join("\n"))
      break
    }
    case "pretty":
      console.log("Output Schema:")
      console.log("  Status values: ok, changed, failed")
      console.log("  Error format: { message: string, name: string }")
      break
  }
  return 0
}

function runSchema(args: SchemaArgs): void {
  const code = schemaCommand(args)
  if (code !== 0) throw new CliExitCode(code)
}

/** Build a schema subcommand with the shared --format option (Cliffy doesn't propagate globalOption types). */
function schemaSubcommand(description: string) {
  return new Command()
    .description(description)
    .type("schema-format", SchemaFormatType)
    .option("-f, --format <format:schema-format>", "Output format (json|pretty|agent).", {
      default: "json" as const,
    })
}

export const schema = new Command()
  .description("Display resource schemas and CLI grammar (use --format agent for LLM output).")
  .type("schema-format", SchemaFormatType)
  .option("-f, --format <format:schema-format>", "Output format (json|pretty|agent).", {
    default: "json" as const,
  })
  .action((options) => {
    runSchema({ subcommand: "all", format: options.format })
  })
  .command(
    "all",
    schemaSubcommand("Complete surface area.").action((options) => {
      runSchema({ subcommand: "all", format: options.format })
    }),
  )
  .command(
    "resources",
    schemaSubcommand("List all resources with descriptions.").action((options) => {
      runSchema({ subcommand: "resources", format: options.format })
    }),
  )
  .command(
    "resource",
    schemaSubcommand("Display full schema for one resource.")
      .arguments("<name:string>")
      .action((options, name) => {
        runSchema({ subcommand: "resource", resourceName: name, format: options.format })
      }),
  )
  .command(
    "recipe",
    schemaSubcommand("Display recipe format schema.").action((options) => {
      runSchema({ subcommand: "recipe", format: options.format })
    }),
  )
  .command(
    "inventory",
    schemaSubcommand("Display inventory format schema.").action((options) => {
      runSchema({ subcommand: "inventory", format: options.format })
    }),
  )
  .command(
    "cli",
    schemaSubcommand("Display full CLI grammar schema.").action((options) => {
      runSchema({ subcommand: "cli", format: options.format })
    }),
  )
