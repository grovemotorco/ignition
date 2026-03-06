import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runRecipe } from "../../src/core/runner.ts"
import { SSHConnectionError } from "../../src/core/errors.ts"
import type {
  ExecutionContext,
  HostContext,
  HostFacts,
  Reporter,
  ResourceResult,
} from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { ExecResult, SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubHost(name = "web-1", hostname = "10.0.1.10"): HostContext {
  return { name, hostname, user: "deploy", port: 22, vars: {} }
}

function stubConnection(
  overrides: Partial<{
    ping: () => Promise<boolean>
    close: () => Promise<void>
  }> = {},
): SSHConnection & { closeCalls: number } {
  const config: SSHConnectionConfig = {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    hostKeyPolicy: "strict",
  }
  const conn = {
    config,
    capabilities() {
      return ALL_TRANSPORT_CAPABILITIES
    },
    closeCalls: 0,
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: overrides.ping ?? (() => Promise.resolve(true)),
    close: () => {
      conn.closeCalls++
      return (overrides.close ?? (() => Promise.resolve()))()
    },
  }
  return conn
}

function noopReporter(): Reporter {
  return {
    resourceStart: () => {},
    resourceEnd: () => {},
  }
}

type ReporterCalls = {
  starts: Array<{ type: string; name: string }>
  ends: ResourceResult[]
}

function trackingReporter(): { reporter: Reporter; calls: ReporterCalls } {
  const calls: ReporterCalls = { starts: [], ends: [] }
  return {
    reporter: {
      resourceStart(type: string, name: string) {
        calls.starts.push({ type, name })
      },
      resourceEnd(result: ResourceResult) {
        calls.ends.push(result)
      },
    },
    calls,
  }
}

/** A no-op recipe that does nothing. */
const emptyRecipe = (_ctx: ExecutionContext): Promise<void> => Promise.resolve()

/** A recipe that records host names for verification. */
function recordingRecipe(log: string[]): (ctx: ExecutionContext) => Promise<void> {
  return (ctx: ExecutionContext): Promise<void> => {
    log.push(ctx.host.name)
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// Basic execution
// ---------------------------------------------------------------------------

test("runs recipe against a single host and produces RunSummary", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hosts[0].host.name).toEqual("web-1")
  expect(result.hosts[0].ok).toEqual(0)
  expect(result.hosts[0].changed).toEqual(0)
  expect(result.hosts[0].failed).toEqual(0)
  expect(result.hasFailures).toEqual(false)
  expect(result.mode).toEqual("apply")
  expect(typeof result.timestamp).toEqual("string")
  expect(result.recipe).toEqual(undefined) // inline recipe has no audit info
})

test("runs recipe against multiple hosts sequentially", async () => {
  const log: string[] = []
  const recipe = recordingRecipe(log)

  const result = await runRecipe({
    recipe,
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("web-2", "10.0.1.2"), connection: stubConnection() },
      { host: stubHost("web-3", "10.0.1.3"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(3)
  expect(log).toEqual(["web-1", "web-2", "web-3"])
})

// ---------------------------------------------------------------------------
// Context creation
// ---------------------------------------------------------------------------

test("creates ExecutionContext with correct mode for each host", async () => {
  let capturedMode: string | undefined

  const result = await runRecipe({
    recipe: (ctx) => {
      capturedMode = ctx.mode
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "check",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(capturedMode).toEqual("check")
  expect(result.hosts.length).toEqual(1)
})

test("passes vars to ExecutionContext", async () => {
  let capturedVars: Record<string, unknown> | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedVars = ctx.vars
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    vars: { env: "prod", replicas: 3 },
  })

  expect(capturedVars).toEqual({ env: "prod", replicas: 3 })
})

test("inventory host vars flow into ctx.vars", async () => {
  let capturedVars: Record<string, unknown> | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedVars = { ...ctx.vars }
      return Promise.resolve()
    },
    hosts: [
      {
        host: { ...stubHost(), vars: { env: "production", role: "web" } },
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(capturedVars).toEqual({ env: "production", role: "web" })
})

test("CLI vars override inventory host vars", async () => {
  let capturedVars: Record<string, unknown> | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedVars = { ...ctx.vars }
      return Promise.resolve()
    },
    hosts: [
      {
        host: { ...stubHost(), vars: { env: "production", role: "web" } },
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    vars: { env: "staging" },
  })

  expect(capturedVars).toEqual({ env: "staging", role: "web" })
})

test("passes reporter to ExecutionContext", async () => {
  const { reporter, calls } = trackingReporter()
  let capturedReporter: Reporter | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedReporter = ctx.reporter
      // Simulate a resource reporting
      ctx.reporter.resourceStart("test", "foo")
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter,
  })

  expect(capturedReporter).toEqual(reporter)
  expect(calls.starts.length).toEqual(1)
  expect(calls.starts[0]).toEqual({ type: "test", name: "foo" })
})

// ---------------------------------------------------------------------------
// Host facts
// ---------------------------------------------------------------------------

test("probes host facts and passes them into ExecutionContext", async () => {
  let capturedFacts: HostFacts | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedFacts = ctx.facts
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  // stubConnection().exec returns empty stdout for all commands, so facts
  // should be the graceful-default values (distro: 'unknown', etc.)
  expect(capturedFacts?.distro).toEqual("unknown")
  expect(capturedFacts?.distroId).toEqual("")
  expect(capturedFacts?.distroVersion).toEqual("")
  expect(capturedFacts?.pkgManager).toEqual(null)
  expect(capturedFacts?.initSystem).toEqual(null)
  expect(capturedFacts?.arch).toEqual("")
})

test("populates facts from probed Ubuntu host", async () => {
  let capturedFacts: HostFacts | undefined

  const ubuntuExec = (cmd: string): Promise<ExecResult> => {
    if (cmd.includes("os-release")) {
      return Promise.resolve({
        exitCode: 0,
        stdout: 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="22.04"\n',
        stderr: "",
      })
    }
    if (cmd.includes("apt-get")) {
      return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/apt-get\nx86_64\n", stderr: "" })
    }
    if (cmd.includes("systemctl")) {
      return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/systemctl\n", stderr: "" })
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
  }

  const config: SSHConnectionConfig = {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    hostKeyPolicy: "strict",
  }
  const conn: SSHConnection = {
    config,
    capabilities: () => ALL_TRANSPORT_CAPABILITIES,
    exec: ubuntuExec,
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }

  await runRecipe({
    recipe: (ctx) => {
      capturedFacts = ctx.facts
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: conn }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(capturedFacts?.distro).toEqual("debian")
  expect(capturedFacts?.distroId).toEqual("ubuntu")
  expect(capturedFacts?.distroVersion).toEqual("22.04")
  expect(capturedFacts?.pkgManager).toEqual("apt")
  expect(capturedFacts?.initSystem).toEqual("systemd")
  expect(capturedFacts?.arch).toEqual("x86_64")
})

// ---------------------------------------------------------------------------
// Connection failure handling
// ---------------------------------------------------------------------------

test("handles ping returning false — records failed host", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [
      {
        host: stubHost(),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hosts[0].ok).toEqual(0)
  expect(result.hosts[0].results[0].status).toEqual("failed")
  expect(result.hosts[0].results[0].error instanceof SSHConnectionError).toEqual(true)
  expect(result.hasFailures).toEqual(true)
})

test("handles ping throwing — records failed host", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [
      {
        host: stubHost(),
        connection: stubConnection({
          ping: () => Promise.reject(new Error("network timeout")),
        }),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hosts[0].results[0].status).toEqual("failed")
  expect(result.hosts[0].results[0].error instanceof SSHConnectionError).toEqual(true)
  expect(result.hasFailures).toEqual(true)
})

test("continues to next host after connection failure (fail-at-end)", async () => {
  const log: string[] = []

  const result = await runRecipe({
    recipe: recordingRecipe(log),
    hosts: [
      {
        host: stubHost("fail-host", "10.0.1.1"),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
      {
        host: stubHost("ok-host", "10.0.1.2"),
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(2)
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hosts[1].failed).toEqual(0)
  // Recipe only ran on the reachable host
  expect(log).toEqual(["ok-host"])
  expect(result.hasFailures).toEqual(true)
})

// ---------------------------------------------------------------------------
// Recipe errors
// ---------------------------------------------------------------------------

test("recipe throwing does not prevent RunSummary", async () => {
  const result = await runRecipe({
    recipe: (_ctx) => {
      throw new Error("recipe explosion")
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hosts[0].results.length).toEqual(1)
  expect(result.hosts[0].results[0].type).toEqual("recipe")
  expect(result.hosts[0].results[0].status).toEqual("failed")
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hasFailures).toEqual(true)
})

test("recipe throw on one host does not prevent next host", async () => {
  const log: string[] = []
  let callCount = 0

  const result = await runRecipe({
    recipe: (ctx) => {
      callCount++
      if (callCount === 1) throw new Error("fail first")
      log.push(ctx.host.name)
      return Promise.resolve()
    },
    hosts: [
      { host: stubHost("host-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("host-2", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(2)
  expect(log).toEqual(["host-2"])
})

// ---------------------------------------------------------------------------
// Apply vs check mode
// ---------------------------------------------------------------------------

test('check mode — ctx.mode is "check"', async () => {
  let capturedMode: string | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedMode = ctx.mode
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "check",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(capturedMode).toEqual("check")
})

test('apply mode — ctx.mode is "apply"', async () => {
  let capturedMode: string | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedMode = ctx.mode
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(capturedMode).toEqual("apply")
})

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

test("records positive durationMs for run and per-host", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.durationMs).toBeGreaterThan(-1)
  expect(result.hosts[0].durationMs).toBeGreaterThan(-1)
})

// ---------------------------------------------------------------------------
// RunSummary aggregation
// ---------------------------------------------------------------------------

test("hasFailures is false when all hosts succeed", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [
      { host: stubHost("web-1"), connection: stubConnection() },
      { host: stubHost("web-2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hasFailures).toEqual(false)
})

test("hasFailures is true when any host has failures", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [
      { host: stubHost("ok-host"), connection: stubConnection() },
      {
        host: stubHost("fail-host"),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hasFailures).toEqual(true)
})

// ---------------------------------------------------------------------------
// Recipe loading — string path (error case)
// ---------------------------------------------------------------------------

test("throws RecipeLoadError for non-existent recipe path", async () => {
  let threw = false
  try {
    await runRecipe({
      recipe: "/nonexistent/recipe.ts",
      hosts: [{ host: stubHost(), connection: stubConnection() }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: noopReporter(),
    })
  } catch {
    threw = true
  }
  expect(threw).toEqual(true)
})

test("applies recipe tag filter for string recipe modules", async () => {
  const fileDir = mkdtempSync(join(tmpdir(), "ign-"))
  const file = join(fileDir, "recipe.ts")
  const recipe = [
    `export const meta = { tags: ['web'] as const }`,
    `export default async function (ctx: { results: Array<unknown> }) {`,
    `  ctx.results.push({ type: 'tag-test', name: 'ran', status: 'changed', durationMs: 0 })`,
    `}`,
  ].join("\n")
  writeFileSync(file, recipe)

  try {
    const recipeUrl = new URL(`file://${file}`).href

    const skipped = await runRecipe({
      recipe: recipeUrl,
      hosts: [{ host: stubHost(), connection: stubConnection() }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: noopReporter(),
      tags: ["db"],
    })
    expect(skipped.hosts[0].results.length).toEqual(0)

    const matched = await runRecipe({
      recipe: recipeUrl,
      hosts: [{ host: stubHost(), connection: stubConnection() }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: noopReporter(),
      tags: ["web"],
    })
    expect(matched.hosts[0].results.length).toEqual(1)
    expect(matched.hosts[0].results[0].type).toEqual("tag-test")
  } finally {
    rmSync(fileDir, { recursive: true, force: true })
  }
})

test("computes recipe checksum for file URLs with spaces in path", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ign-"))
  const spacedDir = `${tmpDir}/folder with spaces`
  const recipePath = `${spacedDir}/recipe with spaces.ts`

  mkdirSync(spacedDir, { recursive: true })

  const recipeSource = `export default async function () {}`
  writeFileSync(recipePath, recipeSource)

  try {
    const recipeUrl = new URL(`file://${recipePath}`).href
    const bytes = new TextEncoder().encode(recipeSource)
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    const expected = `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`

    const result = await runRecipe({
      recipe: recipeUrl,
      hosts: [{ host: stubHost(), connection: stubConnection() }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: noopReporter(),
    })

    expect(result.recipe?.path).toEqual(recipeUrl)
    expect(result.recipe?.checksum).toEqual(expected)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("passes global resource policy into ExecutionContext", async () => {
  let captured: ExecutionContext["resourcePolicy"] | undefined

  await runRecipe({
    recipe: (ctx) => {
      captured = ctx.resourcePolicy
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    resourcePolicy: { timeoutMs: 123, retries: 4, retryDelayMs: 9 },
  })

  expect(captured).toEqual({ timeoutMs: 123, retries: 4, retryDelayMs: 9 })
})

// ---------------------------------------------------------------------------
// Empty hosts list
// ---------------------------------------------------------------------------

test("returns empty RunSummary for empty hosts list", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(0)
  expect(result.hasFailures).toEqual(false)
  expect(result.durationMs).toBeGreaterThan(-1)
  expect(result.mode).toEqual("apply")
  expect(typeof result.timestamp).toEqual("string")
})

// ---------------------------------------------------------------------------
// Session lifecycle — connection close
// ---------------------------------------------------------------------------

test("closes connection after successful recipe execution", async () => {
  const conn = stubConnection()

  await runRecipe({
    recipe: emptyRecipe,
    hosts: [{ host: stubHost(), connection: conn }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(conn.closeCalls).toEqual(1)
})

test("closes connection after recipe throws", async () => {
  const conn = stubConnection()

  await runRecipe({
    recipe: () => {
      throw new Error("boom")
    },
    hosts: [{ host: stubHost(), connection: conn }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(conn.closeCalls).toEqual(1)
})

test("closes connection after ping returns false", async () => {
  const conn = stubConnection({ ping: () => Promise.resolve(false) })

  await runRecipe({
    recipe: emptyRecipe,
    hosts: [{ host: stubHost(), connection: conn }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(conn.closeCalls).toEqual(1)
})

test("closes connection after ping throws", async () => {
  const conn = stubConnection({ ping: () => Promise.reject(new Error("timeout")) })

  await runRecipe({
    recipe: emptyRecipe,
    hosts: [{ host: stubHost(), connection: conn }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(conn.closeCalls).toEqual(1)
})

test("closes all connections when running multiple hosts", async () => {
  const conn1 = stubConnection()
  const conn2 = stubConnection()
  const conn3 = stubConnection()

  await runRecipe({
    recipe: emptyRecipe,
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: conn1 },
      { host: stubHost("web-2", "10.0.1.2"), connection: conn2 },
      { host: stubHost("web-3", "10.0.1.3"), connection: conn3 },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(conn1.closeCalls).toEqual(1)
  expect(conn2.closeCalls).toEqual(1)
  expect(conn3.closeCalls).toEqual(1)
})

test("close error does not prevent next host", async () => {
  const conn1 = stubConnection({ close: () => Promise.reject(new Error("close failed")) })
  const conn2 = stubConnection()
  const log: string[] = []

  await runRecipe({
    recipe: recordingRecipe(log),
    hosts: [
      { host: stubHost("host-1", "10.0.1.1"), connection: conn1 },
      { host: stubHost("host-2", "10.0.1.2"), connection: conn2 },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(log).toEqual(["host-1", "host-2"])
  expect(conn2.closeCalls).toEqual(1)
})

// ---------------------------------------------------------------------------
// Concurrency — bounded parallelism
// ---------------------------------------------------------------------------

test("parallelism=1 runs hosts sequentially", async () => {
  const log: string[] = []
  const recipe = recordingRecipe(log)

  const result = await runRecipe({
    recipe,
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("web-2", "10.0.1.2"), connection: stubConnection() },
      { host: stubHost("web-3", "10.0.1.3"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
  })

  expect(result.hosts.length).toEqual(3)
  expect(log).toEqual(["web-1", "web-2", "web-3"])
})

test("parallelism bounds concurrent execution", async () => {
  let maxConcurrent = 0
  let activeConcurrent = 0
  const resolvers: Array<() => void> = []

  // Recipe that tracks concurrent active count
  const recipe = (_ctx: ExecutionContext): Promise<void> => {
    activeConcurrent++
    if (activeConcurrent > maxConcurrent) {
      maxConcurrent = activeConcurrent
    }
    return new Promise<void>((resolve) => {
      resolvers.push(() => {
        activeConcurrent--
        resolve()
      })
    })
  }

  const hosts = Array.from({ length: 6 }, (_, i) => ({
    host: stubHost(`host-${i}`, `10.0.1.${i}`),
    connection: stubConnection(),
  }))

  const promise = runRecipe({
    recipe,
    hosts,
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 2 },
  })

  // Wait for the first batch of 2 to start
  await new Promise((r) => setTimeout(r, 10))
  expect(activeConcurrent).toEqual(2)
  expect(maxConcurrent).toEqual(2)

  // Resolve hosts one at a time and verify concurrency stays bounded
  while (resolvers.length > 0) {
    const r = resolvers.shift()!
    r()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const result = await promise
  expect(result.hosts.length).toEqual(6)
  expect(maxConcurrent).toEqual(2)
})

test("results are in input order regardless of completion order", async () => {
  const resolvers: Array<() => void> = []

  // Hosts complete in reverse order
  const recipe = (_ctx: ExecutionContext): Promise<void> => {
    return new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })
  }

  const hosts = [
    { host: stubHost("host-a", "10.0.1.1"), connection: stubConnection() },
    { host: stubHost("host-b", "10.0.1.2"), connection: stubConnection() },
    { host: stubHost("host-c", "10.0.1.3"), connection: stubConnection() },
  ]

  const promise = runRecipe({
    recipe,
    hosts,
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 3 },
  })

  // Wait for all to start
  await new Promise((r) => setTimeout(r, 10))

  // Resolve in reverse order: host-c, host-b, host-a
  resolvers[2]()
  await new Promise((r) => setTimeout(r, 5))
  resolvers[1]()
  await new Promise((r) => setTimeout(r, 5))
  resolvers[0]()

  const result = await promise

  // Results should be in input order
  expect(result.hosts.length).toEqual(3)
  expect(result.hosts[0].host.name).toEqual("host-a")
  expect(result.hosts[1].host.name).toEqual("host-b")
  expect(result.hosts[2].host.name).toEqual("host-c")
})

test("per-host resource execution remains sequential", async () => {
  const executionLog: string[] = []

  const recipe = async (ctx: ExecutionContext): Promise<void> => {
    executionLog.push(`${ctx.host.name}:start`)
    await new Promise((r) => setTimeout(r, 10))
    executionLog.push(`${ctx.host.name}:end`)
  }

  await runRecipe({
    recipe,
    hosts: [
      { host: stubHost("host-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("host-2", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
  })

  // With parallelism=1, host-1 should fully complete before host-2 starts
  expect(executionLog).toEqual(["host-1:start", "host-1:end", "host-2:start", "host-2:end"])
})

// ---------------------------------------------------------------------------
// Concurrency — fail-fast cancellation
// ---------------------------------------------------------------------------

test("fail-fast cancels queued hosts after connection failure", async () => {
  const log: string[] = []

  const result = await runRecipe({
    recipe: recordingRecipe(log),
    hosts: [
      {
        host: stubHost("fail-host", "10.0.1.1"),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
      {
        host: stubHost("queued-host", "10.0.1.2"),
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
  })

  expect(result.hosts.length).toEqual(2)
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hosts[1].cancelled).toEqual(true)
  expect(log).toEqual([])
  expect(result.hasFailures).toEqual(true)
})

test("fail-fast cancels active sibling hosts on terminal failure", async () => {
  const resolvers: Array<() => void> = []

  const recipe = (ctx: ExecutionContext): Promise<void> => {
    if (ctx.host.name === "fail-host") {
      // Simulate a resource failure by pushing a failed result and throwing
      ctx.results.push({
        type: "exec",
        name: "test-cmd",
        status: "failed",
        error: new Error("command failed"),
        durationMs: 1,
      })
      throw new Error("fail-fast propagation")
    }
    return new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })
  }

  const hosts = [
    { host: stubHost("slow-host", "10.0.1.1"), connection: stubConnection() },
    { host: stubHost("fail-host", "10.0.1.2"), connection: stubConnection() },
    { host: stubHost("queued-host", "10.0.1.3"), connection: stubConnection() },
  ]

  const promise = runRecipe({
    recipe,
    hosts,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 2 },
  })

  // Wait for fail-host to complete and trigger cancellation
  await new Promise((r) => setTimeout(r, 20))

  // Resolve slow-host so run completes
  if (resolvers.length > 0) {
    resolvers[0]()
  }

  const result = await promise

  expect(result.hosts.length).toEqual(3)
  // fail-host should have failed
  expect(result.hosts[1].failed).toEqual(1)
  // queued-host should be cancelled
  expect(result.hosts[2].cancelled).toEqual(true)
  expect(result.hasFailures).toEqual(true)
})

// ---------------------------------------------------------------------------
// Concurrency — fail-at-end continues all hosts
// ---------------------------------------------------------------------------

test("fail-at-end continues all hosts despite failures", async () => {
  const log: string[] = []

  const result = await runRecipe({
    recipe: (ctx: ExecutionContext): Promise<void> => {
      log.push(ctx.host.name)
      return Promise.resolve()
    },
    hosts: [
      {
        host: stubHost("fail-host", "10.0.1.1"),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
      {
        host: stubHost("ok-host-1", "10.0.1.2"),
        connection: stubConnection(),
      },
      {
        host: stubHost("ok-host-2", "10.0.1.3"),
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
  })

  expect(result.hosts.length).toEqual(3)
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hosts[1].failed).toEqual(0)
  expect(result.hosts[2].failed).toEqual(0)
  expect(log).toEqual(["ok-host-1", "ok-host-2"])
  expect(result.hasFailures).toEqual(true)
})

// ---------------------------------------------------------------------------
// Concurrency — ignore mode continues all hosts
// ---------------------------------------------------------------------------

test("ignore mode continues all hosts and marks failures", async () => {
  const log: string[] = []

  const result = await runRecipe({
    recipe: (ctx: ExecutionContext): Promise<void> => {
      log.push(ctx.host.name)
      return Promise.resolve()
    },
    hosts: [
      {
        host: stubHost("fail-host", "10.0.1.1"),
        connection: stubConnection({ ping: () => Promise.resolve(false) }),
      },
      {
        host: stubHost("ok-host-1", "10.0.1.2"),
        connection: stubConnection(),
      },
    ],
    mode: "apply",
    errorMode: "ignore",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
  })

  expect(result.hosts.length).toEqual(2)
  expect(result.hosts[0].failed).toEqual(1)
  expect(result.hosts[1].failed).toEqual(0)
  expect(log).toEqual(["ok-host-1"])
  expect(result.hasFailures).toEqual(true)
})

// ---------------------------------------------------------------------------
// Concurrency — host-level timeout
// ---------------------------------------------------------------------------

test("host timeout cancels slow host", async () => {
  const recipe = (_ctx: ExecutionContext): Promise<void> => {
    // Recipe that never resolves
    return new Promise(() => {})
  }

  const result = await runRecipe({
    recipe,
    hosts: [{ host: stubHost("slow-host", "10.0.1.1"), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { hostTimeout: 50 },
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hosts[0].cancelled).toEqual(true)
  expect(result.hosts[0].failed).toEqual(1)
  // Should have a timeout result
  const timeoutResult = result.hosts[0].results.find((r) => r.type === "timeout")
  expect(timeoutResult?.status).toEqual("failed")
  expect(result.hasFailures).toEqual(true)
})

test("host timeout does not affect fast hosts", async () => {
  const result = await runRecipe({
    recipe: emptyRecipe,
    hosts: [{ host: stubHost("fast-host", "10.0.1.1"), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { hostTimeout: 5000 },
  })

  expect(result.hosts.length).toEqual(1)
  expect(result.hosts[0].failed).toEqual(0)
  expect(result.hosts[0].cancelled).toEqual(undefined)
})

// ---------------------------------------------------------------------------
// Concurrency — run-level cancellation via AbortSignal
// ---------------------------------------------------------------------------

test("external AbortSignal cancels the run", async () => {
  const controller = new AbortController()

  const recipe = (_ctx: ExecutionContext): Promise<void> => {
    return new Promise((resolve) => {
      setTimeout(resolve, 500)
    })
  }

  // Abort after a short delay
  setTimeout(() => controller.abort(), 20)

  const result = await runRecipe({
    recipe,
    hosts: [
      { host: stubHost("host-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("host-2", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
    signal: controller.signal,
  })

  // At least some hosts should be cancelled
  const cancelled = result.hosts.filter((h) => h.cancelled)
  expect(cancelled.length).toBeGreaterThan(0)
})

test("pre-aborted signal cancels all hosts immediately", async () => {
  const controller = new AbortController()
  controller.abort()

  const log: string[] = []

  const result = await runRecipe({
    recipe: recordingRecipe(log),
    hosts: [
      { host: stubHost("host-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("host-2", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    signal: controller.signal,
  })

  expect(log).toEqual([])
  expect(result.hosts.length).toEqual(2)
  expect(result.hosts[0].cancelled).toEqual(true)
  expect(result.hosts[1].cancelled).toEqual(true)
})

// ---------------------------------------------------------------------------
// Concurrency — connections cleanup
// ---------------------------------------------------------------------------

test("all connections closed even when hosts are cancelled", async () => {
  const failConn = stubConnection({ ping: () => Promise.resolve(false) })
  const conn2 = stubConnection()
  const conn3 = stubConnection()

  await runRecipe({
    recipe: emptyRecipe,
    hosts: [
      { host: stubHost("fail-host", "10.0.1.1"), connection: failConn },
      { host: stubHost("host-2", "10.0.1.2"), connection: conn2 },
      { host: stubHost("host-3", "10.0.1.3"), connection: conn3 },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 1 },
  })

  // All connections should be closed, including cancelled hosts
  expect(failConn.closeCalls).toEqual(1)
  expect(conn2.closeCalls).toEqual(1)
  expect(conn3.closeCalls).toEqual(1)
})

// ---------------------------------------------------------------------------
// Concurrency — default parallelism
// ---------------------------------------------------------------------------

test("uses default parallelism when concurrency not specified", async () => {
  const log: string[] = []
  const recipe = recordingRecipe(log)

  const result = await runRecipe({
    recipe,
    hosts: [
      { host: stubHost("web-1", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("web-2", "10.0.1.2"), connection: stubConnection() },
      { host: stubHost("web-3", "10.0.1.3"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(result.hosts.length).toEqual(3)
  // All hosts should have run
  expect(log.length).toEqual(3)
})

// ---------------------------------------------------------------------------
// Cancellation plumbing — signal propagation
// ---------------------------------------------------------------------------

test("signal wired into ExecutionContext for each host", async () => {
  let capturedSignal: AbortSignal | undefined

  await runRecipe({
    recipe: (ctx) => {
      capturedSignal = ctx.signal
      return Promise.resolve()
    },
    hosts: [{ host: stubHost(), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
  })

  expect(capturedSignal instanceof AbortSignal).toEqual(true)
  expect(capturedSignal!.aborted).toEqual(false)
})

test("fail-fast abort fires signal on sibling hosts", async () => {
  const capturedSignals: AbortSignal[] = []
  const resolvers: Array<() => void> = []

  const recipe = (ctx: ExecutionContext): Promise<void> => {
    capturedSignals.push(ctx.signal!)
    if (ctx.host.name === "fail-host") {
      ctx.results.push({
        type: "exec",
        name: "boom",
        status: "failed",
        error: new Error("fail"),
        durationMs: 1,
      })
      throw new Error("fail-fast propagation")
    }
    return new Promise<void>((resolve) => {
      resolvers.push(resolve)
    })
  }

  const promise = runRecipe({
    recipe,
    hosts: [
      { host: stubHost("slow-host", "10.0.1.1"), connection: stubConnection() },
      { host: stubHost("fail-host", "10.0.1.2"), connection: stubConnection() },
    ],
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { parallelism: 2 },
  })

  // Wait for fail-host to complete and trigger abort
  await new Promise((r) => setTimeout(r, 30))

  // The slow-host's signal should be aborted by fail-fast
  const slowHostSignal = capturedSignals.find((_, i) => i === 0)
  expect(slowHostSignal?.aborted).toEqual(true)

  // Resolve slow-host so the run completes
  if (resolvers.length > 0) resolvers[0]()

  await promise
})

test("hostTimeout fires signal so in-flight work can be cancelled", async () => {
  let capturedSignal: AbortSignal | undefined

  const recipe = (ctx: ExecutionContext): Promise<void> => {
    capturedSignal = ctx.signal
    return new Promise(() => {}) // never resolves
  }

  const result = await runRecipe({
    recipe,
    hosts: [{ host: stubHost("slow-host", "10.0.1.1"), connection: stubConnection() }],
    mode: "apply",
    errorMode: "fail-at-end",
    verbose: false,
    reporter: noopReporter(),
    concurrency: { hostTimeout: 50 },
  })

  expect(result.hosts[0].cancelled).toEqual(true)
  expect(capturedSignal?.aborted).toEqual(true)
})
