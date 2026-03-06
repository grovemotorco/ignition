import { Cli, z } from "incur"
import { resolve } from "node:path"
import { loadInventory } from "../../inventory/loader.ts"
import { InventorySchema } from "../../inventory/types.ts"

export const inventory = Cli.create("inventory", {
  description: "Display hosts from an inventory file",
  args: z.object({
    file: z.string().optional().describe("Inventory file path"),
  }),
  options: z.object({
    inventory: z.string().optional().describe("Inventory file path (alternative to arg)"),
    trace: z.boolean().optional().describe("Show detailed output"),
  }),
  output: InventorySchema,
  async run(c) {
    const file = c.args.file ?? c.options.inventory
    if (!file) {
      return c.error({
        code: "NO_INVENTORY",
        message:
          "No inventory file specified. Use: ignition inventory <file> or --inventory <file>",
      })
    }

    const inventoryPath = resolve(process.cwd(), file)
    const inventoryUrl = new URL(`file://${inventoryPath}`).href
    const { inventory } = await loadInventory(inventoryUrl)

    return c.ok(inventory)
  },
})
