/**
 * Resource registry — collects resource definitions for schema discovery
 * and dynamic bound-resource creation.
 *
 * Provides the single source of truth for resource definitions, schemas,
 * and schema output generation. The `ResourceRegistry` class is the
 * extensible core; module-level helpers delegate to `defaultRegistry`
 * for backward compatibility. See ISSUE-0028, ISSUE-0034, ADR-0019.
 */

import type {
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceResult,
  ResourceSchema,
} from "./types.ts"
import { executeResource } from "./resource.ts"
import { execDefinition } from "../resources/exec.ts"
import { fileDefinition } from "../resources/file.ts"
import { aptDefinition } from "../resources/apt.ts"
import { serviceDefinition } from "../resources/service.ts"
import { directoryDefinition } from "../resources/directory.ts"

// ---------------------------------------------------------------------------
// Bound resource function type
// ---------------------------------------------------------------------------

/** A resource function bound to an ExecutionContext via the registry. */
export type BoundResourceFn<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  meta?: ResourceCallMeta,
) => Promise<ResourceResult<TOutput>>

// ---------------------------------------------------------------------------
// ResourceRegistry
// ---------------------------------------------------------------------------

/**
 * Collects resource definitions and generates bound resource functions
 * dynamically. Built-in resources register at module load; plugins
 * register at config time. See ISSUE-0034.
 */
export class ResourceRegistry {
  private readonly _definitions = new Map<string, ResourceDefinition<any, any>>()

  /** Register a resource definition. Throws on duplicate type. */
  register<TInput, TOutput>(def: ResourceDefinition<TInput, TOutput>): void {
    if (this._definitions.has(def.type)) {
      throw new Error(`ResourceRegistry: duplicate type "${def.type}"`)
    }
    this._definitions.set(def.type, def)
  }

  /** Get a definition by type name. */
  get(type: string): ResourceDefinition<unknown, unknown> | undefined {
    return this._definitions.get(type)
  }

  /** List all registered type names. */
  types(): readonly string[] {
    return [...this._definitions.keys()]
  }

  /** All registered definitions (for schema generation). */
  definitions(): ReadonlyArray<ResourceDefinition<unknown, unknown>> {
    return [...this._definitions.values()]
  }

  /** Create bound resource functions for a given context. */
  createBoundResources(ctx: ExecutionContext): Record<string, BoundResourceFn> {
    const bound: Record<string, BoundResourceFn> = {}
    for (const [type, def] of this._definitions) {
      bound[type] = (input: unknown, meta?: ResourceCallMeta) =>
        executeResource(ctx, def, input, ctx.resourcePolicy, meta)
    }
    return bound
  }
}

// ---------------------------------------------------------------------------
// Default registry with all built-in resources
// ---------------------------------------------------------------------------

/** Global default registry with built-in resources. */
export const defaultRegistry: ResourceRegistry = new ResourceRegistry()
defaultRegistry.register(execDefinition)
defaultRegistry.register(fileDefinition)
defaultRegistry.register(aptDefinition)
defaultRegistry.register(serviceDefinition)
defaultRegistry.register(directoryDefinition)

// ---------------------------------------------------------------------------
// Backward-compatible module-level helpers (delegate to defaultRegistry)
// ---------------------------------------------------------------------------

/** Return all registered resource definitions. */
export function getAllDefinitions(): ReadonlyMap<string, ResourceDefinition<any, any>> {
  const map = new Map<string, ResourceDefinition<any, any>>()
  for (const def of defaultRegistry.definitions()) {
    map.set(def.type, def as ResourceDefinition<any, any>)
  }
  return map
}

/** Return a single resource definition by type, or undefined if not found. */
export function getDefinition(type: string): ResourceDefinition<any, any> | undefined {
  return defaultRegistry.get(type) as ResourceDefinition<any, any> | undefined
}

/** Return all resource type names in registry order. */
export function getResourceTypes(): string[] {
  return [...defaultRegistry.types()]
}

/** Return the schema for a resource type, or undefined if not found. */
export function getResourceSchema(type: string): ResourceSchema | undefined {
  return defaultRegistry.get(type)?.schema
}

