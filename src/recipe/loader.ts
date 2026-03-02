/**
 * Recipe loader — dynamically imports a recipe .ts file and validates its shape.
 *
 * The loaded module must default-export a function (the recipe). It may
 * optionally export a `meta` object with description and tags. See ADR-0006
 * and ISSUE-0009.
 */

import { RecipeLoadError } from "../core/errors.ts"
import type { RecipeMeta, RecipeModule } from "./types.ts"

/**
 * Load a recipe module from a `.ts` file path via dynamic `import()`.
 *
 * Validates:
 * - The module has a default export that is a function.
 * - If a `meta` export exists, it is an object.
 *
 * Returns a `RecipeModule` with the resolved function, optional meta, and path.
 * Throws `RecipeLoadError` on any failure.
 */
export async function loadRecipe(path: string): Promise<RecipeModule> {
  let mod: any
  try {
    mod = await import(path)
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    throw new RecipeLoadError(path, `Failed to load recipe: ${error.message}`, error)
  }

  return validateRecipeModule(mod, path)
}

/** Validate a recipe module's shape and extract its parts. */
function validateRecipeModule(mod: any, path: string): RecipeModule {
  // Validate default export
  if (typeof mod.default !== "function") {
    throw new RecipeLoadError(
      path,
      `Recipe file must default-export a function, got ${typeof mod.default}`,
    )
  }

  // Extract optional meta
  let meta: RecipeMeta | undefined
  if (mod.meta !== undefined) {
    if (typeof mod.meta !== "object" || mod.meta === null || Array.isArray(mod.meta)) {
      throw new RecipeLoadError(
        path,
        `Recipe meta export must be an object, got ${Array.isArray(mod.meta) ? "array" : typeof mod.meta}`,
      )
    }
    meta = mod.meta as RecipeMeta
  }

  return {
    fn: mod.default,
    meta,
    path,
  }
}
