import { test, expect } from "bun:test"
import { loadInventory } from "../../src/inventory/loader.ts"
import { resolve } from "node:path"

function fixturePath(name: string): string {
  const abs = resolve(process.cwd(), "tests", "fixtures", "inventories", name)
  return new URL(`file://${abs}`).href
}

test("loadInventory returns in-process module", async () => {
  const mod = await loadInventory(fixturePath("valid_inventory.ts"))
  expect(mod.inventory.defaults?.user).toEqual("deploy")
  expect(mod.path).toContain("valid_inventory.ts")
})

test("loadInventory validation still fails for invalid input", async () => {
  let threw = false
  try {
    await loadInventory("file:///nonexistent/inventory.ts")
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("Failed to load inventory")
  }
  expect(threw).toEqual(true)
})
