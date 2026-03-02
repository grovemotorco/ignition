import { test, expect } from "bun:test"
import { expectRejection } from "../helpers/expect-error.ts"
import { loadInventory, resolveTargets } from "../../src/inventory/loader.ts"
import { InventoryError } from "../../src/core/errors.ts"
import type { Inventory } from "../../src/inventory/types.ts"
import { resolve } from "node:path"

/** Resolve a fixture inventory path to an absolute file URL for dynamic import. */
function fixturePath(name: string): string {
  const abs = resolve(process.cwd(), "tests", "fixtures", "inventories", name)
  return new URL(`file://${abs}`).href
}

// ---------------------------------------------------------------------------
// loadInventory — successful loads
// ---------------------------------------------------------------------------

test("loads a valid inventory with groups and hosts", async () => {
  const mod = await loadInventory(fixturePath("valid_inventory.ts"))

  expect(mod.inventory.defaults?.user).toEqual("deploy")
  expect(mod.inventory.defaults?.port).toEqual(22)
  expect(mod.inventory.vars?.env).toEqual("production")
  expect(Object.keys(mod.inventory.groups ?? {}).length).toEqual(2)
  expect(Object.keys(mod.inventory.hosts ?? {}).length).toEqual(1)
  expect(mod.path).toContain("valid_inventory.ts")
})

test("loads a minimal inventory with a single host", async () => {
  const mod = await loadInventory(fixturePath("minimal_inventory.ts"))

  expect(Object.keys(mod.inventory.hosts ?? {}).length).toEqual(1)
  expect(mod.inventory.hosts?.["server-1"]?.hostname).toEqual("192.168.1.100")
})

// ---------------------------------------------------------------------------
// loadInventory — validation errors
// ---------------------------------------------------------------------------

test("throws InventoryError when default export is missing", async () => {
  const err = await expectRejection(
    () => loadInventory(fixturePath("no_default_export.ts")),
    InventoryError,
  )
  expect(err.message).toContain("must default-export an object")
  expect(err.message).toContain("got undefined")
})

test("throws InventoryError when default export is not an object", async () => {
  const err = await expectRejection(
    () => loadInventory(fixturePath("default_not_object.ts")),
    InventoryError,
  )
  expect(err.message).toContain("must default-export an object")
  expect(err.message).toContain("got string")
})

test("throws InventoryError when default export is an array", async () => {
  const err = await expectRejection(
    () => loadInventory(fixturePath("default_array.ts")),
    InventoryError,
  )
  expect(err.message).toContain("must default-export an object")
  expect(err.message).toContain("got array")
})

test("throws InventoryError when default export is null", async () => {
  const err = await expectRejection(
    () => loadInventory(fixturePath("default_null.ts")),
    InventoryError,
  )
  expect(err.message).toContain("must default-export an object")
})

test("throws InventoryError for non-existent file", async () => {
  const err = await expectRejection(
    () => loadInventory("file:///nonexistent/inventory.ts"),
    InventoryError,
  )
  expect(err.message).toContain("Failed to load inventory")
})

// ---------------------------------------------------------------------------
// loadInventory — error shape
// ---------------------------------------------------------------------------

test("InventoryError has correct tag and context", async () => {
  const err = await expectRejection(
    () => loadInventory("file:///nonexistent/inventory.ts"),
    InventoryError,
  )
  expect(err.tag).toEqual("InventoryError")
  expect(err.context.path).toEqual("file:///nonexistent/inventory.ts")
})

test("InventoryError for invalid default has path in context", async () => {
  const path = fixturePath("no_default_export.ts")
  const err = await expectRejection(() => loadInventory(path), InventoryError)
  expect(err.context.path).toEqual(path)
})

// ---------------------------------------------------------------------------
// loadInventory — default behavior
// ---------------------------------------------------------------------------

test("loadInventory without legacy profile options works", async () => {
  const mod = await loadInventory(fixturePath("minimal_inventory.ts"))

  expect(Object.keys(mod.inventory.hosts ?? {}).length).toEqual(1)
})

// ---------------------------------------------------------------------------
// resolveTargets — host name resolution
// ---------------------------------------------------------------------------

