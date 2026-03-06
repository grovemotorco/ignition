/**
 * Output formatters — JsonFormatter and MinimalFormatter.
 *
 * These format a RunSummary for non-interactive output. `JsonFormatter`
 * emits machine-readable JSON. `MinimalFormatter` emits a compact
 * one-line-per-resource format.
 */

import type { HostRunSummary, ResourceResult, RunMode, RunSummary } from "../core/types.ts"
import type { RedactionPolicy } from "../core/serialize.ts"
import { redact } from "../core/serialize.ts"
import type { LifecycleEvent } from "./events.ts"
import { formatDuration } from "../lib/formatters/output.ts"

// ---------------------------------------------------------------------------
// JsonFormatter
// ---------------------------------------------------------------------------

/**
 * Formats a RunSummary as JSON.
 *
 * Serializes the full summary including per-host results. Errors are
 * serialized as `{ message, name }` since Error objects don't JSON.stringify
 * by default.
 *
 * Also supports formatting individual lifecycle events for schema-consistent
 * output.
 */
export class JsonFormatter {
  #redactionPolicy?: RedactionPolicy | undefined

  constructor(opts: { redactionPolicy?: RedactionPolicy | undefined } = {}) {
    this.#redactionPolicy = opts.redactionPolicy
  }

  /** Format a RunSummary as a JSON string. */
  format(summary: RunSummary): string {
    const output = this.#redactionPolicy ? redact(summary, this.#redactionPolicy) : summary
    return JSON.stringify(output, serializeError, 2)
  }

  /** Format a single lifecycle event as a JSON string. */
  formatEvent(event: LifecycleEvent): string {
    const output = this.#redactionPolicy ? redact(event, this.#redactionPolicy) : event
    return JSON.stringify(output, serializeError, 2)
  }
}

/** JSON replacer that serializes Error instances as { message, name }. */
function serializeError(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name }
  }
  return value
}

// ---------------------------------------------------------------------------
// MinimalFormatter
// ---------------------------------------------------------------------------

/**
 * Formats a RunSummary as compact one-line-per-resource output.
 *
 * Each resource is a single line: `status type name (duration)`.
 * Each host gets a summary line at the end. In check mode, "changed"
 * is displayed as "would change".
 */
export class MinimalFormatter {
  #mode: RunMode

  constructor(mode: RunMode) {
    this.#mode = mode
  }

  /** Format a RunSummary as a minimal string. */
  format(summary: RunSummary): string {
    const lines: string[] = []

    for (const host of summary.hosts) {
      lines.push(...this.#formatHost(host))
    }

    return lines.join("\n")
  }

  #formatHost(host: HostRunSummary): string[] {
    const lines: string[] = []

    lines.push(`${host.host.name} (${host.host.hostname})`)

    for (const result of host.results) {
      lines.push(this.#formatResult(result))
    }

    lines.push(this.#formatSummaryLine(host))
    lines.push("")

    return lines
  }

  #formatResult(result: ResourceResult): string {
    const status = this.#formatStatus(result.status)
    const timing = formatDuration(result.durationMs)
    return `  ${status} ${result.type} ${result.name} (${timing})`
  }

  #formatStatus(status: string): string {
    if (status === "changed" && this.#mode === "check") {
      return "would change"
    }
    return status
  }

  #formatSummaryLine(host: HostRunSummary): string {
    const parts = [`ok ${host.ok}`]

    if (this.#mode === "check") {
      parts.push(`would change ${host.changed}`)
    } else {
      parts.push(`changed ${host.changed}`)
    }

    parts.push(`failed ${host.failed}`)

    const timing = formatDuration(host.durationMs)
    return `  --- ${host.host.name}: ${parts.join(" · ")} (${timing})`
  }
}
