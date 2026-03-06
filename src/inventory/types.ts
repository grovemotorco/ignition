/**
 * Inventory type definitions.
 *
 * Zod schemas are the source of truth — TypeScript types are derived via
 * `z.output<>`. The inventory maps target names to concrete host connection
 * details and variables. TypeScript inventory files default-export an
 * `Inventory` object.
 */

import { z } from "incur"

/** Connection defaults applied to all hosts unless overridden. */
export const InventoryDefaultsSchema = z.object({
  user: z.string().optional(),
  port: z.number().optional(),
  privateKey: z.string().optional(),
})

/** Parsed connection defaults applied to all hosts unless overridden. */
export type InventoryDefaults = z.output<typeof InventoryDefaultsSchema>

/** A host entry in the inventory. */
export const HostSchema = z.object({
  hostname: z.string(),
  user: z.string().optional(),
  port: z.number().optional(),
  privateKey: z.string().optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
})

/** Parsed host entry in the inventory. */
export type Host = z.output<typeof HostSchema>

/** A group of hosts with shared variables. */
export const HostGroupSchema = z.object({
  hosts: z.record(z.string(), HostSchema),
  vars: z.record(z.string(), z.unknown()).optional(),
})

/** Parsed host group with shared variables. */
export type HostGroup = z.output<typeof HostGroupSchema>

/**
 * Top-level inventory structure.
 *
 * An inventory file default-exports an object conforming to this type.
 * Variable merging follows: host vars > group vars > global vars > defaults.
 */
export const InventorySchema = z.object({
  defaults: InventoryDefaultsSchema.optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  groups: z.record(z.string(), HostGroupSchema).optional(),
  hosts: z.record(z.string(), HostSchema).optional(),
})

/** Parsed top-level inventory structure. */
export type Inventory = z.output<typeof InventorySchema>

/**
 * A fully resolved host ready for SSH connection.
 *
 * Produced by `resolveTargets()` after merging variables and applying defaults.
 */
export const ResolvedHostSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  user: z.string(),
  port: z.number(),
  privateKey: z.string().optional(),
  vars: z.record(z.string(), z.unknown()),
})

/** Parsed host after defaults and variables have been resolved. */
export type ResolvedHost = z.output<typeof ResolvedHostSchema>

/**
 * The shape of a loaded inventory module after dynamic import.
 */
export const InventoryModuleSchema = z.object({
  inventory: InventorySchema,
  path: z.string(),
})

/** Parsed inventory module returned by `loadInventory()`. */
export type InventoryModule = z.output<typeof InventoryModuleSchema>