/** Return all resource schemas as a map of type → schema. */
export function getAllResourceSchemas(): Map<string, ResourceSchema> {
  const schemas = new Map<string, ResourceSchema>()
  for (const def of defaultRegistry.definitions()) {
    if (def.schema) {
      schemas.set(def.type, def.schema)
    }
  }
  return schemas
}

// ---------------------------------------------------------------------------
// Recipe Format Schema
// ---------------------------------------------------------------------------

/** Machine-readable recipe format specification. */
export function getRecipeSchema(): Record<string, unknown> {
  return {
    format: "typescript",
    defaultExport: {
      signature: "async function(ctx: ExecutionContext): Promise<void>",
      description: "Recipe entry point, receives an ExecutionContext",
    },
    meta: {
      description: "Optional named export with recipe metadata",
      fields: {
        description: { type: "string", optional: true },
        tags: { type: "string[]", optional: true },
      },
    },
    imports: {
      note: "All imports come from the package root — @grovemotorco/ignition",
      createResources: "@grovemotorco/ignition",
      ExecutionContext: "@grovemotorco/ignition (type import)",
    },
    pattern: "const { exec, file, apt, service, directory } = createResources(ctx)",
    completeExample:
      "import type { ExecutionContext } from '@grovemotorco/ignition'\nimport { createResources } from '@grovemotorco/ignition'\n\nexport default async function (ctx: ExecutionContext) {\n\tconst { apt, file, service } = createResources(ctx)\n\tawait apt({ name: 'nginx', state: 'present' })\n\tawait file({ path: '/etc/nginx/nginx.conf', content: 'server { listen 80; }' })\n\tawait service({ name: 'nginx', state: 'started', enabled: true })\n}",
  }
}

// ---------------------------------------------------------------------------
// Inventory Format Schema
// ---------------------------------------------------------------------------

/** Machine-readable inventory format specification. */
export function getInventorySchema(): Record<string, unknown> {
  return {
    format: "typescript",
    defaultExport: {
      type: "Inventory",
      description: "Default export conforming to the Inventory interface",
    },
    schema: {
      type: "object",
      properties: {
        defaults: {
          type: "object",
          description: "Connection defaults applied to all hosts",
          properties: {
            user: { type: "string", description: "Default SSH user" },
            port: { type: "number", description: "Default SSH port" },
            privateKey: { type: "string", description: "Default SSH private key path" },
          },
        },
        vars: {
          type: "object",
          additionalProperties: true,
          description: "Global variables (lowest precedence)",
        },
        groups: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              hosts: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  required: ["hostname"],
                  properties: {
                    hostname: { type: "string" },
                    user: { type: "string" },
                    port: { type: "number" },
                    privateKey: { type: "string" },
                    vars: { type: "object" },
                  },
                },
              },
              vars: { type: "object" },
            },
          },
          description: "Named groups of hosts, referenced as @groupName in targets",
        },
        hosts: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["hostname"],
            properties: {
              hostname: { type: "string" },
              user: { type: "string" },
              port: { type: "number" },
              privateKey: { type: "string" },
              vars: { type: "object" },
            },
          },
          description: "Standalone hosts not belonging to any group",
        },
      },
    },
    targetSyntax: {
      namedHost: "web-1",
      groupExpansion: "@web",
      multiple: "web-1,web-2",
      adHoc: "user@host:port",
    },
    variablePrecedence: "host vars > group vars > global vars > defaults",
  }
}

// ---------------------------------------------------------------------------
// CLI Grammar Schema
// ---------------------------------------------------------------------------

