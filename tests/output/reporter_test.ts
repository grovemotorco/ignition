import { test, expect } from "bun:test"
import type { HostRunSummary, ResourceResult } from "../../src/core/types.ts"
import { formatDuration, PrettyReporter, QuietReporter } from "../../src/output/reporter.ts"

const ANSI_ESC = String.fromCharCode(27)
const ANSI_BRACKET = "["

const stripAnsiCode = (s: string): string => {
  let out = ""

  for (let i = 0; i < s.length; i++) {
    if (s[i] === ANSI_ESC && s[i + 1] === ANSI_BRACKET) {
      i += 2
      while (i < s.length) {
        const code = s.charCodeAt(i)
        // Final byte range for CSI sequences
        if (code >= 0x40 && code <= 0x7e) break
        i++
      }
      continue
    }
    out += s[i]
  }

  return out
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * A fake writer that captures output into a buffer.
 * `isTTY` controls whether the writer reports as a terminal.
 */
function fakeWriter(isTTY = false): {
  writer: { isTerminal: () => boolean; writeSync(p: Uint8Array): number }
  output: () => string
} {
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  return {
    writer: {
      isTerminal: () => isTTY,
      writeSync(p: Uint8Array): number {
        chunks.push(new Uint8Array(p))
        return p.length
      },
    },
    output: () => decoder.decode(new Uint8Array(chunks.flatMap((c) => [...c]))),
  }
}

function stubResult(overrides: Partial<ResourceResult> = {}): ResourceResult {
  return {
    type: "apt",
    name: "nginx",
    status: "ok",
    durationMs: 150,
    ...overrides,
  }
}

function stubHostSummary(overrides: Partial<HostRunSummary> = {}): HostRunSummary {
  return {
    host: { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} },
    results: [],
    ok: 1,
    changed: 2,
    failed: 0,
    durationMs: 4500,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// QuietReporter
// ---------------------------------------------------------------------------

test("QuietReporter — resourceStart is a no-op", () => {
  const reporter = new QuietReporter()
  // Should not throw
  reporter.resourceStart("apt", "nginx")
})

test("QuietReporter — resourceEnd is a no-op", () => {
  const reporter = new QuietReporter()
  // Should not throw
  reporter.resourceEnd(stubResult())
})

// ---------------------------------------------------------------------------
// PrettyReporter — resourceEnd
// ---------------------------------------------------------------------------

test("PrettyReporter — resourceEnd shows type, name, status, and timing", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceEnd(
    stubResult({ type: "apt", name: "nginx", status: "changed", durationMs: 3200 }),
  )

  const text = stripAnsiCode(output())
  expect(text).toContain("apt")
  expect(text).toContain("nginx")
  expect(text).toContain("changed")
  expect(text).toContain("3.2s")
})

test('PrettyReporter — ok status shows "ok"', () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceEnd(stubResult({ status: "ok" }))

  const text = stripAnsiCode(output())
  expect(text).toContain("ok")
  expect(text).toContain("●")
})

test('PrettyReporter — failed status shows "failed"', () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceEnd(stubResult({ status: "failed", durationMs: 100 }))

  const text = stripAnsiCode(output())
  expect(text).toContain("failed")
  expect(text).toContain("✗")
})

test("PrettyReporter — changed status shows checkmark", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceEnd(stubResult({ status: "changed" }))

  const text = stripAnsiCode(output())
  expect(text).toContain("✓")
})

// ---------------------------------------------------------------------------
// PrettyReporter — check mode
// ---------------------------------------------------------------------------

test('PrettyReporter — check mode shows "would change" for changed status', () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(stubResult({ status: "changed", durationMs: 500 }))

  const text = stripAnsiCode(output())
  expect(text).toContain("would change")
})

test('PrettyReporter — apply mode shows "changed" for changed status', () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceEnd(stubResult({ status: "changed", durationMs: 500 }))

  const text = stripAnsiCode(output())
  expect(text).toContain("changed")
})

// ---------------------------------------------------------------------------
// PrettyReporter — hostStart / hostEnd
// ---------------------------------------------------------------------------

test("PrettyReporter — hostStart shows host name and hostname", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.hostStart("web-1", "10.0.1.10")

  const text = stripAnsiCode(output())
  expect(text).toContain("◆")
  expect(text).toContain("web-1")
  expect(text).toContain("10.0.1.10")
})

