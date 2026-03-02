import { test, expect } from "bun:test"
import { loadRecipe } from "../../src/recipe/loader.ts"
import { resolve } from "node:path"

function fixturePath(name: string): string {
  const abs = resolve(process.cwd(), "tests", "fixtures", "recipes", name)
  return new URL(`file://${abs}`).href
}

test("loadRecipe returns in-process module", async () => {
  const mod = await loadRecipe(fixturePath("valid_recipe.ts"))
  expect(typeof mod.fn).toEqual("function")
  expect((mod as { workerMode?: unknown }).workerMode).toEqual(undefined)
  expect((mod as { profile?: unknown }).profile).toEqual(undefined)
})

test("loadRecipe validation still fails for invalid exports", async () => {
  let threw = false
  try {
    await loadRecipe(fixturePath("no_default_export.ts"))
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("must default-export a function")
  }
  expect(threw).toEqual(true)
})
