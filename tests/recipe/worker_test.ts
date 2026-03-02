import { test, expect } from "bun:test"

test("legacy recipe worker module no longer exists", async () => {
  const legacyWorkerPath = "../../src/recipe/worker.ts" as string
  let threw = false
  try {
    await import(legacyWorkerPath)
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
})
