import { test, expect } from "bun:test"
import type { HostRunSummary, RunSummary } from "../../src/core/types.ts"
import { JsonFormatter } from "../../src/output/formats.ts"
import { MinimalFormatter } from "../../src/output/formats.ts"
import type { LifecycleEvent } from "../../src/output/events.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubHostSummary(overrides: Partial<HostRunSummary> = {}): HostRunSummary {
  return {
    host: { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} },
    results: [
      { type: "apt", name: "nginx", status: "ok", durationMs: 150 },
      { type: "file", name: "/etc/motd", status: "changed", durationMs: 800 },
    ],
    ok: 1,
    changed: 1,
    failed: 0,
    durationMs: 950,
    ...overrides,
  }
}

function stubRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    hosts: [stubHostSummary()],
    hasFailures: false,
    durationMs: 1000,
    mode: "apply",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// JsonFormatter
// ---------------------------------------------------------------------------

test("JsonFormatter — outputs valid JSON", () => {
  const formatter = new JsonFormatter()
  const summary = stubRunSummary()

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.hasFailures).toEqual(false)
  expect(parsed.hosts.length).toEqual(1)
  expect(parsed.hosts[0].host.name).toEqual("web-1")
})

test("JsonFormatter — serializes Error objects as { message, name }", () => {
  const formatter = new JsonFormatter()
  const summary = stubRunSummary({
    hosts: [
      stubHostSummary({
        results: [
          {
            type: "exec",
            name: "fail-cmd",
            status: "failed",
            error: new Error("command failed"),
            durationMs: 100,
          },
        ],
        failed: 1,
      }),
    ],
    hasFailures: true,
  })

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.hosts[0].results[0].error.message).toEqual("command failed")
  expect(parsed.hosts[0].results[0].error.name).toEqual("Error")
})

test("JsonFormatter — includes timing information", () => {
  const formatter = new JsonFormatter()
  const summary = stubRunSummary({ durationMs: 5000 })

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.durationMs).toEqual(5000)
})

test("JsonFormatter — includes audit fields", () => {
  const formatter = new JsonFormatter()
  const summary = stubRunSummary({
    mode: "check",
    timestamp: "2026-02-08T12:00:00.000Z",
    recipe: { path: "file:///tmp/recipe.ts", checksum: "sha256:abc123" },
  })

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.mode).toEqual("check")
  expect(parsed.timestamp).toEqual("2026-02-08T12:00:00.000Z")
  expect(parsed.recipe.path).toEqual("file:///tmp/recipe.ts")
  expect(parsed.recipe.checksum).toEqual("sha256:abc123")
})

test("JsonFormatter — omits recipe when absent (inline recipe)", () => {
  const formatter = new JsonFormatter()
  const summary = stubRunSummary()

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.mode).toEqual("apply")
  expect(typeof parsed.timestamp).toEqual("string")
  expect(parsed.recipe).toEqual(undefined)
})

test("JsonFormatter — handles multiple hosts", () => {
  const formatter = new JsonFormatter()
  const summary = stubRunSummary({
    hosts: [
      stubHostSummary(),
      stubHostSummary({
        host: { name: "web-2", hostname: "10.0.1.11", user: "deploy", port: 22, vars: {} },
      }),
    ],
  })

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.hosts.length).toEqual(2)
  expect(parsed.hosts[0].host.name).toEqual("web-1")
  expect(parsed.hosts[1].host.name).toEqual("web-2")
})

test("JsonFormatter — redacts sensitive values in RunSummary when policy is set", () => {
  const formatter = new JsonFormatter({ redactionPolicy: { patterns: ["**.password"] } })
  const summary = stubRunSummary({
    hosts: [
      stubHostSummary({
        host: {
          name: "web-1",
          hostname: "10.0.1.10",
          user: "deploy",
          port: 22,
          vars: { password: "super-secret", env: "prod" },
        },
      }),
    ],
  })

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.hosts[0].host.vars.password).toEqual("[REDACTED]")
  expect(parsed.hosts[0].host.vars.env).toEqual("prod")
})

