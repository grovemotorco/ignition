import { Cli, z } from "incur"
import {
  getAllResourceSchemas,
  getInventorySchema,
  getRecipeSchema,
  getResourceSchema,
  getResourceTypes,
  getRunSummarySchema,
} from "../../core/registry.ts"

/** CLI command that prints machine-readable schemas for Ignition surfaces. */
export const schema = Cli.create("schema", {
  description: "Display resource schemas and CLI grammar",
})
  .command("resources", {
    description: "List all resources with descriptions",
    output: z.record(z.string(), z.unknown()),
    run() {
      const schemas = getAllResourceSchemas()
      const obj: Record<string, unknown> = {}
      for (const [type, s] of schemas) {
        obj[type] = s
      }
      return obj
    },
  })
  .command("resource", {
    description: "Display full schema for one resource",
    args: z.object({ name: z.string().describe("Resource name") }),
    output: z.unknown(),
    run(c) {
      const name = c.args.name
      const resourceSchema = getResourceSchema(name)
      if (!resourceSchema) {
        const types = getResourceTypes()
        return c.error({
          code: "UNKNOWN_RESOURCE",
          message: `Unknown resource: "${name}". Available resources: ${types.join(", ")}`,
        })
      }
      return resourceSchema
    },
  })
  .command("recipe", {
    description: "Display recipe format schema",
    output: z.record(z.string(), z.unknown()),
    run() {
      return getRecipeSchema()
    },
  })
  .command("inventory", {
    description: "Display inventory format schema",
    output: z.record(z.string(), z.unknown()),
    run() {
      return getInventorySchema()
    },
  })
  .command("output", {
    description: "Display output contract schema",
    output: z.record(z.string(), z.unknown()),
    run() {
      return getRunSummarySchema()
    },
  })
