import { test, expect } from "bun:test"
import { Spinner } from "../../src/output/spinner.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeWriter(
  isTTY = false,
  columns?: number,
): {
  writer: {
    isTerminal: () => boolean
    columns?: () => number | undefined
    writeSync(p: Uint8Array): number
  }
  output: () => string
} {
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  const writer = {
    isTerminal: () => isTTY,
    writeSync(p: Uint8Array): number {
      chunks.push(new Uint8Array(p))
      return p.length
    },
  } as {
    isTerminal: () => boolean
    columns?: () => number | undefined
    writeSync(p: Uint8Array): number
  }
  if (columns !== undefined) {
    writer.columns = () => columns
  }
  return {
    writer,
    output: () => decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c]))),
  }
}

// ---------------------------------------------------------------------------
// Non-TTY mode
// ---------------------------------------------------------------------------

test("Spinner — non-TTY start prints static message with newline", () => {
  const { writer, output } = fakeWriter(false)
  const spinner = new Spinner({ writer })

  spinner.start("apt  nginx")
  spinner.stop()

  const text = output()
  expect(text).toContain("…")
  expect(text).toContain("apt  nginx")
  expect(text).toContain("\n")
})

test("Spinner — non-TTY stop does not write escape codes", () => {
  const { writer, output } = fakeWriter(false)
  const spinner = new Spinner({ writer })

  spinner.start("test")
  spinner.stop()

  const text = output()
  expect(text.includes("\x1b")).toEqual(false)
})

// ---------------------------------------------------------------------------
// TTY mode
// ---------------------------------------------------------------------------

test("Spinner — TTY start renders a spinner frame", () => {
  const { writer, output } = fakeWriter(true)
  const spinner = new Spinner({ writer, intervalMs: 1000 })

  spinner.start("file  /etc/motd")
  spinner.stop()

  const text = output()
  // Should contain the message
  expect(text).toContain("file  /etc/motd")
  // Should contain ANSI escape (cursor control)
  expect(text).toContain("\x1b[2K")
})

test("Spinner — TTY stop clears the line", () => {
  const { writer, output } = fakeWriter(true)
  const spinner = new Spinner({ writer, intervalMs: 1000 })

  spinner.start("test")
  spinner.stop()

  const text = output()
  // The last write should be a clear-line escape
  expect(text).toContain("\x1b[1G\x1b[2K")
})

test("Spinner — stop is idempotent", () => {
  const { writer } = fakeWriter(true)
  const spinner = new Spinner({ writer, intervalMs: 1000 })

  spinner.start("test")
  spinner.stop()
  spinner.stop() // Should not throw
})

test("Spinner — truncates long TTY messages to one line width", () => {
  const { writer, output } = fakeWriter(true, 24)
  const spinner = new Spinner({ writer, intervalMs: 1000 })

  spinner.start("exec  this message is intentionally long")
  spinner.stop()

  const text = output()
  expect(text).toContain("…")
})
