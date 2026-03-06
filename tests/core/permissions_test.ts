import { test, expect } from "bun:test"
import * as mod from "../../src/index.ts"

test("permission profile API is removed from public exports", () => {
  expect("resolvePermissions" in mod).toEqual(false)
  expect("describePermissions" in mod).toEqual(false)
  expect("toDenoFlags" in mod).toEqual(false)
})