/** Machine-readable CLI grammar specification. */
export function getCliSchema(): Record<string, unknown> {
  return {
    binary: "ignition",
    globalFlags: [
      {
        name: "--version",
        aliases: ["-V"],
        type: "boolean",
        description: "Show version and exit",
      },
      {
        name: "--help",
        aliases: ["-h"],
        type: "boolean",
        description: "Show help",
      },
    ],
    commands: {
      run: {
        brief: "Apply a recipe to target hosts",
        positional: [
          { name: "recipe", required: true, description: "Path to the recipe .ts file" },
          {
            name: "targets",
            required: true,
            variadic: true,
            description: "Target specifiers (host name, @group, or user@host:port)",
          },
        ],
        flags: getRunCheckFlagSchema(),
      },
      check: {
        brief: "Dry-run a recipe against target hosts (no mutations)",
        positional: [
          { name: "recipe", required: true, description: "Path to the recipe .ts file" },
          { name: "targets", required: true, variadic: true, description: "Target specifiers" },
        ],
        flags: getRunCheckFlagSchema(),
      },
      schema: {
        brief: "Display schema and resource information for agents",
        subcommands: {
          all: { brief: "Complete surface area (default)", positional: [] },
          resources: { brief: "List all resources with descriptions", positional: [] },
          resource: {
            brief: "Full schema for one resource",
            positional: [
              {
                name: "name",
                required: true,
                description: "Resource type name (exec, file, apt, service, directory)",
              },
            ],
          },
          recipe: { brief: "Recipe file format specification", positional: [] },
          inventory: { brief: "Inventory format specification", positional: [] },
          cli: { brief: "Full CLI grammar", positional: [] },
        },
        flags: [
          {
            name: "--format",
            aliases: ["-f"],
            type: "enum",
            values: ["json", "pretty", "agent"],
            default: "json",
            description: "Output format",
          },
        ],
      },
      inventory: {
        brief: "List hosts from an inventory file",
        positional: [{ name: "file", required: false, description: "Inventory file path" }],
        flags: getInventoryFlagSchema(),
      },
      init: {
        brief: "Initialize a new Ignition project",
        positional: [],
      },
      dashboard: {
        brief: "Start the web dashboard",
        positional: [
          {
            name: "address",
            required: false,
            description: "Dashboard address as host:port (default 127.0.0.1:9090)",
          },
        ],
        flags: [
          {
            name: "--var",
            type: "string",
            repeatable: true,
            description: "Set variable (use history=N to set max retained runs)",
          },
          {
            name: "--verbose",
            aliases: ["-v"],
            type: "boolean",
            default: false,
            description: "Enable verbose output",
          },
        ],
      },
    },
  }
}

/** Shared flag schema for run/check commands. */
function getRunCheckFlagSchema(): Record<string, unknown>[] {
  return [
    {
      name: "--inventory",
      aliases: ["-i"],
      type: "string",
      required: false,
      description: "Inventory file path",
    },
    {
      name: "--verbose",
      aliases: ["-v"],
      type: "boolean",
      default: false,
      description: "Show SSH commands and detailed output",
    },
    {
      name: "--format",
      aliases: ["-f"],
      type: "enum",
      values: ["pretty", "json", "minimal"],
      default: "pretty",
      description: "Output format",
    },
    {
      name: "--error-mode",
      type: "enum",
      values: ["fail-fast", "fail-at-end", "ignore"],
      default: "fail-fast",
      description: "Error handling strategy",
    },
    {
      name: "--tags",
      type: "string",
      variadic: ",",
      repeatable: true,
      description: "Filter resources by tag (comma-separated)",
    },
    {
      name: "--var",
      type: "string",
      repeatable: true,
      description: "Set variable as key=value (repeatable)",
    },
    {
      name: "--confirm",
      type: "boolean",
      default: false,
      description: "Prompt before applying changes",
    },
    {
      name: "--host-key-policy",
      type: "enum",
      values: ["strict", "accept-new", "off"],
      default: "accept-new",
      description: "SSH host key verification",
    },
    {
      name: "--identity",
      type: "string",
      required: false,
      description: "Path to SSH private key",
    },
    {
      name: "--no-multiplex",
      type: "boolean",
      default: false,
      description: "Disable SSH connection multiplexing",
    },
    {
      name: "--parallelism",
      type: "integer",
      default: 5,
      description: "Max concurrent hosts",
      constraints: ">= 1",
    },
    {
      name: "--host-timeout",
      type: "integer",
      default: 0,
      description: "Per-host timeout in ms, 0 = unlimited",
    },
    {
      name: "--resource-timeout",
      type: "integer",
      default: 30000,
      description: "Per-resource timeout in ms, 0 = unlimited",
    },
    {
      name: "--retries",
      type: "integer",
      default: 2,
      description: "Retry attempts for transient failures",
    },
    {
      name: "--retry-delay",
      type: "integer",
      default: 1000,
      description: "Initial retry backoff in ms",
    },
    {
      name: "--cache",
      type: "boolean",
      default: false,
      description: "Cache check results across runs (check mode only)",
    },
    {
      name: "--cache-ttl",
      type: "integer",
      default: 600000,
      description: "Cache entry lifetime in ms",
    },
    {
      name: "--cache-clear",
      type: "boolean",
      default: false,
      description: "Clear cache before running",
    },
    {
      name: "--dashboard",
      type: "string",
      required: false,
      inferEmpty: true,
      description: "Start web dashboard [host:port], default 127.0.0.1:9090 when bare",
    },
    {
      name: "--log-dir",
      type: "string",
      required: false,
      description: "Directory for structured NDJSON run logs",
    },
  ]
}

