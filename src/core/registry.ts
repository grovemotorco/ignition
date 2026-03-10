/**
 * Resource registry — collects resource definitions for schema discovery
 * and dynamic bound-resource creation.
 *
 * Provides the single source of truth for resource definitions, schemas,
 * and schema output generation. The `ResourceRegistry` class is the
 * extensible core; module-level helpers delegate to `defaultRegistry`
 * for backward compatibility.
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
import { dockerDefinition } from "../resources/docker.ts"
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
 * register at config time.
 */
export class ResourceRegistry {
  private _definitions = new Map<string, ResourceDefinition<unknown, unknown>>()

  /** Register a resource definition. Throws on duplicate type. */
  register<TInput, TOutput>(def: ResourceDefinition<TInput, TOutput>): void {
    if (this._definitions.has(def.type)) {
      throw new Error(`ResourceRegistry: duplicate type "${def.type}"`)
    }
    this._definitions.set(def.type, def as ResourceDefinition<unknown, unknown>)
  }

  /** Get a definition by type name. */
  get(type: string): ResourceDefinition<unknown, unknown> | undefined {
    return this._definitions.get(type)
  }

  /** List all registered type names. */
  types(): string[] {
    return [...this._definitions.keys()]
  }

  /** All registered definitions (for schema generation). */
  definitions(): ResourceDefinition<unknown, unknown>[] {
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
defaultRegistry.register(dockerDefinition)
defaultRegistry.register(serviceDefinition)
defaultRegistry.register(directoryDefinition)

// ---------------------------------------------------------------------------
// Backward-compatible module-level helpers (delegate to defaultRegistry)
// ---------------------------------------------------------------------------

/** Return all registered resource definitions. */
export function getAllDefinitions(): ReadonlyMap<string, ResourceDefinition<unknown, unknown>> {
  const map = new Map<string, ResourceDefinition<unknown, unknown>>()
  for (const def of defaultRegistry.definitions()) {
    map.set(def.type, def)
  }
  return map
}

/** Return a single resource definition by type, or undefined if not found. */
export function getDefinition(type: string): ResourceDefinition<unknown, unknown> | undefined {
  return defaultRegistry.get(type)
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
    pattern: "const { exec, file, apt, docker, service, directory } = createResources(ctx)",
    completeExample:
      "import type { ExecutionContext } from '@grovemotorco/ignition'\nimport { createResources } from '@grovemotorco/ignition'\n\nexport default async function (ctx: ExecutionContext) {\n\tconst { docker, file } = createResources(ctx)\n\tawait docker({ name: 'web', image: 'nginx:1.27', ports: [{ hostPort: 8080, containerPort: 80 }] })\n\tawait file({ path: '/etc/motd', content: 'Managed by Ignition\\n' })\n}",
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
