/**
 * Inventory type definitions.
 *
 * Zod schemas are the source of truth — TypeScript types are derived via
 * `z.infer`. The inventory maps target names to concrete host connection
 * details and variables. TypeScript inventory files default-export an
 * `Inventory` object. See ADR-0007 and ISSUE-0010.
 */

import { z } from "incur"

/** Connection defaults applied to all hosts unless overridden. */
export const InventoryDefaultsSchema = z.object({
  user: z.string().optional(),
  port: z.number().optional(),
  privateKey: z.string().optional(),
})

export type InventoryDefaults = z.infer<typeof InventoryDefaultsSchema>

/** A host entry in the inventory. */
export const HostSchema = z.object({
  hostname: z.string(),
  user: z.string().optional(),
  port: z.number().optional(),
  privateKey: z.string().optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
})

export type Host = z.infer<typeof HostSchema>

/** A group of hosts with shared variables. */
export const HostGroupSchema = z.object({
  hosts: z.record(z.string(), HostSchema),
  vars: z.record(z.string(), z.unknown()).optional(),
})

export type HostGroup = z.infer<typeof HostGroupSchema>

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

export type Inventory = z.infer<typeof InventorySchema>

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

export type ResolvedHost = z.infer<typeof ResolvedHostSchema>

/**
 * The shape of a loaded inventory module after dynamic import.
 */
export const InventoryModuleSchema = z.object({
  inventory: InventorySchema,
  path: z.string(),
})

export type InventoryModule = z.infer<typeof InventoryModuleSchema>
