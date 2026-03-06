/**
 * Recipe type definitions.
 *
 * Recipes are TypeScript files with a default export function that receives an
 * ExecutionContext and uses resources to configure a host.
 */

import type { ExecutionContext } from "../core/types.ts"

/** A recipe is an async function that takes an ExecutionContext and runs resources. */
export type RecipeFunction = (ctx: ExecutionContext) => Promise<void>

/** Optional metadata exported alongside a recipe's default function. */
export type RecipeMeta = {
  /** Human-readable description of the recipe. */
  description?: string | undefined
  /** Tags for filtering or categorization. */
  tags?: string[] | undefined
}

/**
 * The shape of a loaded recipe module after dynamic import.
 *
 * - `default` -- the recipe function (required)
 * - `meta` -- optional metadata
 */
export type RecipeModule = {
  /** The recipe function. */
  fn: RecipeFunction
  /** Optional metadata from the module's `meta` export. */
  meta?: RecipeMeta | undefined
  /** Resolved path to the recipe file. */
  path: string
}
