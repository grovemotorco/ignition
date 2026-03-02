import { test, expect } from "bun:test"
import { schemaCommand } from "../../../src/cli/commands/schema.ts"
import type { SchemaArgs } from "../../../src/cli/commands/schema.ts"
import { getCliSchema } from "../../../src/core/registry.ts"
import { cli } from "../../../src/cli/index.ts"

// ---------------------------------------------------------------------------
// Test helpers — capture console.log/console.error output
// ---------------------------------------------------------------------------

function captureOutput(fn: () => number): { stdout: string; stderr: string; code: number } {
  const stdout: string[] = []
  const stderr: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]) => stdout.push(args.join(" "))
  console.error = (...args: unknown[]) => stderr.push(args.join(" "))
  try {
    const code = fn()
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code }
  } finally {
    console.log = origLog
    console.error = origError
  }
}

// ---------------------------------------------------------------------------
// schema all — JSON format (default)
// ---------------------------------------------------------------------------

test("schema all --format json returns valid JSON with all sections", () => {
  const { stdout, code } = captureOutput(() => schemaCommand({ subcommand: "all", format: "json" }))
  expect(code).toEqual(0)
  const parsed = JSON.parse(stdout)
  expect(typeof parsed.resources).toEqual("object")
  expect(typeof parsed.recipe).toEqual("object")
  expect(typeof parsed.inventory).toEqual("object")
  expect(typeof parsed.cli).toEqual("object")
  expect(typeof parsed.output).toEqual("object")
  expect(Object.keys(parsed.resources).sort()).toEqual([
    "apt",
    "directory",
    "exec",
    "file",
    "service",
  ])
})

// ---------------------------------------------------------------------------
// schema all — agent format
// ---------------------------------------------------------------------------

test("schema all --format agent returns markdown with all resources", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "all", format: "agent" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("# Ignition Schema")).toEqual(true)
  expect(stdout.includes("## Resource: `exec`")).toEqual(true)
  expect(stdout.includes("## Resource: `file`")).toEqual(true)
  expect(stdout.includes("## Resource: `apt`")).toEqual(true)
  expect(stdout.includes("## Resource: `service`")).toEqual(true)
  expect(stdout.includes("## Resource: `directory`")).toEqual(true)
  expect(stdout.includes("# Next Steps")).toEqual(true)
})

// ---------------------------------------------------------------------------
// schema all — pretty format
// ---------------------------------------------------------------------------

test("schema all --format pretty returns resource list", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "all", format: "pretty" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("Ignition Schema")).toEqual(true)
  expect(stdout.includes("exec")).toEqual(true)
})

// ---------------------------------------------------------------------------
// schema resources
// ---------------------------------------------------------------------------

test("schema resources --format json returns all resource schemas", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "resources", format: "json" }),
  )
  expect(code).toEqual(0)
  const parsed = JSON.parse(stdout)
  expect(Object.keys(parsed).sort()).toEqual(["apt", "directory", "exec", "file", "service"])
})

test("schema resources --format agent returns resource list", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "resources", format: "agent" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("# Available Resources")).toEqual(true)
  expect(stdout.includes("exec")).toEqual(true)
})

// ---------------------------------------------------------------------------
// schema resource <name>
// ---------------------------------------------------------------------------

test("schema resource exec --format json returns exec schema", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "resource", resourceName: "exec", format: "json" }),
  )
  expect(code).toEqual(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.description.includes("command")).toEqual(true)
  expect(parsed.nature).toEqual("imperative")
})

test("schema resource apt --format agent returns agent markdown", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "resource", resourceName: "apt", format: "agent" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("## Resource: `apt`")).toEqual(true)
  expect(stdout.includes("USE THIS RESOURCE WHEN")).toEqual(true)
})

test("schema resource <invalid> returns error with available names", () => {
  const { stderr, code } = captureOutput(() =>
    schemaCommand({ subcommand: "resource", resourceName: "bogus", format: "json" }),
  )
  expect(code).toEqual(1)
  expect(stderr.includes('Unknown resource: "bogus"')).toEqual(true)
  expect(stderr.includes("exec")).toEqual(true)
  expect(stderr.includes("file")).toEqual(true)
})

// ---------------------------------------------------------------------------
// schema recipe
// ---------------------------------------------------------------------------

