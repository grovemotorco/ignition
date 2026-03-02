import { test, expect } from "bun:test"

test("worker-specific error classes were removed in Bun migration", async () => {
  const mod = await import("../../src/core/errors.ts")
  expect("SandboxPolicyError" in mod).toEqual(false)
  expect("WorkerProtocolError" in mod).toEqual(false)
})
