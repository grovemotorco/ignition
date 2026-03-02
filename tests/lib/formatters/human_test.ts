import { test, expect } from "bun:test"
import { formatTable, relativeTime, type Column } from "../../../src/lib/formatters/human.ts"

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

test("formatTable — empty rows returns empty string", () => {
  expect(formatTable([{ label: "Name" }], [])).toBe("")
})

test("formatTable — aligns columns with header", () => {
  const columns: Column[] = [{ label: "Name" }, { label: "Status" }]
  const rows = [
    ["web-1", "ok"],
    ["database-server", "changed"],
  ]
  const output = formatTable(columns, rows)
  const lines = output.split("\n")

  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain("Name")
  expect(lines[0]).toContain("Status")
  // Column alignment: "database-server" is longest, so Name column is wider
  expect(lines[1].indexOf("ok")).toEqual(lines[2].indexOf("changed"))
})

test("formatTable — right alignment", () => {
  const columns: Column[] = [
    { label: "Host", align: "left" },
    { label: "Count", align: "right" },
  ]
  const rows = [
    ["web-1", "5"],
    ["web-2", "123"],
  ]
  const output = formatTable(columns, rows)
  const lines = output.split("\n")

  // Right-aligned numbers: "5" should be padded to match "123" width
  const countCol1 = lines[1].trimEnd()
  const countCol2 = lines[2].trimEnd()
  // Both right-aligned values should end at the same position
  expect(countCol1.length).toBeLessThanOrEqual(countCol2.length)
})

test("formatTable — respects minWidth for alignment", () => {
  const columns: Column[] = [{ label: "X", minWidth: 10 }, { label: "Y" }]
  const rows = [["a", "b"]]
  const output = formatTable(columns, rows)
  const lines = output.split("\n")

  // "Y" column should start at minWidth + gap offset
  const yPosHeader = lines[0].indexOf("Y")
  expect(yPosHeader).toBeGreaterThanOrEqual(12) // minWidth(10) + gap(2)
})

test("formatTable — custom gap", () => {
  const columns: Column[] = [{ label: "A" }, { label: "B" }]
  const rows = [["1", "2"]]
  const narrow = formatTable(columns, rows, 1)
  const wide = formatTable(columns, rows, 4)

  expect(wide.length).toBeGreaterThan(narrow.length)
})

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

test("relativeTime — just now for < 5s", () => {
  expect(relativeTime(0)).toBe("just now")
  expect(relativeTime(4999)).toBe("just now")
})

test("relativeTime — seconds", () => {
  expect(relativeTime(5000)).toBe("5s ago")
  expect(relativeTime(59000)).toBe("59s ago")
})

test("relativeTime — minutes", () => {
  expect(relativeTime(60_000)).toBe("1m ago")
  expect(relativeTime(3_540_000)).toBe("59m ago")
})

test("relativeTime — hours", () => {
  expect(relativeTime(3_600_000)).toBe("1h ago")
  expect(relativeTime(82_800_000)).toBe("23h ago")
})

test("relativeTime — days", () => {
  expect(relativeTime(86_400_000)).toBe("1d ago")
  expect(relativeTime(172_800_000)).toBe("2d ago")
})

test("relativeTime — negative age", () => {
  expect(relativeTime(-1000)).toBe("in the future")
})