/** Flag schema for inventory command. */
function getInventoryFlagSchema(): Record<string, unknown>[] {
  return [
    {
      name: "--inventory",
      aliases: ["-i"],
      type: "string",
      required: false,
      description: "Path to inventory file",
    },
    {
      name: "--verbose",
      aliases: ["-v"],
      type: "boolean",
      default: false,
      description: "Enable verbose output",
    },
    {
      name: "--format",
      aliases: ["-f"],
      type: "enum",
      values: ["pretty", "json", "minimal"],
      default: "pretty",
      description: "Output format",
    },
  ]
}

// ---------------------------------------------------------------------------
// RunSummary Output Schema
// ---------------------------------------------------------------------------

/** Formal RunSummary JSON output schema for agents. */
export function getRunSummarySchema(): Record<string, unknown> {
  return {
    description: "Output schema for --format json on run and check commands",
    successEnvelope: {
      type: "object",
      properties: {
        recipe: {
          type: "object",
          description: "Recipe audit info (absent for inline recipes)",
          properties: {
            path: { type: "string", description: "File path or URL" },
            checksum: { type: "string", description: "SHA-256 hex digest of recipe file" },
          },
        },
        timestamp: { type: "string", format: "date-time", description: "ISO-8601 run start time" },
        mode: { type: "string", enum: ["apply", "check"] },
        hasFailures: { type: "boolean" },
        durationMs: { type: "number" },
        hosts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              host: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  hostname: { type: "string" },
                },
              },
              results: {
                type: "array",
                items: { $ref: "#/resourceResult" },
              },
              ok: { type: "number" },
              changed: { type: "number" },
              failed: { type: "number" },
              durationMs: { type: "number" },
            },
          },
        },
      },
    },
    resourceResult: {
      type: "object",
      properties: {
        type: { type: "string", description: 'Resource type (e.g. "apt", "file")' },
        name: { type: "string", description: "Human-readable resource name" },
        status: {
          type: "string",
          enum: ["ok", "changed", "failed"],
          description: '"ok" = no change, "changed" = applied, "failed" = error',
        },
        current: { type: "object", description: "Current state from check()" },
        desired: { type: "object", description: "Desired state from check()" },
        output: { type: "object", description: "Output from apply() or check()" },
        error: {
          type: "object",
          description: 'Error details when status is "failed"',
          properties: {
            message: { type: "string" },
            name: { type: "string" },
          },
        },
        durationMs: { type: "number" },
      },
    },
    errorSerialization:
      'Errors are serialized as { "message": string, "name": string } since Error objects do not JSON.stringify by default.',
  }
}

// ---------------------------------------------------------------------------
// Aggregate Schema (all)
// ---------------------------------------------------------------------------

/** Aggregate schema combining all sections. */
export function getFullSchema(): Record<string, unknown> {
  const schemas = getAllResourceSchemas()
  const resources: Record<string, ResourceSchema> = {}
  for (const [type, schema] of schemas) {
    resources[type] = schema
  }
  return {
    resources,
    recipe: getRecipeSchema(),
    inventory: getInventorySchema(),
    cli: getCliSchema(),
    output: getRunSummarySchema(),
  }
}

// ---------------------------------------------------------------------------
// Format: agent (LLM-catered markdown)
// ---------------------------------------------------------------------------

