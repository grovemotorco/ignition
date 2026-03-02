import { test, expect } from "bun:test"
import { resolve } from "node:path"
import { expectRejection } from "../helpers/expect-error.ts"
import { loadRecipe } from "../../src/recipe/loader.ts"
import { RecipeLoadError } from "../../src/core/errors.ts"

/** Resolve a fixture recipe path to an absolute file URL for dynamic import. */
function fixturePath(name: string): string {
  const abs = resolve(process.cwd(), "tests", "fixtures", "recipes", name)
  return new URL(`file://${abs}`).href
}

// ---------------------------------------------------------------------------
// Successful loads
// ---------------------------------------------------------------------------

test("loads a valid recipe with default export", async () => {
  const mod = await loadRecipe(fixturePath("valid_recipe.ts"))

  expect(typeof mod.fn).toEqual("function")
  expect(mod.meta).toEqual(undefined)
  expect(mod.path).toContain("valid_recipe.ts")
})

test("loads a valid recipe with meta", async () => {
  const mod = await loadRecipe(fixturePath("valid_recipe_with_meta.ts"))

  expect(typeof mod.fn).toEqual("function")
  expect(mod.meta?.description).toEqual("Install and configure nginx")
  expect(mod.meta?.tags).toEqual(["web", "nginx"])
})

test("loads a recipe with partial meta (description only)", async () => {
  const mod = await loadRecipe(fixturePath("partial_meta.ts"))

  expect(typeof mod.fn).toEqual("function")
  expect(mod.meta?.description).toEqual("Setup base packages")
  expect(mod.meta?.tags).toEqual(undefined)
})

test("loaded recipe function is callable", async () => {
  const mod = await loadRecipe(fixturePath("valid_recipe.ts"))

  // Should not throw
  await mod.fn(undefined as unknown as Parameters<typeof mod.fn>[0])
})

// ---------------------------------------------------------------------------
// Validation: missing or invalid default export
// ---------------------------------------------------------------------------

test("throws RecipeLoadError when default export is missing", async () => {
  const err = await expectRejection(
    () => loadRecipe(fixturePath("no_default_export.ts")),
    RecipeLoadError,
  )
  expect(err.message).toContain("must default-export a function")
  expect(err.message).toContain("got undefined")
})

test("throws RecipeLoadError when default export is not a function", async () => {
  const err = await expectRejection(
    () => loadRecipe(fixturePath("default_not_function.ts")),
    RecipeLoadError,
  )
  expect(err.message).toContain("must default-export a function")
  expect(err.message).toContain("got string")
})

// ---------------------------------------------------------------------------
// Validation: invalid meta
// ---------------------------------------------------------------------------

test("throws RecipeLoadError when meta is not an object", async () => {
  const err = await expectRejection(
    () => loadRecipe(fixturePath("invalid_meta.ts")),
    RecipeLoadError,
  )
  expect(err.message).toContain("meta export must be an object")
  expect(err.message).toContain("got string")
})

test("throws RecipeLoadError when meta is an array", async () => {
  const err = await expectRejection(() => loadRecipe(fixturePath("meta_array.ts")), RecipeLoadError)
  expect(err.message).toContain("meta export must be an object")
  expect(err.message).toContain("got array")
})

// ---------------------------------------------------------------------------
// File not found
// ---------------------------------------------------------------------------

test("throws RecipeLoadError for non-existent file", async () => {
  const err = await expectRejection(
    () => loadRecipe("file:///nonexistent/recipe.ts"),
    RecipeLoadError,
  )
  expect(err.message).toContain("Failed to load recipe")
})

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

test("RecipeLoadError has correct tag and context", async () => {
  const err = await expectRejection(
    () => loadRecipe("file:///nonexistent/recipe.ts"),
    RecipeLoadError,
  )
  expect(err.tag).toEqual("RecipeLoadError")
  expect(err.context.path).toEqual("file:///nonexistent/recipe.ts")
})

test("RecipeLoadError for invalid default has path in context", async () => {
  const path = fixturePath("no_default_export.ts")
  const err = await expectRejection(() => loadRecipe(path), RecipeLoadError)
  expect(err.context.path).toEqual(path)
})

// ---------------------------------------------------------------------------
// Default behavior
// ---------------------------------------------------------------------------

test("loadRecipe without options defaults to trusted", async () => {
  const mod = await loadRecipe(fixturePath("valid_recipe.ts"))

  expect(typeof mod.fn).toEqual("function")
})
