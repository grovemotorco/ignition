/**
 * Reporter interface + PrettyReporter + QuietReporter.
 *
 * The Reporter interface is the contract for output during recipe execution.
 * `PrettyReporter` renders spinners, colors, and structured output to a TTY.
 * `QuietReporter` silently discards all output (useful for tests and embedding).
 */

import type { HostRunSummary, Reporter, ResourceResult, RunMode } from "../core/types.ts"
import type { RedactionPolicy } from "../core/serialize.ts"
import { redact } from "../core/serialize.ts"
import { Spinner } from "./spinner.ts"
import { stderrWriter } from "./stderr.ts"
import {
  statusSymbol,
  statusColor,
  muted,
  bold,
  error as errorColor,
  success,
} from "../lib/colors.ts"
import { formatDuration } from "../lib/formatters/output.ts"
import { computeChanges, formatDiffLines } from "../lib/formatters/diff.ts"

// Re-export for public API compatibility
export { formatDuration } from "../lib/formatters/output.ts"
export type { Reporter } from "../core/types.ts"

// ---------------------------------------------------------------------------
// QuietReporter
// ---------------------------------------------------------------------------

/**
 * A reporter that silently discards all output.
 * Useful for tests, embedding, or when output is handled externally.
 */
export class QuietReporter implements Reporter {
  resourceStart(_type: string, _name: string): void {}
  resourceEnd(_result: ResourceResult): void {}
  hostStart(_host: string, _hostname: string): void {}
  hostEnd(_summary: HostRunSummary): void {}
  checkBanner(): void {}
  resourceOutput(
    _type: string,
    _name: string,
    _stream: "stdout" | "stderr",
    _chunk: string,
  ): void {}
}

// ---------------------------------------------------------------------------
// PrettyReporter
// ---------------------------------------------------------------------------

/** Options for creating a PrettyReporter. */
export type PrettyReporterOptions = {
  /** The writer to output to. Defaults to process.stderr. */
  writer?:
    | {
        isTerminal: () => boolean
        columns?: (() => number | undefined) | undefined
        writeSync(p: Uint8Array): number
      }
    | undefined
  /** The run mode (apply or check). */
  mode: RunMode
  redactionPolicy?: RedactionPolicy | undefined
}

/**
 * Pretty reporter with spinners and colored output.
 *
 * Renders resource execution progress with status symbols, timing,
 * and per-host summaries. In check mode, shows "would change" instead
 * of "changed".
 */
