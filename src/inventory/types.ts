/**
 * Inventory type definitions.
 *
 * The inventory maps target names to concrete host connection details and
 * variables. TypeScript inventory files default-export an `Inventory` object.
 * See ADR-0007 and ISSUE-0010.
 */

/** Connection defaults applied to all hosts unless overridden. */
export interface InventoryDefaults {
  /** Default SSH user. */
  readonly user?: string
  /** Default SSH port. */
  readonly port?: number
  /** Default path to SSH private key. */
  readonly privateKey?: string
}

/** A host entry in the inventory. */
export interface Host {
  /** SSH hostname or IP address. */
  readonly hostname: string
  /** SSH user (overrides group/global/default). */
  readonly user?: string
  /** SSH port (overrides group/global/default). */
  readonly port?: number
  /** Path to SSH private key (overrides group/global/default). */
  readonly privateKey?: string
  /** Host-level variables (highest precedence). */
  readonly vars?: Record<string, unknown>
}

/** A group of hosts with shared variables. */
export interface HostGroup {
  /** Hosts in this group, keyed by logical name. */
  readonly hosts: Readonly<Record<string, Host>>
  /** Group-level variables (applied to all hosts in the group). */
  readonly vars?: Record<string, unknown>
}

/**
 * Top-level inventory structure.
 *
 * An inventory file default-exports an object conforming to this interface.
 * Variable merging follows: host vars > group vars > global vars > defaults.
 */
export interface Inventory {
  /** Connection defaults applied to all hosts. */
  readonly defaults?: InventoryDefaults
  /** Global variables (lowest precedence after defaults). */
  readonly vars?: Record<string, unknown>
  /** Named groups of hosts. Referenced as `@groupName` in targets. */
  readonly groups?: Readonly<Record<string, HostGroup>>
  /** Standalone hosts not belonging to any group. */
  readonly hosts?: Readonly<Record<string, Host>>
}

/**
 * A fully resolved host ready for SSH connection.
 *
 * Produced by `resolveTargets()` after merging variables and applying defaults.
 */
export interface ResolvedHost {
  /** Logical host name (from inventory or ad-hoc). */
  readonly name: string
  /** SSH hostname or IP address. */
  readonly hostname: string
  /** SSH user. */
  readonly user: string
  /** SSH port. */
  readonly port: number
  /** Path to SSH private key, if specified. */
  readonly privateKey?: string
  /** Merged variables: host vars > group vars > global vars. */
  readonly vars: Record<string, unknown>
}

/**
 * The shape of a loaded inventory module after dynamic import.
 */
export interface InventoryModule {
  /** The resolved inventory object. */
  readonly inventory: Inventory
  /** Resolved path to the inventory file. */
  readonly path: string
}