const testInventory: Inventory = {
  defaults: { user: "deploy", port: 22 },
  vars: { env: "staging" },
  groups: {
    web: {
      vars: { role: "webserver", pool_size: 4 },
      hosts: {
        "web-1": { hostname: "10.0.1.10", vars: { pool_size: 8 } },
        "web-2": { hostname: "10.0.1.11" },
      },
    },
    db: {
      vars: { role: "database" },
      hosts: {
        "db-1": { hostname: "10.0.2.10", port: 2222 },
      },
    },
  },
  hosts: {
    bastion: { hostname: "203.0.113.1", user: "admin", vars: { role: "bastion" } },
  },
}

test("resolves a standalone host by name", () => {
  const hosts = resolveTargets(testInventory, ["bastion"])

  expect(hosts.length).toEqual(1)
  expect(hosts[0].name).toEqual("bastion")
  expect(hosts[0].hostname).toEqual("203.0.113.1")
  expect(hosts[0].user).toEqual("admin")
  expect(hosts[0].port).toEqual(22)
})

test("resolves a host inside a group by name", () => {
  const hosts = resolveTargets(testInventory, ["web-1"])

  expect(hosts.length).toEqual(1)
  expect(hosts[0].name).toEqual("web-1")
  expect(hosts[0].hostname).toEqual("10.0.1.10")
  expect(hosts[0].user).toEqual("deploy")
})

// ---------------------------------------------------------------------------
// resolveTargets — group resolution
// ---------------------------------------------------------------------------

test("resolves @group to all hosts in the group", () => {
  const hosts = resolveTargets(testInventory, ["@web"])

  expect(hosts.length).toEqual(2)
  expect(hosts[0].name).toEqual("web-1")
  expect(hosts[0].hostname).toEqual("10.0.1.10")
  expect(hosts[1].name).toEqual("web-2")
  expect(hosts[1].hostname).toEqual("10.0.1.11")
})

test("throws InventoryError for unknown group", () => {
  try {
    resolveTargets(testInventory, ["@nonexistent"])
    throw new Error("Expected InventoryError")
  } catch (err) {
    expect((err as InventoryError).tag).toEqual("InventoryError")
    expect((err as InventoryError).message).toContain('Unknown group "nonexistent"')
  }
})

// ---------------------------------------------------------------------------
// resolveTargets — variable merging
// ---------------------------------------------------------------------------

test("merges variables: host vars > group vars > global vars", () => {
  const hosts = resolveTargets(testInventory, ["web-1"])

  // pool_size: host (8) overrides group (4)
  expect(hosts[0].vars.pool_size).toEqual(8)
  // role: from group vars
  expect(hosts[0].vars.role).toEqual("webserver")
  // env: from global vars
  expect(hosts[0].vars.env).toEqual("staging")
})

test("group vars override global vars", () => {
  const hosts = resolveTargets(testInventory, ["web-2"])

  // pool_size: from group (no host override)
  expect(hosts[0].vars.pool_size).toEqual(4)
  // env: from global
  expect(hosts[0].vars.env).toEqual("staging")
})

test("standalone host vars override global vars", () => {
  const hosts = resolveTargets(testInventory, ["bastion"])

  // role: from host vars
  expect(hosts[0].vars.role).toEqual("bastion")
  // env: from global
  expect(hosts[0].vars.env).toEqual("staging")
})

// ---------------------------------------------------------------------------
// resolveTargets — defaults
// ---------------------------------------------------------------------------

test("applies defaults for user and port", () => {
  const hosts = resolveTargets(testInventory, ["web-2"])

  expect(hosts[0].user).toEqual("deploy") // from defaults
  expect(hosts[0].port).toEqual(22) // from defaults
})

test("host port overrides defaults", () => {
  const hosts = resolveTargets(testInventory, ["db-1"])

  expect(hosts[0].port).toEqual(2222) // host overrides default
})

test("host user overrides defaults", () => {
  const hosts = resolveTargets(testInventory, ["bastion"])

  expect(hosts[0].user).toEqual("admin") // host overrides default
})

test("uses fallback defaults when no defaults specified", () => {
  const inv: Inventory = {
    hosts: {
      "server-1": { hostname: "10.0.0.1" },
    },
  }
  const hosts = resolveTargets(inv, ["server-1"])

  expect(hosts[0].user).toEqual("root") // fallback
  expect(hosts[0].port).toEqual(22) // fallback
})

// ---------------------------------------------------------------------------
// resolveTargets — ad-hoc targets
// ---------------------------------------------------------------------------