/** Format a single resource schema as agent-friendly markdown. */
export function formatResourceForAgent(type: string, schema: ResourceSchema): string {
  const lines: string[] = []

  lines.push(`## Resource: \`${type}\``)
  lines.push("")
  lines.push(schema.description)
  lines.push("")

  lines.push(
    "**Nature:** " +
      (schema.nature === "declarative" ? "Declarative (convergent)" : "Imperative (always-run)"),
  )
  lines.push("")

  // Safety annotations
  const ann = schema.annotations
  const safety: string[] = []
  if (ann.destructive) safety.push("destructive")
  if (!ann.idempotent) safety.push("non-idempotent")
  if (ann.readOnly) safety.push("read-only")
  if (safety.length > 0) {
    lines.push("**Safety:** " + safety.join(", "))
  } else {
    lines.push("**Safety:** non-destructive, idempotent")
  }
  lines.push("")

  // Required capabilities
  lines.push("**Required capabilities:** " + schema.requiredCapabilities.join(", "))
  lines.push("")

  // When to use
  lines.push("### USE THIS RESOURCE WHEN")
  for (const item of schema.whenToUse) {
    lines.push(`- ${item}`)
  }
  lines.push("")

  // Do not use for
  if (schema.doNotUseFor && schema.doNotUseFor.length > 0) {
    lines.push("### DO NOT USE FOR")
    for (const item of schema.doNotUseFor) {
      lines.push(`- ${item}`)
    }
    lines.push("")
  }

  // Trigger patterns
  lines.push("### TRIGGER PATTERNS")
  for (const item of schema.triggerPatterns) {
    lines.push(`- "${item}"`)
  }
  lines.push("")

  // Hints
  lines.push("### HINTS")
  for (const item of schema.hints) {
    lines.push(`- ${item}`)
  }
  lines.push("")

  // Input schema
  lines.push("### Input")
  lines.push("```json")
  lines.push(JSON.stringify(schema.input, null, "\t"))
  lines.push("```")
  lines.push("")

  // Output schema
  lines.push("### Output")
  lines.push("```json")
  lines.push(JSON.stringify(schema.output, null, "\t"))
  lines.push("```")
  lines.push("")

  // Examples
  if (schema.examples.length > 0) {
    lines.push("### Examples")
    for (const ex of schema.examples) {
      lines.push(`#### ${ex.title}`)
      lines.push(ex.description)
      if (ex.naturalLanguage) {
        lines.push(`> "${ex.naturalLanguage}"`)
      }
      lines.push("```json")
      lines.push(JSON.stringify(ex.input, null, "\t"))
      lines.push("```")
      lines.push("")
    }
  }

  return lines.join("\n")
}

/** Format the complete schema for agent consumption. */
export function formatAllForAgent(): string {
  const lines: string[] = []

  lines.push("# Ignition Schema — Agent Reference")
  lines.push("")
  lines.push("Ignition is a TypeScript-native server provisioning tool. It uses SSH to push")
  lines.push("declarative resource configurations to remote hosts.")
  lines.push("")

  // Resources section
  lines.push("---")
  lines.push("# Resources")
  lines.push("")

  const schemas = getAllResourceSchemas()
  for (const [type, schema] of schemas) {
    lines.push(formatResourceForAgent(type, schema))
    lines.push("---")
    lines.push("")
  }

  // Recipe format
  lines.push("# Recipe Format")
  lines.push("")
  const recipe = getRecipeSchema()
  lines.push(`Recipes are TypeScript files (\`.ts\`) that default-export an async function.`)
  lines.push("")
  lines.push("**Signature:** `" + (recipe.defaultExport as Record<string, string>).signature + "`")
  lines.push("")
  lines.push("**Import pattern:**")
  lines.push("```typescript")
  lines.push(recipe.completeExample as string)
  lines.push("```")
  lines.push("")

  // Inventory format
  lines.push("---")
  lines.push("# Inventory Format")
  lines.push("")
  const inv = getInventorySchema()
  lines.push("Inventory files are TypeScript files that default-export an `Inventory` object.")
  lines.push("")
  lines.push("**Target syntax:**")
  const ts = inv.targetSyntax as Record<string, string>
  lines.push(`- Named host: \`${ts.namedHost}\``)
  lines.push(`- Group expansion: \`${ts.groupExpansion}\``)
  lines.push(`- Multiple targets: \`${ts.multiple}\``)
  lines.push(`- Ad-hoc: \`${ts.adHoc}\``)
  lines.push("")
  lines.push("**Variable precedence:** " + (inv.variablePrecedence as string))
  lines.push("")

  // CLI grammar
  lines.push("---")
  lines.push(formatCliForAgent())

  // Output format
  lines.push("---")
  lines.push("# Output Contracts")
  lines.push("")
  lines.push("**ResourceResult status values:**")
  lines.push('- `"ok"` — already in desired state, no changes made')
  lines.push('- `"changed"` — apply() converged to desired state (or would converge in check mode)')
  lines.push('- `"failed"` — error during check() or apply(), see `error` field')
  lines.push("")
  lines.push('**Error serialization:** `{ "message": string, "name": string }`')
  lines.push("")
  lines.push("Use `--format json` on `run` and `check` for machine-parseable output.")
  lines.push("")

  // Next steps
  lines.push("---")
  lines.push("# Next Steps")
  lines.push("")
  lines.push("1. **Generate a recipe** using the resource schemas above")
  lines.push("2. **Validate** with `ignition check <recipe.ts> <target> --format json`")
  lines.push("3. **Review** the check output — verify all resources show expected changes")
  lines.push("4. **Execute** with `ignition run <recipe.ts> <target> --format json`")
  lines.push(
    '5. **Verify** the run output — check `hasFailures` is false and all statuses are "ok" or "changed"',
  )
  lines.push("")

  return lines.join("\n")
}

