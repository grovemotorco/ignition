/**
 * Human-readable formatting utilities.
 *
 * Table formatting, column alignment, and relative time display
 * for CLI output. See ISSUE-0043.
 */

import { stripAnsi } from "../colors.ts"

/** A column definition for table formatting. */
export interface Column {
  /** Column header label. */
  readonly label: string
  /** Alignment within the column. Defaults to "left". */
  readonly align?: "left" | "right"
  /** Minimum column width (in characters). */
  readonly minWidth?: number
}

/**
 * Format rows as an aligned table.
 *
 * Each row is an array of cell values matching the column definitions.
 * Columns are separated by the given gap (default 2 spaces).
 */
export function formatTable(
  columns: readonly Column[],
  rows: readonly string[][],
  gap = 2,
): string {
  if (rows.length === 0) return ""

  const gapStr = " ".repeat(gap)

  // Compute column widths (max of header and all cell values)
  const widths = columns.map((col, i) => {
    const headerLen = col.label.length
    const maxCell = rows.reduce((max, row) => Math.max(max, stripAnsi(row[i] ?? "").length), 0)
    return Math.max(headerLen, maxCell, col.minWidth ?? 0)
  })

  // Format header
  const header = columns
    .map((col, i) => padCell(col.label, widths[i], col.align ?? "left"))
    .join(gapStr)

  // Format rows
  const formatted = rows.map((row) =>
    columns.map((col, i) => padCell(row[i] ?? "", widths[i], col.align ?? "left")).join(gapStr),
  )

  return [header.trimEnd(), ...formatted.map((r) => r.trimEnd())].join("\n")
}

/**
 * Format a relative time string from a timestamp or milliseconds age.
 *
 * Returns human-friendly strings like "just now", "5s ago", "3m ago",
 * "2h ago", "1d ago".
 */
export function relativeTime(ageMs: number): string {
  if (ageMs < 0) return "in the future"

  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Pad a cell value to the given width, respecting alignment. */
function padCell(text: string, width: number, align: "left" | "right"): string {
  const visible = stripAnsi(text).length
  const pad = Math.max(0, width - visible)
  if (align === "right") {
    return " ".repeat(pad) + text
  }
  return text + " ".repeat(pad)
}
