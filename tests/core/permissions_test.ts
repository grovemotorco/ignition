import { test, expect } from "bun:test"
import { getCliSchema } from "../../src/core/registry.ts"
import * as mod from "../../src/index.ts"

test("permission profile API is removed from public exports", () => {
  expect("resolvePermissions" in mod).toEqual(false)
  expect("describePermissions" in mod).toEqual(false)
  expect("toDenoFlags" in mod).toEqual(false)
})

test("CLI schema no longer exposes --permission-profile", () => {
  const schema = getCliSchema() as { commands: { run?: { flags?: Array<{ name?: string }> } } }
  const runFlags = schema.commands.run?.flags ?? []
  expect(runFlags.some((f) => f.name === "--permission-profile")).toEqual(false)
})