/** Format CLI grammar for agent consumption. */
export function formatCliForAgent(): string {
  const lines: string[] = []
  lines.push("# CLI Grammar")
  lines.push("")
  lines.push("```")
  lines.push("ignition run [options] <recipe> <target>...")
  lines.push("ignition check [options] <recipe> <target>...")
  lines.push(
    "ignition schema [all|resources|resource <name>|recipe|inventory|cli] [--format json|pretty|agent]",
  )
  lines.push("ignition inventory [file]")
  lines.push("ignition init")
  lines.push("ignition dashboard [address] [--var key=value] [--verbose]")
  lines.push("```")
  lines.push("")
  lines.push("Detailed machine-readable grammar:")
  lines.push("```json")
  lines.push(JSON.stringify(getCliSchema(), null, "\t"))
  lines.push("```")
  lines.push("")
  return lines.join("\n")
}

/** Format a resource list summary for agent consumption. */
export function formatResourceListForAgent(): string {
  const lines: string[] = []
  lines.push("# Available Resources")
  lines.push("")
  const schemas = getAllResourceSchemas()
  for (const [type, schema] of schemas) {
    const ann = schema.annotations
    const flags: string[] = []
    if (ann.destructive) flags.push("destructive")
    if (!ann.idempotent) flags.push("non-idempotent")
    const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : ""
    lines.push(`- **${type}** — ${schema.description}${flagStr}`)
  }
  lines.push("")
  lines.push(`Use \`ignition schema resource <name>\` for full details on a specific resource.`)
  return lines.join("\n")
}

/** Format the resource list for pretty (human-readable) output. */
export function formatResourceListPretty(): string {
  const lines: string[] = []
  lines.push("Resources:")
  lines.push("")
  const schemas = getAllResourceSchemas()
  for (const [type, schema] of schemas) {
    lines.push(`  ${type.padEnd(12)} ${schema.description}`)
  }
  return lines.join("\n")
}

/** Format a single resource for pretty output. */
export function formatResourcePretty(type: string, schema: ResourceSchema): string {
  const lines: string[] = []
  lines.push(`Resource: ${type}`)
  lines.push(`  ${schema.description}`)
  lines.push(`  Nature:       ${schema.nature}`)
  lines.push(`  Destructive:  ${schema.annotations.destructive}`)
  lines.push(`  Idempotent:   ${schema.annotations.idempotent}`)
  lines.push(`  Capabilities: ${schema.requiredCapabilities.join(", ")}`)
  lines.push("")
  lines.push("  When to use:")
  for (const item of schema.whenToUse) {
    lines.push(`    - ${item}`)
  }
  if (schema.doNotUseFor && schema.doNotUseFor.length > 0) {
    lines.push("  Do not use for:")
    for (const item of schema.doNotUseFor) {
      lines.push(`    - ${item}`)
    }
  }
  lines.push("")
  lines.push("  Examples:")
  for (const ex of schema.examples) {
    lines.push(`    ${ex.title}: ${JSON.stringify(ex.input)}`)
  }
  return lines.join("\n")
}
