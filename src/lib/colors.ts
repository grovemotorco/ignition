/**
 * Semantic color helpers for CLI output.
 *
 * Provides a consistent color vocabulary across the CLI. All output coloring
 * should use these helpers instead of raw chalk calls. See ISSUE-0043.
 */

import chalk from "chalk"

// ---------------------------------------------------------------------------
// Semantic colors
// ---------------------------------------------------------------------------

export const success = (text: string): string => chalk.green(text)
export const error = (text: string): string => chalk.red(text)
export const warning = (text: string): string => chalk.yellow(text)
export const info = (text: string): string => chalk.cyan(text)
export const header = (text: string): string => chalk.bold(text)
export const muted = (text: string): string => chalk.dim(text)
export const bold = (text: string): string => chalk.bold(text)

// ---------------------------------------------------------------------------
// Status colors — map resource statuses to visual indicators
// ---------------------------------------------------------------------------

/** Status symbols for resource results. */
export const STATUS_SYMBOLS: Record<string, string> = {
  ok: "\u25CF",
  changed: "\u2713",
  failed: "\u2717",
}

/** Get the status symbol for a resource status. */
export function statusSymbol(status: string): string {
  return STATUS_SYMBOLS[status] ?? "?"
}

// ---------------------------------------------------------------------------
// ANSI stripping — shared regex for width calculation and blank-line detection
// ---------------------------------------------------------------------------

/** Pattern matching ANSI SGR escape sequences (including compound codes). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[\d+(?:;\d+)*m/g

/** Strip ANSI escape sequences from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

// ---------------------------------------------------------------------------
// Status colors — map resource statuses to visual indicators
// ---------------------------------------------------------------------------

/** Color text based on resource status. */
export function statusColor(text: string, status: string): string {
  switch (status) {
    case "ok":
      return chalk.green(text)
    case "changed":
      return chalk.yellow(text)
    case "failed":
      return chalk.red(text)
    default:
      return text
  }
}