test("resolves ad-hoc user@host:port target", () => {
  const hosts = resolveTargets(testInventory, ["ubuntu@192.168.1.50:2222"])

  expect(hosts.length).toEqual(1)
  expect(hosts[0].name).toEqual("ubuntu@192.168.1.50:2222")
  expect(hosts[0].hostname).toEqual("192.168.1.50")
  expect(hosts[0].user).toEqual("ubuntu")
  expect(hosts[0].port).toEqual(2222)
  expect(hosts[0].vars).toEqual({})
})

test("resolves ad-hoc user@host target", () => {
  const hosts = resolveTargets(testInventory, ["ubuntu@192.168.1.50"])

  expect(hosts[0].hostname).toEqual("192.168.1.50")
  expect(hosts[0].user).toEqual("ubuntu")
  expect(hosts[0].port).toEqual(22)
})

test("resolves ad-hoc host:port target", () => {
  const hosts = resolveTargets(testInventory, ["192.168.1.50:2222"])

  expect(hosts[0].hostname).toEqual("192.168.1.50")
  expect(hosts[0].user).toEqual("root")
  expect(hosts[0].port).toEqual(2222)
})

// ---------------------------------------------------------------------------
// resolveTargets — comma-separated lists
// ---------------------------------------------------------------------------

test("resolves comma-separated target list", () => {
  const hosts = resolveTargets(testInventory, ["web-1,bastion"])

  expect(hosts.length).toEqual(2)
  expect(hosts[0].name).toEqual("web-1")
  expect(hosts[1].name).toEqual("bastion")
})

test("resolves comma-separated with groups and hosts", () => {
  const hosts = resolveTargets(testInventory, ["@db,bastion"])

  expect(hosts.length).toEqual(2)
  expect(hosts[0].name).toEqual("db-1")
  expect(hosts[1].name).toEqual("bastion")
})

test("resolves multiple target arguments", () => {
  const hosts = resolveTargets(testInventory, ["@web", "bastion"])

  expect(hosts.length).toEqual(3)
  expect(hosts[0].name).toEqual("web-1")
  expect(hosts[1].name).toEqual("web-2")
  expect(hosts[2].name).toEqual("bastion")
})

// ---------------------------------------------------------------------------
// resolveTargets — deduplication
// ---------------------------------------------------------------------------

test("deduplicates hosts across targets", () => {
  const hosts = resolveTargets(testInventory, ["web-1", "@web"])

  expect(hosts.length).toEqual(2) // web-1 not duplicated
  expect(hosts[0].name).toEqual("web-1")
  expect(hosts[1].name).toEqual("web-2")
})

// ---------------------------------------------------------------------------
// resolveTargets — error cases
// ---------------------------------------------------------------------------

test("throws InventoryError for unknown host name", () => {
  try {
    resolveTargets(testInventory, ["nonexistent"])
    throw new Error("Expected InventoryError")
  } catch (err) {
    expect((err as InventoryError).tag).toEqual("InventoryError")
    expect((err as InventoryError).message).toContain('Unknown host "nonexistent"')
  }
})

// ---------------------------------------------------------------------------
// resolveTargets — "did you mean" suggestions
// ---------------------------------------------------------------------------

test("unknown group suggests close match", () => {
  try {
    resolveTargets(testInventory, ["@webs"])
    throw new Error("Expected InventoryError")
  } catch (err) {
    expect((err as InventoryError).message).toContain("Did you mean @web?")
  }
})

test("unknown group lists available groups when no close match", () => {
  try {
    resolveTargets(testInventory, ["@zzzzz"])
    throw new Error("Expected InventoryError")
  } catch (err) {
    expect((err as InventoryError).message).toContain("Available groups:")
  }
})

test("unknown host suggests close match", () => {
  try {
    resolveTargets(testInventory, ["web-11"])
    throw new Error("Expected InventoryError")
  } catch (err) {
    expect((err as InventoryError).message).toContain('Did you mean "web-1"?')
  }
})

// ---------------------------------------------------------------------------
// resolveTargets — empty inventory
// ---------------------------------------------------------------------------

test("resolves ad-hoc target against empty inventory", () => {
  const inv: Inventory = {}
  const hosts = resolveTargets(inv, ["admin@10.0.0.1:2222"])

  expect(hosts.length).toEqual(1)
  expect(hosts[0].hostname).toEqual("10.0.0.1")
  expect(hosts[0].user).toEqual("admin")
  expect(hosts[0].port).toEqual(2222)
})
