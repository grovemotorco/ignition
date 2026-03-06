/**
 * Resource execution spinner — animated in TTY, static otherwise.
 *
 * Provides visual feedback during resource execution. When writing to a TTY,
 * displays an animated spinner. Otherwise, outputs a static indicator.
 */

import { stderrWriter } from "./stderr.ts"

/** Spinner animation frames. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Default spinner interval in milliseconds. */
const INTERVAL_MS = 80
/** ANSI: move cursor to column 1, then clear entire line. */
const LINE_RESET = "\x1b[1G\x1b[2K"

/** Options for creating a Spinner. */
export type SpinnerOptions = {
  /** The writer to output to. Defaults to process.stderr. */
  writer?:
    | {
        isTerminal: () => boolean
        columns?: () => number | undefined
        writeSync(p: Uint8Array): number
      }
    | undefined
  /** Spinner interval in ms. Defaults to 80. */
  intervalMs?: number | undefined
}

/**
 * Resource execution spinner.
 *
 * - In TTY mode: animates through braille frames on a single line.
 * - In non-TTY mode: prints the message once with a static marker.
 */
export class Spinner {
  #writer: {
    isTerminal: () => boolean
    columns?: () => number | undefined
    writeSync(p: Uint8Array): number
  }
  #intervalMs: number
  #isTTY: boolean
  #encoder = new TextEncoder()
  #timerId: ReturnType<typeof setInterval> | undefined = undefined
  #frameIndex = 0
  #message = ""

  constructor(opts: SpinnerOptions = {}) {
    this.#writer = opts.writer ?? stderrWriter
    this.#intervalMs = opts.intervalMs ?? INTERVAL_MS
    this.#isTTY = this.#writer.isTerminal()
  }

  /** Start the spinner with a message. */
  start(message: string): void {
    this.#message = message
    this.#frameIndex = 0

    if (this.#isTTY) {
      this.#render()
      this.#timerId = setInterval(() => this.#render(), this.#intervalMs)
    } else {
      this.#write(`  …  ${message}\n`)
    }
  }

  /** Stop the spinner and clear the line (TTY only). */
  stop(): void {
    if (this.#timerId !== undefined) {
      clearInterval(this.#timerId)
      this.#timerId = undefined
    }
    if (this.#isTTY) {
      // Clear the spinner line
      this.#write(LINE_RESET)
    }
  }

  /** Pause the spinner animation and clear the line so other output can print. */
  pause(): void {
    if (this.#timerId !== undefined) {
      clearInterval(this.#timerId)
      this.#timerId = undefined
    }
    if (this.#isTTY) {
      this.#write(LINE_RESET)
    }
  }

  /** Resume the spinner animation after a pause. */
  resume(): void {
    if (this.#isTTY && this.#message) {
      this.#render()
      this.#timerId = setInterval(() => this.#render(), this.#intervalMs)
    }
  }

  /** Render a single frame (TTY only). */
  #render(): void {
    const frame = FRAMES[this.#frameIndex % FRAMES.length]
    const message = this.#truncateToTerminalWidth(this.#message)
    this.#write(`${LINE_RESET}  ${frame}  ${message}`)
    this.#frameIndex++
  }

  /** Keep spinner on a single terminal row to avoid visual line trails from wraps. */
  #truncateToTerminalWidth(message: string): string {
    const columns = this.#writer.columns?.()
    const totalColumns = typeof columns === "number" && columns > 0 ? columns : 80
    // Prefix width: "  <frame>  " ~= 5 cells.
    const maxMessageWidth = Math.max(12, totalColumns - 5)
    if (message.length <= maxMessageWidth) return message
    return `${message.slice(0, Math.max(1, maxMessageWidth - 1))}…`
  }

  #write(text: string): void {
    this.#writer.writeSync(this.#encoder.encode(text))
  }
}
