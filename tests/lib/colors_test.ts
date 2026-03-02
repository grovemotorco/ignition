import { test, expect } from "bun:test"
import {
  success,
  error,
  warning,
  info,
  header,
  muted,
  bold,
  statusSymbol,
  statusColor,
  stripAnsi,
  STATUS_SYMBOLS,
} from "../../src/lib/colors.ts"

// ---------------------------------------------------------------------------
// Semantic color helpers
// ---------------------------------------------------------------------------

test("success — wraps text", () => {
  expect(success("ok")).toContain("ok")
})

test("error — wraps text", () => {
  expect(error("fail")).toContain("fail")
})

test("warning — wraps text", () => {
  expect(warning("warn")).toContain("warn")
})

test("info — wraps text", () => {
  expect(info("hint")).toContain("hint")
})

test("header — wraps text", () => {
  expect(header("title")).toContain("title")
})

test("muted — wraps text", () => {
  expect(muted("dim")).toContain("dim")
})

test("bold — wraps text", () => {
  expect(bold("strong")).toContain("strong")
})

// ---------------------------------------------------------------------------
// Status symbols
// ---------------------------------------------------------------------------

test("STATUS_SYMBOLS — has entries for ok, changed, failed", () => {
  expect(STATUS_SYMBOLS.ok).toBeDefined()
  expect(STATUS_SYMBOLS.changed).toBeDefined()
  expect(STATUS_SYMBOLS.failed).toBeDefined()
})

test("statusSymbol — returns symbol for known statuses", () => {
  expect(statusSymbol("ok")).toEqual(STATUS_SYMBOLS.ok)
  expect(statusSymbol("changed")).toEqual(STATUS_SYMBOLS.changed)
  expect(statusSymbol("failed")).toEqual(STATUS_SYMBOLS.failed)
})

test("statusSymbol — returns ? for unknown status", () => {
  expect(statusSymbol("unknown")).toEqual("?")
})

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

test("statusColor — colors text for known statuses", () => {
  expect(statusColor("text", "ok")).toContain("text")
  expect(statusColor("text", "changed")).toContain("text")
  expect(statusColor("text", "failed")).toContain("text")
})

test("statusColor — returns plain text for unknown status", () => {
  expect(statusColor("text", "other")).toEqual("text")
})

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

test("stripAnsi — removes single SGR codes", () => {
  expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toEqual("green")
})

test("stripAnsi — removes compound SGR codes", () => {
  expect(stripAnsi("\x1b[1;32mbold green\x1b[0m")).toEqual("bold green")
})

test("stripAnsi — returns plain text unchanged", () => {
  expect(stripAnsi("no colors")).toEqual("no colors")
})
