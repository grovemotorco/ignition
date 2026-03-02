import { test, expect } from "bun:test"
import { executeRecipeCommand } from "../../../src/cli/commands/shared.ts"

test("run command throws InventoryError for unknown group target", async () => {
  let threw = false
  try {
    await executeRecipeCommand({
      mode: "apply",
      recipe: "setup.ts",
      targets: ["@web"],
      options: {
        tags: [],
        vars: {},
      },
    })
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
})
