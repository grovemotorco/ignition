import { test, expect } from "bun:test"
import { inventoryCommand } from "../../../src/cli/commands/inventory.ts"
import { resolve } from "node:path"

/** Resolve a fixture inventory path to an absolute file path. */
function fixturePath(name: string): string {
  return resolve(process.cwd(), "tests", "fixtures", "inventories", name)
}

// ---------------------------------------------------------------------------
// No file specified
// ---------------------------------------------------------------------------

test("inventory command returns 1 when no file specified", async () => {
  const code = await inventoryCommand({ format: "pretty" })

  expect(code).toEqual(1)
})

// ---------------------------------------------------------------------------
// Uses --inventory option when no positional file
// ---------------------------------------------------------------------------

test("inventory command uses --inventory option", async () => {
  const code = await inventoryCommand({
    inventory: fixturePath("valid_inventory.ts"),
    format: "pretty",
  })

  expect(code).toEqual(0)
})

// ---------------------------------------------------------------------------
// Loads and displays inventory
// ---------------------------------------------------------------------------

test("inventory command loads and displays inventory", async () => {
  const code = await inventoryCommand({
    file: fixturePath("valid_inventory.ts"),
    format: "pretty",
  })

  expect(code).toEqual(0)
})

test("inventory command supports json format", async () => {
  const code = await inventoryCommand({
    file: fixturePath("valid_inventory.ts"),
    format: "json",
  })

  expect(code).toEqual(0)
})

test("inventory command supports minimal format", async () => {
  const code = await inventoryCommand({
    file: fixturePath("minimal_inventory.ts"),
    format: "minimal",
  })

  expect(code).toEqual(0)
})
