import { test, expect } from "bun:test"
import { formatDuration } from "../../../src/lib/formatters/output.ts"

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

test("formatDuration — sub-second values show ms", () => {
  expect(formatDuration(0)).toEqual("0ms")
  expect(formatDuration(150)).toEqual("150ms")
  expect(formatDuration(999)).toEqual("999ms")
})

test("formatDuration — values >= 1000 show seconds", () => {
  expect(formatDuration(1000)).toEqual("1.0s")
  expect(formatDuration(1500)).toEqual("1.5s")
  expect(formatDuration(12345)).toEqual("12.3s")
})

test("formatDuration — rounds ms values", () => {
  expect(formatDuration(1.7)).toEqual("2ms")
  expect(formatDuration(99.4)).toEqual("99ms")
})
