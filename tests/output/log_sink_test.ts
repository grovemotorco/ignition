import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventBus } from "../../src/output/events.ts"
import type { LifecycleEvent } from "../../src/output/events.ts"
import { FileLogSink, formatTimestamp } from "../../src/output/log_sink.ts"

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

test("formatTimestamp — replaces colons and strips fractional seconds", () => {
  expect(formatTimestamp("2025-06-15T10:32:01.123Z")).toEqual("2025-06-15T10-32-01Z")
})

test("formatTimestamp — handles timestamp without fractional seconds", () => {
  expect(formatTimestamp("2025-06-15T10:32:01Z")).toEqual("2025-06-15T10-32-01Z")
})

// ---------------------------------------------------------------------------
// FileLogSink — NDJSON output
// ---------------------------------------------------------------------------

test("FileLogSink — writes expected NDJSON lines for a sequence of events", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("test-run")
    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    bus.runStarted("apply", "fail-fast", 1)
    const hostId = bus.nextId()
    const host = { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
    bus.hostStarted(hostId, host)
    const resId = bus.nextId()
    bus.resourceStarted(hostId, resId, "apt", "nginx")
    bus.resourceFinished(hostId, resId, {
      type: "apt",
      name: "nginx",
      status: "changed",
      durationMs: 200,
    })
    bus.hostFinished(hostId, host, { ok: 0, changed: 1, failed: 0, durationMs: 500 })
    bus.runFinished(600, false, 1)

    // run_finished auto-closes the file
    const content = readFileSync(sink.filePath!, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines.length).toEqual(6)

    // Each line is valid JSON
    const types: string[] = []
    for (const line of lines) {
      const parsed = JSON.parse(line)
      types.push(parsed.type)
      expect(typeof parsed.timestamp).toEqual("string")
      expect(typeof parsed.correlation).toEqual("object")
    }

    expect(types).toEqual([
      "run_started",
      "host_started",
      "resource_started",
      "resource_finished",
      "host_finished",
      "run_finished",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — file naming
// ---------------------------------------------------------------------------

test("FileLogSink — creates log file with correct naming pattern", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("abc123def456")
    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    bus.runStarted("apply", "fail-fast", 0)
    bus.runFinished(0, false, 0)

    // File path should match <timestamp>_<runId>.ndjson
    expect(sink.filePath!).toMatch(/\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_abc123def456\.ndjson$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — directory creation
// ---------------------------------------------------------------------------

test("FileLogSink — creates log directory if it does not exist", () => {
  const parent = mkdtempSync(join(tmpdir(), "ign-"))
  const nested = `${parent}/sub/nested/logs`
  try {
    const bus = new EventBus("test-run")
    const sink = new FileLogSink({ logDir: nested })
    bus.on(sink.listener)

    bus.runStarted("apply", "fail-fast", 0)
    bus.runFinished(0, false, 0)

    // Verify the nested directory was created
    expect(statSync(nested).isDirectory()).toEqual(true)

    // Verify the file exists
    expect(statSync(sink.filePath!).isFile()).toEqual(true)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — close() is idempotent
// ---------------------------------------------------------------------------

test("FileLogSink — close() is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("test-run")
    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    bus.runStarted("apply", "fail-fast", 0)

    // Close multiple times — should not throw
    sink.close()
    sink.close()
    sink.close()

    // File should exist and contain valid NDJSON
    const content = readFileSync(sink.filePath!, "utf-8")
    const parsed = JSON.parse(content.trim())
    expect(parsed.type).toEqual("run_started")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — auto-closes on run_finished
// ---------------------------------------------------------------------------

test("FileLogSink — auto-closes on run_finished event", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("test-run")
    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    bus.runStarted("apply", "fail-fast", 0)
    bus.runFinished(100, false, 0)

    // After run_finished, further events should be silently ignored
    bus.emit({
      type: "run_started",
      timestamp: new Date().toISOString(),
      correlation: { runId: "other-run" },
      mode: "apply",
      errorMode: "fail-fast",
      hostCount: 0,
    })

    const content = readFileSync(sink.filePath!, "utf-8")
    const lines = content.trim().split("\n")
    // Only 2 lines: run_started + run_finished (the extra emit was ignored)
    expect(lines.length).toEqual(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — valid NDJSON (each line is standalone JSON)
// ---------------------------------------------------------------------------

test("FileLogSink — each line is a standalone JSON object", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("test-run")
    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    const host = { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
    bus.runStarted("check", "fail-at-end", 1)
    const hostId = bus.nextId()
    bus.hostStarted(hostId, host)
    bus.resourceOutput(hostId, bus.nextId(), "exec", "whoami", "stdout", "root\n")
    bus.resourceRetry(
      hostId,
      bus.nextId(),
      1,
      "file",
      "/etc/motd",
      "check",
      new Error("timeout"),
      150,
    )
    bus.hostFinished(hostId, host, { ok: 0, changed: 0, failed: 0, durationMs: 300 })
    bus.runFinished(400, false, 1)

    const content = readFileSync(sink.filePath!, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines.length).toEqual(6)

    // Every line must parse independently
    for (const line of lines) {
      const obj = JSON.parse(line)
      expect(typeof obj.type).toEqual("string")
      expect(typeof obj.timestamp).toEqual("string")
      expect(obj.correlation.runId).toEqual("test-run")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — correlation IDs match
// ---------------------------------------------------------------------------

test("FileLogSink — correlation IDs in log match bus output", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("corr-test")

    // Collect events in-memory for comparison
    const memEvents: LifecycleEvent[] = []
    bus.on((e) => memEvents.push(e))

    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    const host = { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
    bus.runStarted("apply", "fail-fast", 1)
    const hostId = bus.nextId()
    bus.hostStarted(hostId, host)
    const resId = bus.nextId()
    bus.resourceStarted(hostId, resId, "apt", "nginx")
    bus.resourceFinished(hostId, resId, {
      type: "apt",
      name: "nginx",
      status: "ok",
      durationMs: 50,
    })
    bus.hostFinished(hostId, host, { ok: 1, changed: 0, failed: 0, durationMs: 100 })
    bus.runFinished(150, false, 1)

    const content = readFileSync(sink.filePath!, "utf-8")
    const logEvents = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))

    // Same count
    expect(logEvents.length).toEqual(memEvents.length)

    // Correlation IDs match
    for (let i = 0; i < logEvents.length; i++) {
      expect(logEvents[i].correlation.runId).toEqual(memEvents[i].correlation.runId)
      expect(logEvents[i].correlation.hostId).toEqual(memEvents[i].correlation.hostId)
      expect(logEvents[i].correlation.resourceId).toEqual(memEvents[i].correlation.resourceId)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FileLogSink — all event types captured
// ---------------------------------------------------------------------------

test("FileLogSink — captures all lifecycle event types", () => {
  const dir = mkdtempSync(join(tmpdir(), "ign-"))
  try {
    const bus = new EventBus("all-types")
    const sink = new FileLogSink({ logDir: dir })
    bus.on(sink.listener)

    const host = { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
    const hostId = bus.nextId()
    const resId = bus.nextId()

    bus.runStarted("apply", "fail-fast", 1)
    bus.hostStarted(hostId, host)
    bus.resourceStarted(hostId, resId, "apt", "nginx")
    bus.resourceRetry(hostId, resId, 1, "apt", "nginx", "check", new Error("transient"), 50)
    bus.resourceOutput(hostId, resId, "apt", "nginx", "stdout", "installing...\n")
    bus.resourceFinished(hostId, resId, {
      type: "apt",
      name: "nginx",
      status: "changed",
      durationMs: 200,
    })
    bus.hostFinished(hostId, host, { ok: 0, changed: 1, failed: 0, durationMs: 300 })
    bus.runFinished(400, false, 1)

    const content = readFileSync(sink.filePath!, "utf-8")
    const types = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).type)

    expect(types.includes("run_started")).toEqual(true)
    expect(types.includes("run_finished")).toEqual(true)
    expect(types.includes("host_started")).toEqual(true)
    expect(types.includes("host_finished")).toEqual(true)
    expect(types.includes("resource_started")).toEqual(true)
    expect(types.includes("resource_finished")).toEqual(true)
    expect(types.includes("resource_retry")).toEqual(true)
    expect(types.includes("resource_output")).toEqual(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
