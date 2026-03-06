// ---------------------------------------------------------------------------
// Ignition — public API
// ---------------------------------------------------------------------------

// -- Version ----------------------------------------------------------------
export { VERSION } from "./cli/index.ts"

// -- Recipe authoring -------------------------------------------------------
export type { ExecutionContext, TemplateContext } from "./core/types.ts"
export { createResources } from "./resources/index.ts"

// -- Inventory authoring ----------------------------------------------------
export type {
  Host,
  HostGroup,
  Inventory,
  InventoryDefaults,
  InventoryModule,
  ResolvedHost,
} from "./inventory/types.ts"

// -- Config -----------------------------------------------------------------
export type { IgnitionConfig } from "./lib/config.ts"