test("schema recipe --format json returns recipe format schema", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "recipe", format: "json" }),
  )
  expect(code).toEqual(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.format).toEqual("typescript")
  expect(typeof parsed.completeExample).toEqual("string")
})

test("schema recipe --format agent returns recipe markdown", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "recipe", format: "agent" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("# Recipe Format")).toEqual(true)
  expect(stdout.includes("createResources")).toEqual(true)
})

// ---------------------------------------------------------------------------
// schema inventory
// ---------------------------------------------------------------------------

test("schema inventory --format json returns inventory format schema", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "inventory", format: "json" }),
  )
  expect(code).toEqual(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.format).toEqual("typescript")
  expect(typeof parsed.targetSyntax).toEqual("object")
})

test("schema inventory --format agent returns inventory markdown", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "inventory", format: "agent" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("# Inventory Format")).toEqual(true)
  expect(stdout.includes("@web")).toEqual(true)
})

// ---------------------------------------------------------------------------
// schema cli
// ---------------------------------------------------------------------------

test("schema cli --format json returns CLI grammar", () => {
  const { stdout, code } = captureOutput(() => schemaCommand({ subcommand: "cli", format: "json" }))
  expect(code).toEqual(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.binary).toEqual("ignition")
  expect(typeof parsed.commands).toEqual("object")
})

test("schema cli --format agent returns CLI markdown", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "cli", format: "agent" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("# CLI Grammar")).toEqual(true)
  expect(stdout.includes("ignition run")).toEqual(true)
  expect(stdout.includes("ignition dashboard [address] [--var key=value] [--verbose]")).toEqual(
    true,
  )
  expect(stdout.includes('"name": "--log-dir"')).toEqual(true)
})

test("schema cli --format pretty returns command list", () => {
  const { stdout, code } = captureOutput(() =>
    schemaCommand({ subcommand: "cli", format: "pretty" }),
  )
  expect(code).toEqual(0)
  expect(stdout.includes("CLI Commands")).toEqual(true)
  expect(stdout.includes("run")).toEqual(true)
  expect(stdout.includes("check")).toEqual(true)
})

// ---------------------------------------------------------------------------
// All formats parse cleanly
// ---------------------------------------------------------------------------

const subcommands: SchemaArgs["subcommand"][] = ["all", "resources", "recipe", "inventory", "cli"]

for (const sub of subcommands) {
  for (const format of ["json", "pretty", "agent"] as const) {
    test(`schema ${sub} --format ${format} exits with code 0`, () => {
      const { code } = captureOutput(() => schemaCommand({ subcommand: sub, format }))
      expect(code).toEqual(0)
    })
  }
}

for (const format of ["json", "pretty", "agent"] as const) {
  test(`schema resource exec --format ${format} exits with code 0`, () => {
    const { code } = captureOutput(() =>
      schemaCommand({ subcommand: "resource", resourceName: "exec", format }),
    )
    expect(code).toEqual(0)
  })
}

// ---------------------------------------------------------------------------
// Schema-parser parity: CLI schema should reflect the full parser contract.
// ---------------------------------------------------------------------------

interface SchemaFlag {
  name: string
  aliases?: string[]
  type: string
  values?: string[]
  repeatable?: boolean
  inferEmpty?: boolean
}

interface SchemaPositional {
  name: string
  required: boolean
  variadic?: boolean
}

interface SchemaCommandContract {
  flags?: SchemaFlag[]
  positional?: SchemaPositional[]
  subcommands?: Record<string, unknown>
}

interface CliSchemaContract {
  globalFlags: SchemaFlag[]
  commands: Record<string, SchemaCommandContract>
}

interface ParserFlagContract {
  name: string
  aliases: string[]
  type: string
  values?: string[]
  repeatable: boolean
  inferEmpty: boolean
}

function getSchemaContract(): CliSchemaContract {
  return getCliSchema() as unknown as CliSchemaContract
}

