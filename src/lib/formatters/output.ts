/**
 * Shared output formatting utilities.
 *
 * Low-level helpers used across reporters, formatters, and commands.
 */

/** Format a duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}