test("JsonFormatter — redacts sensitive values in events when policy is set", () => {
  const formatter = new JsonFormatter({ redactionPolicy: { patterns: ["**.password"] } })
  const event: LifecycleEvent = {
    type: "host_started",
    timestamp: "2026-01-01T00:00:00.000Z",
    correlation: { runId: "run-1", hostId: "host-1" },
    host: {
      name: "web-1",
      hostname: "10.0.1.10",
      user: "deploy",
      port: 22,
      vars: { password: "top-secret" },
    },
  }

  const output = formatter.formatEvent(event)
  const parsed = JSON.parse(output)

  expect(parsed.host.vars.password).toEqual("[REDACTED]")
})

test("JsonFormatter — preserves error serialization when redaction is enabled", () => {
  const formatter = new JsonFormatter({ redactionPolicy: { patterns: ["**.password"] } })
  const summary = stubRunSummary({
    hosts: [
      stubHostSummary({
        host: {
          name: "web-1",
          hostname: "10.0.1.10",
          user: "deploy",
          port: 22,
          vars: { password: "super-secret" },
        },
        results: [
          {
            type: "exec",
            name: "fail-cmd",
            status: "failed",
            error: new Error("command failed"),
            durationMs: 100,
          },
        ],
        ok: 0,
        changed: 0,
        failed: 1,
      }),
    ],
    hasFailures: true,
  })

  const output = formatter.format(summary)
  const parsed = JSON.parse(output)

  expect(parsed.hosts[0].host.vars.password).toEqual("[REDACTED]")
  expect(parsed.hosts[0].results[0].error.message).toEqual("command failed")
  expect(parsed.hosts[0].results[0].error.name).toEqual("Error")
})

// ---------------------------------------------------------------------------
// MinimalFormatter — apply mode
// ---------------------------------------------------------------------------

test("MinimalFormatter — formats host name and hostname", () => {
  const formatter = new MinimalFormatter("apply")
  const output = formatter.format(stubRunSummary())

  expect(output).toContain("web-1 (10.0.1.10)")
})

test("MinimalFormatter — formats each resource on one line", () => {
  const formatter = new MinimalFormatter("apply")
  const output = formatter.format(stubRunSummary())

  expect(output).toContain("ok apt nginx")
  expect(output).toContain("changed file /etc/motd")
})

test("MinimalFormatter — includes timing per resource", () => {
  const formatter = new MinimalFormatter("apply")
  const output = formatter.format(stubRunSummary())

  expect(output).toContain("150ms")
  expect(output).toContain("800ms")
})

test("MinimalFormatter — includes summary line with counts and timing", () => {
  const formatter = new MinimalFormatter("apply")
  const output = formatter.format(stubRunSummary())

  expect(output).toContain("ok 1")
  expect(output).toContain("changed 1")
  expect(output).toContain("failed 0")
})

// ---------------------------------------------------------------------------
// MinimalFormatter — check mode
// ---------------------------------------------------------------------------

test('MinimalFormatter — check mode shows "would change" for changed resources', () => {
  const formatter = new MinimalFormatter("check")
  const output = formatter.format(stubRunSummary())

  expect(output).toContain("would change file /etc/motd")
})

test('MinimalFormatter — check mode summary shows "would change" in counts', () => {
  const formatter = new MinimalFormatter("check")
  const output = formatter.format(stubRunSummary())

  expect(output).toContain("would change 1")
})

// ---------------------------------------------------------------------------
// MinimalFormatter — multiple hosts
// ---------------------------------------------------------------------------

test("MinimalFormatter — formats multiple hosts", () => {
  const formatter = new MinimalFormatter("apply")
  const summary = stubRunSummary({
    hosts: [
      stubHostSummary(),
      stubHostSummary({
        host: { name: "web-2", hostname: "10.0.1.11", user: "deploy", port: 22, vars: {} },
      }),
    ],
  })

  const output = formatter.format(summary)

  expect(output).toContain("web-1 (10.0.1.10)")
  expect(output).toContain("web-2 (10.0.1.11)")
})

// ---------------------------------------------------------------------------
// MinimalFormatter — empty results
// ---------------------------------------------------------------------------

test("MinimalFormatter — handles host with no results", () => {
  const formatter = new MinimalFormatter("apply")
  const summary = stubRunSummary({
    hosts: [stubHostSummary({ results: [], ok: 0, changed: 0, failed: 0 })],
  })

  const output = formatter.format(summary)

  expect(output).toContain("web-1")
  expect(output).toContain("ok 0")
})