function getParserFlags(commandName: string): ParserFlagContract[] {
  const command = cli.getCommand(commandName)
  if (!command) throw new Error(`Unknown parser command: ${commandName}`)

  const out: ParserFlagContract[] = []
  for (const option of command.getOptions() as unknown as Array<Record<string, unknown>>) {
    const flags = option.flags as string[]
    const name = flags.find((flag) => flag.startsWith("--"))
    if (!name) continue
    // Cliffy may inject command-local --help after parse(); schema tracks it once under globalFlags.
    if (name === "--help") continue

    const aliases = flags.filter((flag) => flag.startsWith("-") && !flag.startsWith("--"))
    const args = (option.args as Array<Record<string, unknown>> | undefined) ?? []

    let type = "boolean"
    let values: string[] | undefined
    let inferEmpty = false
    if (args.length > 0) {
      const arg = args[0]
      const argType = String(arg.type)
      inferEmpty = Boolean(arg.optional)

      if (argType === "string" || argType === "integer") {
        type = argType
      } else {
        const typeDef = command.getType(argType) as
          | { handler?: { allowedValues?: string[] } }
          | undefined
        const allowedValues = typeDef?.handler?.allowedValues
        if (Array.isArray(allowedValues)) {
          type = "enum"
          values = [...allowedValues]
        } else {
          type = "string"
        }
      }
    }

    out.push({
      name,
      aliases: aliases.sort(),
      type,
      values: values?.sort(),
      repeatable: Boolean(option.collect),
      inferEmpty,
    })
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function getParserPositional(commandName: string): SchemaPositional[] {
  const command = cli.getCommand(commandName)
  if (!command) throw new Error(`Unknown parser command: ${commandName}`)

  return command.getArguments().map((arg) => ({
    name: arg.name,
    required: !arg.optional,
    variadic: arg.variadic,
  }))
}

test("CLI schema includes short aliases for global --help and --version", () => {
  const schema = getSchemaContract()
  const help = schema.globalFlags.find((flag) => flag.name === "--help")
  const version = schema.globalFlags.find((flag) => flag.name === "--version")

  expect(help).toBeDefined()
  expect(version).toBeDefined()
  expect(help?.aliases ?? []).toContain("-h")
  expect(version?.aliases ?? []).toContain("-V")
})

test("CLI schema flag sets match parser for every command", () => {
  const schema = getSchemaContract()
  for (const commandName of Object.keys(schema.commands)) {
    const parserFlags = getParserFlags(commandName)
    const schemaFlags = (schema.commands[commandName].flags ?? []).map((flag) => flag.name).sort()

    expect(schemaFlags).toEqual(parserFlags.map((flag) => flag.name).sort())
  }
})

test("CLI schema flag details match parser metadata", () => {
  const schema = getSchemaContract()
  for (const commandName of Object.keys(schema.commands)) {
    const parserFlags = getParserFlags(commandName)
    const schemaFlags = schema.commands[commandName].flags ?? []

    for (const schemaFlag of schemaFlags) {
      const parserFlag = parserFlags.find((flag) => flag.name === schemaFlag.name)
      expect(parserFlag).toBeDefined()
      if (!parserFlag) continue

      expect((schemaFlag.aliases ?? []).slice().sort()).toEqual(parserFlag.aliases)
      expect(schemaFlag.type).toEqual(parserFlag.type)
      expect((schemaFlag.values ?? []).slice().sort()).toEqual(parserFlag.values ?? [])
      expect(Boolean(schemaFlag.repeatable)).toEqual(parserFlag.repeatable)
      expect(Boolean(schemaFlag.inferEmpty)).toEqual(parserFlag.inferEmpty)
    }
  }
})

test("CLI schema positional args and subcommands match parser", () => {
  const schema = getSchemaContract()
  for (const [commandName, commandSchema] of Object.entries(schema.commands)) {
    const schemaPositional = (commandSchema.positional ?? []).map((arg) => ({
      name: arg.name,
      required: arg.required,
      variadic: Boolean(arg.variadic),
    }))
    const parserPositional = getParserPositional(commandName).map((arg) => ({
      name: arg.name,
      required: arg.required,
      variadic: Boolean(arg.variadic),
    }))

    expect(schemaPositional).toEqual(parserPositional)
  }

  const parserSubcommands =
    cli
      .getCommand("schema")
      ?.getCommands()
      .map((subcommand) => subcommand.getName())
      .sort() ?? []
  const schemaSubcommands = Object.keys(schema.commands.schema.subcommands ?? {}).sort()
  expect(schemaSubcommands).toEqual(parserSubcommands)
})