test("PrettyReporter — hostEnd shows summary with ok/changed/failed counts and timing", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.hostEnd(stubHostSummary({ ok: 1, changed: 3, failed: 0, durationMs: 4500 }))

  const text = stripAnsiCode(output())
  expect(text).toContain("web-1")
  expect(text).toContain("ok 1")
  expect(text).toContain("changed 3")
  expect(text).toContain("failed 0")
  expect(text).toContain("4.5s")
})

test('PrettyReporter — hostEnd in check mode shows "would change"', () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.hostEnd(stubHostSummary({ changed: 2 }))

  const text = stripAnsiCode(output())
  expect(text).toContain("would change 2")
  expect(text).toContain("(check)")
})

// ---------------------------------------------------------------------------
// PrettyReporter — checkBanner
// ---------------------------------------------------------------------------

test("PrettyReporter — checkBanner shows check mode message", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.checkBanner()

  const text = stripAnsiCode(output())
  expect(text).toContain("CHECK MODE")
  expect(text).toContain("no changes will be applied")
})

// ---------------------------------------------------------------------------
// PrettyReporter — Reporter interface compliance
// ---------------------------------------------------------------------------

test("PrettyReporter — implements Reporter interface (resourceStart + resourceEnd)", () => {
  const { writer } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  // These are the two methods required by the Reporter interface
  reporter.resourceStart("file", "/etc/motd")
  reporter.resourceEnd(stubResult({ type: "file", name: "/etc/motd", status: "ok" }))
})

test("PrettyReporter — keeps stdout/stderr partial buffers isolated", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceStart("exec", "mixed-streams")
  reporter.resourceOutput("exec", "mixed-streams", "stdout", "out-")
  reporter.resourceOutput("exec", "mixed-streams", "stderr", "err-")
  reporter.resourceOutput("exec", "mixed-streams", "stdout", "line\n")
  reporter.resourceOutput("exec", "mixed-streams", "stderr", "line\n")
  reporter.resourceEnd(stubResult({ type: "exec", name: "mixed-streams", status: "ok" }))

  const text = stripAnsiCode(output())
  expect(text).toContain("│ out-line")
  expect(text).toContain("│ err-line")
})

test("PrettyReporter — flushes unterminated per-stream output on resourceEnd", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceStart("exec", "unterminated")
  reporter.resourceOutput("exec", "unterminated", "stdout", "tail-stdout")
  reporter.resourceOutput("exec", "unterminated", "stderr", "tail-stderr")
  reporter.resourceEnd(stubResult({ type: "exec", name: "unterminated", status: "ok" }))

  const text = stripAnsiCode(output())
  expect(text).toContain("│ tail-stdout")
  expect(text).toContain("│ tail-stderr")
})

test("PrettyReporter — keeps spinner paused during streaming output", () => {
  const { writer, output } = fakeWriter(true)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceStart("exec", "streamy")
  reporter.resourceOutput("exec", "streamy", "stdout", "first\n")
  reporter.resourceOutput("exec", "streamy", "stdout", "second\n")
  reporter.resourceEnd(stubResult({ type: "exec", name: "streamy", status: "ok" }))

  const raw = output()
  const text = stripAnsiCode(raw)
  expect(text).toContain("│ first")
  expect(text).toContain("│ second")
  // Start renders ⠋ once; no immediate resume renders should emit ⠙/⠹ frames.
  expect(raw.includes("⠙  exec  streamy")).toEqual(false)
  expect(raw.includes("⠹  exec  streamy")).toEqual(false)
})

test("PrettyReporter — normalizes carriage-return chunks into readable lines", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceStart("exec", "cr")
  reporter.resourceOutput("exec", "cr", "stdout", "hello\rworld\r\ntail\rline")
  reporter.resourceEnd(stubResult({ type: "exec", name: "cr", status: "ok" }))

  const text = stripAnsiCode(output())
  expect(text).toContain("│ hello")
  expect(text).toContain("│ world")
  expect(text).toContain("│ tail")
  expect(text).toContain("│ line")
})

test("PrettyReporter — strips terminal control sequences from streamed output", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceStart("exec", "ansi")
  reporter.resourceOutput("exec", "ansi", "stdout", "\x1b[31mred\x1b[0m\nok\x1b[?25l\n")
  reporter.resourceEnd(stubResult({ type: "exec", name: "ansi", status: "ok" }))

  const raw = output()
  const text = stripAnsiCode(raw)
  expect(text).toContain("│ red")
  expect(text).toContain("│ ok")
  expect(text.includes("\x1b")).toEqual(false)
})

// ---------------------------------------------------------------------------
// PrettyReporter — diff rendering
// ---------------------------------------------------------------------------

