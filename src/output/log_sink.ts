/**
 * File-based structured logging sink for lifecycle events.
 *
 * Subscribes to the EventBus and writes all events as NDJSON to a log file,
 * providing persistent, machine-readable audit trails. See ISSUE-0039.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import type { EventListener, LifecycleEvent } from "./events.ts"

/** JSON replacer that serializes Error instances. */
function serializeError(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name }
  }
  return value
}

/**
 * Format a timestamp for use in log file names.
 *
 * Converts an ISO-8601 timestamp to a filesystem-safe format by replacing
 * colons with hyphens and removing fractional seconds:
 * `2025-06-15T10:32:01.123Z` -> `2025-06-15T10-32-01Z`
 */
export function formatTimestamp(iso: string): string {
  // Strip fractional seconds and replace colons
  return iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-")
}

/** Options for creating a FileLogSink. */
export interface FileLogSinkOptions {
  /** Directory to write log files into. Created if absent. */
  readonly logDir: string
}

/**
 * Writes lifecycle events as NDJSON to a file.
 *
 * Opens (or creates) a log file at the start of a run, subscribes to the
 * EventBus via `bus.on(sink.listener)`, and writes each event as a single
 * NDJSON line. The file is flushed and closed when `close()` is called or
 * when a `run_finished` event is received.
 */
export class FileLogSink {
  readonly #logDir: string
  readonly #encoder = new TextEncoder()
  #fd: number | null = null
  #closed = false
  #filePath: string | null = null

  constructor(options: FileLogSinkOptions) {
    this.#logDir = options.logDir
  }

  /** The path to the log file, once opened. */
  get filePath(): string | null {
    return this.#filePath
  }

  /** EventListener -- pass to bus.on(). */
  readonly listener: EventListener = (event: LifecycleEvent): void => {
    if (this.#closed) return

    // Lazily open the file on the first event (run_started)
    if (this.#fd === null) {
      this.#open(event)
    }

    const line = JSON.stringify(event, serializeError) + "\n"
    writeSync(this.#fd!, this.#encoder.encode(line))

    // Auto-close on run_finished
    if (event.type === "run_finished") {
      this.close()
    }
  }

  /** Flush and close the underlying file. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true

    if (this.#fd !== null) {
      try {
        closeSync(this.#fd)
      } catch {
        // Close errors are non-fatal.
      }
      this.#fd = null
    }
  }

  /** Open the log file, creating the directory if needed. */
  #open(firstEvent: LifecycleEvent): void {
    mkdirSync(this.#logDir, { recursive: true })

    const ts = formatTimestamp(firstEvent.timestamp)
    const runId = firstEvent.correlation.runId
    const filename = `${ts}_${runId}.ndjson`
    this.#filePath = `${this.#logDir}/${filename}`

    this.#fd = openSync(this.#filePath, "w")
  }
}
