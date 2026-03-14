import { test, expect } from "bun:test"
import {
  computeChanges,
  formatDiffLines,
  formatContentDiff,
} from "../../src/lib/formatters/diff.ts"

// ---------------------------------------------------------------------------
// computeChanges
// ---------------------------------------------------------------------------

test("computeChanges — scalar field changes", () => {
  const current = { mode: "644", owner: "root", checksum: "abc" }
  const desired = { state: "present", mode: "755", checksum: "def" }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([
    { field: "mode", current: "644", desired: "755" },
    { field: "checksum", current: "abc", desired: "def" },
  ])
})

test("computeChanges — addition-only fields (key in desired but not current)", () => {
  const current = { exists: false }
  const desired = { state: "present", mode: "644" }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([{ field: "mode", current: undefined, desired: "644" }])
})

test("computeChanges — returns empty array when current and desired match", () => {
  const current = { mode: "644", owner: "root" }
  const desired = { state: "present", mode: "644", owner: "root" }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([])
})

test("computeChanges — nested object values", () => {
  const current = { installed: { nginx: null } }
  const desired = { state: "present", installed: { nginx: "1.18.0" } }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([
    {
      field: "installed",
      current: '{"nginx":null}',
      desired: '{"nginx":"1.18.0"}',
    },
  ])
})

test("computeChanges — skips state field", () => {
  const current = { exists: true }
  const desired = { state: "present" }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([])
})

test("computeChanges — boolean and number values", () => {
  const current = { enabled: false, count: 1 }
  const desired = { enabled: true, count: 3 }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([
    { field: "enabled", current: "false", desired: "true" },
    { field: "count", current: "1", desired: "3" },
  ])
})

// ---------------------------------------------------------------------------
// formatDiffLines
// ---------------------------------------------------------------------------

test("formatDiffLines — produces - / + prefixed output", () => {
  const changes = computeChanges(
    { mode: "644", owner: "root" },
    { state: "present", mode: "755", owner: "deploy" },
  )

  const lines = formatDiffLines(changes)

  expect(lines).toEqual(["- mode: 644", "+ mode: 755", "- owner: root", "+ owner: deploy"])
})

test("formatDiffLines — addition-only shows only + line", () => {
  const changes = computeChanges({ exists: false }, { state: "present", mode: "644" })

  const lines = formatDiffLines(changes)

  expect(lines).toEqual(["+ mode: 644"])
})

test("formatDiffLines — delegates to formatContentDiff for string content fields", () => {
  const current = { content: "line1\nline2" }
  const desired = { content: "line1\nline3" }
  const changes = computeChanges(current, desired)

  const lines = formatDiffLines(changes, current, desired)

  expect(lines).toEqual(["- line2", "+ line3"])
})

// ---------------------------------------------------------------------------
// formatContentDiff
// ---------------------------------------------------------------------------

test("formatContentDiff — changed lines", () => {
  const lines = formatContentDiff(
    "listen 80;\nserver_name _;",
    "listen 443 ssl;\nserver_name app.example.com;",
  )

  expect(lines).toEqual([
    "- listen 80;",
    "+ listen 443 ssl;",
    "- server_name _;",
    "+ server_name app.example.com;",
  ])
})

test("formatContentDiff — added lines", () => {
  const lines = formatContentDiff("line1", "line1\nline2\nline3")

  expect(lines).toEqual(["+ line2", "+ line3"])
})

test("formatContentDiff — removed lines", () => {
  const lines = formatContentDiff("line1\nline2\nline3", "line1")

  expect(lines).toEqual(["- line2", "- line3"])
})

test("formatContentDiff — identical content returns empty array", () => {
  const lines = formatContentDiff("same\ncontent", "same\ncontent")

  expect(lines).toEqual([])
})

test("formatContentDiff — completely different content", () => {
  const lines = formatContentDiff("alpha\nbeta", "gamma\ndelta")

  expect(lines).toEqual(["- alpha", "+ gamma", "- beta", "+ delta"])
})

// ---------------------------------------------------------------------------
// Resource-specific diff shapes
// ---------------------------------------------------------------------------

test("computeChanges — apt resource shape (installed map vs packages)", () => {
  const current = { installed: { nginx: null, curl: "7.68.0" } }
  const desired = { state: "present", installed: { nginx: "1.18.0", curl: "7.68.0" } }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([
    {
      field: "installed",
      current: '{"nginx":null,"curl":"7.68.0"}',
      desired: '{"nginx":"1.18.0","curl":"7.68.0"}',
    },
  ])
})

test("computeChanges — service resource shape (active/enabled vs state)", () => {
  const current = { active: "inactive", enabled: "disabled" }
  const desired = { state: "started", enabled: true }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([{ field: "enabled", current: "disabled", desired: "true" }])
})

test("computeChanges — directory resource shape (mode, owner, group)", () => {
  const current = { exists: true, mode: "755", owner: "root", group: "root" }
  const desired = { state: "present", owner: "deploy", group: "deploy" }

  const changes = computeChanges(current, desired)

  expect(changes).toEqual([
    { field: "owner", current: "root", desired: "deploy" },
    { field: "group", current: "root", desired: "deploy" },
  ])
})

test("formatDiffLines — readable output for nested package maps", () => {
  const changes = computeChanges(
    { installed: { nginx: null } },
    { state: "present", installed: { nginx: "1.18.0" } },
  )

  const lines = formatDiffLines(changes)

  expect(lines).toEqual(['- installed: {"nginx":null}', '+ installed: {"nginx":"1.18.0"}'])
})
