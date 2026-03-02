/**
 * Recipe type definitions.
 *
 * Recipes are TypeScript files with a default export function that receives an
 * ExecutionContext and uses resources to configure a host. See ADR-0006.
 */

import type { ExecutionContext } from "../core/types.ts"

/** A recipe is an async function that takes an ExecutionContext and runs resources. */
export type RecipeFunction = (ctx: ExecutionContext) => Promise<void>

/** Optional metadata exported alongside a recipe's default function. */
export interface RecipeMeta {
  /** Human-readable description of the recipe. */
  readonly description?: string
  /** Tags for filtering or categorization. */
  readonly tags?: readonly string[]
}

/**
 * The shape of a loaded recipe module after dynamic import.
 *
 * - `default` -- the recipe function (required)
 * - `meta` -- optional metadata
 */
export interface RecipeModule {
  /** The recipe function. */
  readonly fn: RecipeFunction
  /** Optional metadata from the module's `meta` export. */
  readonly meta?: RecipeMeta
  /** Resolved path to the recipe file. */
  readonly path: string
}