export class PrettyReporter implements Reporter {
  #writer: {
    isTerminal: () => boolean
    columns?: () => number | undefined
    writeSync(p: Uint8Array): number
  }
  #encoder = new TextEncoder()
  #mode: RunMode
  #spinner: Spinner
  #outputBuffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" }
  #streamingActive = false
  #redactionPolicy?: RedactionPolicy | undefined

  constructor(opts: PrettyReporterOptions) {
    this.#writer = opts.writer ?? stderrWriter
    this.#mode = opts.mode
    this.#spinner = new Spinner({ writer: this.#writer })
    this.#redactionPolicy = opts.redactionPolicy
  }

  /** Report the start of a resource execution. */
  resourceStart(type: string, name: string): void {
    this.#streamingActive = false
    this.#spinner.start(`${type}  ${name}`)
  }

  /** Report the end of a resource execution. */
  resourceEnd(result: ResourceResult): void {
    this.#spinner.stop()
    this.#flushBufferedOutput("stdout")
    this.#flushBufferedOutput("stderr")
    this.#streamingActive = false

    const symbol = statusSymbol(result.status)
    const statusLabel = this.#formatStatus(result.status)
    const timing = muted(`(${formatDuration(result.durationMs)})`)
    const typePad = result.type.padEnd(5)
    const cacheLabel = this.#formatCacheStatus(result)

    this.#writeln(`  ${typePad} ${result.name}`)
    this.#writeln(`        ${symbol} ${statusLabel}  ${timing}${cacheLabel}`)
    this.#renderDiff(result)
    if (result.status === "failed" && result.error) {
      this.#writeln(`        ${errorColor(result.error.message)}`)
    }
    this.#writeln("")
  }

  /** Print the host header line. */
  hostStart(host: string, hostname: string): void {
    this.#writeln("")
    this.#writeln(`  ${bold("\u25C6")} ${bold(host)} (${hostname})`)
    this.#writeln("")
  }

  /** Print the per-host summary line. */
  hostEnd(summary: HostRunSummary): void {
    const host = summary.host.name
    const modeLabel = this.#mode === "check" ? " (check)" : ""
    const parts = []

    parts.push(`ok ${summary.ok}`)

    if (this.#mode === "check") {
      parts.push(`would change ${summary.changed}`)
    } else {
      parts.push(`changed ${summary.changed}`)
    }

    if (summary.failed > 0) {
      parts.push(errorColor(`failed ${summary.failed}`))
    } else {
      parts.push(`failed ${summary.failed}`)
    }

    const timing = formatDuration(summary.durationMs)
    this.#writeln(
      `  ${muted("\u2500\u2500")} ${host}${modeLabel}: ${parts.join(muted(" \u00B7 "))} ${muted(`(${timing})`)} ${muted("\u2500\u2500")}`,
    )
    this.#writeln("")
  }

  /** Print the check-mode banner. */
  checkBanner(): void {
    this.#writeln("")
    this.#writeln(`  ${statusColor("[CHECK MODE \u2014 no changes will be applied]", "changed")}`)
  }

  /** Print streaming command output, pausing the spinner to avoid corruption. */
  resourceOutput(_type: string, _name: string, stream: "stdout" | "stderr", chunk: string): void {
    // Keep spinner paused after first streamed chunk. Resuming per chunk
    // causes redraw/output interleaving in interactive terminals.
    if (!this.#streamingActive) {
      this.#spinner.pause()
      this.#streamingActive = true
    }
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const text = this.#outputBuffers[stream] + this.#stripTerminalControl(normalized)
    const lines = text.split("\n")
    this.#outputBuffers[stream] = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) continue
      const formatted =
        stream === "stderr" ? muted(`        \u2502 ${line}`) : `        \u2502 ${line}`
      this.#writeln(formatted)
    }
  }

  /** Remove terminal control sequences from streamed command chunks. */
  #stripTerminalControl(text: string): string {
    /* oxlint-disable no-control-regex -- intentional ANSI escape stripping */
    return text
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[@-_]/g, "")
    /* oxlint-enable no-control-regex */
  }

  #flushBufferedOutput(stream: "stdout" | "stderr"): void {
    const buffered = this.#outputBuffers[stream]
    if (buffered.length === 0) return
    const formatted =
      stream === "stderr" ? muted(`        \u2502 ${buffered}`) : `        \u2502 ${buffered}`
    this.#writeln(formatted)
    this.#outputBuffers[stream] = ""
  }

  #renderDiff(result: ResourceResult): void {
    if (result.status !== "changed") return
    if (!result.current || !result.desired) return

    const current = (
      this.#redactionPolicy ? redact(result.current, this.#redactionPolicy) : result.current
    ) as Record<string, unknown>
    const desired = (
      this.#redactionPolicy ? redact(result.desired, this.#redactionPolicy) : result.desired
    ) as Record<string, unknown>

    const changes = computeChanges(current, desired)
    if (changes.length === 0) return

    const lines = formatDiffLines(changes, current, desired)
    for (const line of lines) {
      if (line.startsWith("- ")) {
        this.#writeln(`          ${errorColor(line)}`)
      } else if (line.startsWith("+ ")) {
        this.#writeln(`          ${success(line)}`)
      } else {
        this.#writeln(`          ${line}`)
      }
    }
  }

  #formatCacheStatus(result: ResourceResult): string {
    if (result.cacheHit === undefined) return ""
    if (result.cacheHit) {
      const age = result.cacheAgeMs !== undefined ? ` ${formatDuration(result.cacheAgeMs)} ago` : ""
      return muted(`  [cache hit${age}]`)
    }
    return muted("  [cache miss]")
  }

  /** Format a status label with color. */
  #formatStatus(status: string): string {
    switch (status) {
      case "ok":
        return statusColor("ok", "ok")
      case "changed":
        return this.#mode === "check"
          ? statusColor("would change", "changed")
          : statusColor("changed", "changed")
      case "failed":
        return statusColor("failed", "failed")
      default:
        return status
    }
  }

  #writeln(text: string): void {
    this.#writer.writeSync(this.#encoder.encode(text + "\n"))
  }
}
