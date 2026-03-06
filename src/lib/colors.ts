/**
 * Semantic color helpers for CLI output.
 *
 * Provides a consistent color vocabulary across the CLI. All output coloring
 * should use these helpers instead of raw ANSI codes.
 */

const ANSI_PREFIX = "\x1b["
const ANSI_RESET = `${ANSI_PREFIX}0m`

function colorsEnabled(): boolean {
  const forceColor = process.env.FORCE_COLOR
  if (forceColor === "0") return false
  if (forceColor !== undefined) return true
  if ("NO_COLOR" in process.env) return false
  if (process.env.TERM === "dumb") return false
  return Boolean(process.stdout.isTTY || process.stderr.isTTY)
}

function withAnsi(code: number, text: string): string {
  if (!colorsEnabled()) return text
  return `${ANSI_PREFIX}${code}m${text}${ANSI_RESET}`
}

// ---------------------------------------------------------------------------
// Semantic colors
// ---------------------------------------------------------------------------

/** Color successful status text. */
export const success = (text: string): string => withAnsi(32, text)
/** Color error status text. */
export const error = (text: string): string => withAnsi(31, text)
/** Color warning status text. */
export const warning = (text: string): string => withAnsi(33, text)
/** Color informational status text. */
export const info = (text: string): string => withAnsi(36, text)
/** Apply heading emphasis. */
export const header = (text: string): string => withAnsi(1, text)
/** Dim less-important text. */
export const muted = (text: string): string => withAnsi(2, text)
/** Apply bold emphasis. */
export const bold = (text: string): string => withAnsi(1, text)

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
      return success(text)
    case "changed":
      return warning(text)
    case "failed":
      return error(text)
    default:
      return text
  }
}