test("PrettyReporter — renders field diffs for changed resources", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(
    stubResult({
      type: "file",
      name: "/etc/nginx/nginx.conf",
      status: "changed",
      durationMs: 150,
      current: { exists: true, mode: "644", owner: "root" },
      desired: { state: "present", mode: "755", owner: "deploy" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).toContain("- mode: 644")
  expect(text).toContain("+ mode: 755")
  expect(text).toContain("- owner: root")
  expect(text).toContain("+ owner: deploy")
})

test("PrettyReporter — renders content diffs for file resources", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(
    stubResult({
      type: "file",
      name: "/etc/motd",
      status: "changed",
      durationMs: 100,
      current: { exists: true, content: "hello\nworld" },
      desired: { state: "present", content: "hello\nuniverse" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).toContain("- world")
  expect(text).toContain("+ universe")
})

test("PrettyReporter — does not render diffs for ok resources", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(
    stubResult({
      status: "ok",
      current: { mode: "644" },
      desired: { state: "present", mode: "644" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).not.toContain("- ")
  expect(text).not.toContain("+ ")
})

test("PrettyReporter — does not render diffs when current/desired are undefined", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(stubResult({ status: "changed", durationMs: 100 }))

  const text = stripAnsiCode(output())
  expect(text).toContain("would change")
  expect(text).not.toContain("- ")
  expect(text).not.toContain("+ ")
})

test("PrettyReporter — does not render diffs for failed resources", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "apply" })

  reporter.resourceEnd(
    stubResult({
      status: "failed",
      current: { mode: "644" },
      desired: { state: "present", mode: "755" },
      error: new Error("permission denied"),
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).not.toContain("- mode")
  expect(text).not.toContain("+ mode")
})

test("PrettyReporter — check mode label shows alongside diff output", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(
    stubResult({
      status: "changed",
      durationMs: 500,
      current: { mode: "644" },
      desired: { state: "present", mode: "755" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).toContain("would change")
  expect(text).toContain("- mode: 644")
  expect(text).toContain("+ mode: 755")
})

// ---------------------------------------------------------------------------
// PrettyReporter — redaction in diffs
// ---------------------------------------------------------------------------

test("PrettyReporter — redacts sensitive values in diffs", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({
    writer,
    mode: "check",
    redactionPolicy: { patterns: ["**.password"] },
  })

  reporter.resourceEnd(
    stubResult({
      type: "file",
      name: "/etc/app.conf",
      status: "changed",
      durationMs: 100,
      current: { password: "old-secret", mode: "644" },
      desired: { password: "new-secret", mode: "755" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).not.toContain("old-secret")
  expect(text).not.toContain("new-secret")
  expect(text).toContain("- mode: 644")
  expect(text).toContain("+ mode: 755")
})

test("PrettyReporter — redaction applies to both current and desired sides", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({
    writer,
    mode: "check",
    redactionPolicy: { patterns: ["**.secret"] },
  })

  reporter.resourceEnd(
    stubResult({
      status: "changed",
      durationMs: 100,
      current: { secret: "alpha" },
      desired: { secret: "beta" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).not.toContain("alpha")
  expect(text).not.toContain("beta")
})

test("PrettyReporter — non-matching fields displayed normally alongside redacted", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({
    writer,
    mode: "check",
    redactionPolicy: { patterns: ["**.password"] },
  })

  reporter.resourceEnd(
    stubResult({
      status: "changed",
      durationMs: 100,
      current: { password: "secret", port: "80" },
      desired: { password: "new-secret", port: "443" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).toContain("- port: 80")
  expect(text).toContain("+ port: 443")
  expect(text).not.toContain("secret")
})

test("PrettyReporter — no redaction policy renders all values", () => {
  const { writer, output } = fakeWriter(false)
  const reporter = new PrettyReporter({ writer, mode: "check" })

  reporter.resourceEnd(
    stubResult({
      status: "changed",
      durationMs: 100,
      current: { password: "visible" },
      desired: { password: "also-visible" },
    }),
  )

  const text = stripAnsiCode(output())
  expect(text).toContain("- password: visible")
  expect(text).toContain("+ password: also-visible")
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

test("formatDuration — sub-second shows milliseconds", () => {
  expect(formatDuration(150)).toEqual("150ms")
  expect(formatDuration(0)).toEqual("0ms")
  expect(formatDuration(999)).toEqual("999ms")
})

test("formatDuration — 1 second or more shows seconds with one decimal", () => {
  expect(formatDuration(1000)).toEqual("1.0s")
  expect(formatDuration(3200)).toEqual("3.2s")
  expect(formatDuration(4500)).toEqual("4.5s")
  expect(formatDuration(10000)).toEqual("10.0s")
})
