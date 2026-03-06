/**
 * End-to-end recipe tests against a Deno Sandbox microVM.
 *
 * Tests the full pipeline: recipe function → runRecipe() → SSH execution →
 * RunSummary. Covers idempotence (second run = all ok), check mode (dry-run
 * without mutation), and error mode (fail-fast / fail-at-end / ignore).
 *
 * Uses one shared sandbox per suite. Requires DENO_DEPLOY_TOKEN and skips
 * gracefully when absent.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync } from "node:fs"
import { rm } from "node:fs/promises"
import {
  hasSandboxToken,
  createSandboxHandle,
  type SandboxHandle,
} from "../integration/sandbox_fixture.ts"
import { runRecipe } from "../../src/core/runner.ts"
import { createResources } from "../../src/resources/index.ts"
import type { ExecutionContext, HostContext, Reporter } from "../../src/core/types.ts"
import type { Transport } from "../../src/ssh/types.ts"
import type { RecipeFunction } from "../../src/recipe/types.ts"

const SKIP = !hasSandboxToken()

function silentReporter(): Reporter {
  return {
    resourceStart() {},
    resourceEnd() {},
  }
}

const SANDBOX_RESOURCE_POLICY = {
  timeoutMs: 60_000,
  retries: 3,
  retryDelayMs: 1_000,
}

/**
 * A simple convergent recipe that creates a directory and a file.
 * Both resources are idempotent — a second run should report all "ok".
 */
const convergentRecipe: RecipeFunction = async (ctx: ExecutionContext) => {
  const { directory, file } = createResources(ctx)

  await directory({ path: "/tmp/ignition-e2e-test", mode: "755" })
  await file({
    path: "/tmp/ignition-e2e-test/hello.txt",
    content: "hello from ignition e2e\n",
    mode: "644",
  })
}

/**
 * A recipe with a deliberately failing exec resource.
 * Used to test error mode handling.
 */
const failingRecipe: RecipeFunction = async (ctx: ExecutionContext) => {
  const { exec, file } = createResources(ctx)

  await file({
    path: "/tmp/ignition-e2e-error-test.txt",
    content: "before failure\n",
    mode: "644",
  })

  // This exec will fail (non-zero exit code)
  await exec({ command: "exit 42" })

  // This should only run in fail-at-end / ignore modes
  await file({
    path: "/tmp/ignition-e2e-after-failure.txt",
    content: "after failure\n",
    mode: "644",
  })
}

/**
 * Enable SSH multiplexing (ControlMaster) so all SSH commands in a runRecipe()
 * call share one TCP connection. Without multiplexing, each exec() spawns a
 * fresh SSH handshake which exhausts the sandbox's sshd connection limits
 * (~25+ sequential handshakes cause hangs).
 *
 * runRecipe() calls closeQuietly(connection) after each host finishes. With
 * multiplexing enabled, that tears down the ControlMaster via `ssh -O exit`.
 * We wrap the connection so close() is a no-op — the ControlMaster stays alive
 * across runRecipe() calls. Cleanup happens in afterAll via sb.kill().
 */
function noCloseProxy(conn: Transport): Transport {
  return {
    config: conn.config,
    capabilities: () => conn.capabilities(),
    exec: (command, opts) => conn.exec(command, opts),
    transfer: (local, remote, signal) => conn.transfer(local, remote, signal),
    fetch: (remote, local, signal) => conn.fetch(remote, local, signal),
    ping: () => conn.ping(),
    close: async () => {},
  }
}

describe.skipIf(SKIP)("e2e: recipe execution", () => {
  let sb: SandboxHandle
  let host: HostContext
  let conn: Transport
  let controlDir: string

  beforeAll(async () => {
    controlDir = `/tmp/ign-e2e-${crypto.randomUUID().slice(0, 8)}`
    mkdirSync(controlDir, { recursive: true })
    sb = await createSandboxHandle({ multiplexing: true, controlDirectory: controlDir })
    conn = noCloseProxy(sb.conn)
    host = {
      name: "sandbox",
      hostname: sb.ssh.hostname,
      user: sb.ssh.username,
      port: 22,
      vars: {},
    }
  })

  afterAll(async () => {
    await sb?.kill()
    await rm(controlDir, { recursive: true, force: true }).catch(() => {})
  })

  test("full recipe produces RunSummary with changed resources", async () => {
    await sb.conn.exec("rm -rf /tmp/ignition-e2e-test")

    const summary = await runRecipe({
      recipe: convergentRecipe,
      hosts: [{ host, connection: conn }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: silentReporter(),
      resourcePolicy: SANDBOX_RESOURCE_POLICY,
    })

    expect(summary.hasFailures).toEqual(false)
    expect(summary.hosts.length).toEqual(1)
    expect(summary.hosts[0].failed).toEqual(0)
    expect(summary.hosts[0].changed).toEqual(2) // directory + file
  })

  test("idempotence — second run reports all ok (zero changed)", async () => {
    // First run to establish state (clean slate)
    await sb.conn.exec("rm -rf /tmp/ignition-e2e-test")

    const firstRun = await runRecipe({
      recipe: convergentRecipe,
      hosts: [{ host, connection: conn }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: silentReporter(),
      resourcePolicy: SANDBOX_RESOURCE_POLICY,
    })

    // Verify first run succeeded before testing idempotence
    expect(firstRun.hasFailures).toEqual(false)
    expect(firstRun.hosts[0].changed).toEqual(2)

    // Second run — everything should already be in desired state
    const summary = await runRecipe({
      recipe: convergentRecipe,
      hosts: [{ host, connection: conn }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: silentReporter(),
      resourcePolicy: SANDBOX_RESOURCE_POLICY,
    })

    // Diagnostic: show results on failure
    if (summary.hasFailures) {
      const results = summary.hosts[0]?.results.map((r) => ({
        type: r.type,
        name: r.name,
        status: r.status,
        error: r.error?.message,
      }))
      console.error("Idempotence failure — results:", JSON.stringify(results, null, 2))
    }

    expect(summary.hasFailures).toEqual(false)
    expect(summary.hosts[0].changed).toEqual(0)
    expect(summary.hosts[0].ok).toEqual(2) // directory + file already ok
  })

  test("check mode produces diff output without mutating the host", async () => {
    await sb.conn.exec("rm -rf /tmp/ignition-e2e-test")

    const summary = await runRecipe({
      recipe: convergentRecipe,
      hosts: [{ host, connection: conn }],
      mode: "check",
      errorMode: "fail-fast",
      verbose: false,
      reporter: silentReporter(),
      resourcePolicy: SANDBOX_RESOURCE_POLICY,
    })

    // Check mode reports drift as "changed" but must not apply.
    expect(summary.hasFailures).toEqual(false)
    expect(summary.hosts[0].changed).toEqual(2)

    // Verify nothing was actually created on the host
    const verify = await sb.conn.exec(
      "test -d /tmp/ignition-e2e-test && echo exists || echo missing",
    )
    expect(verify.stdout.trim()).toEqual("missing")
  })

  test("error mode fail-at-end continues after failure", async () => {
    await sb.conn.exec("rm -f /tmp/ignition-e2e-error-test.txt /tmp/ignition-e2e-after-failure.txt")

    const summary = await runRecipe({
      recipe: failingRecipe,
      hosts: [{ host, connection: conn }],
      mode: "apply",
      errorMode: "fail-at-end",
      verbose: false,
      reporter: silentReporter(),
      resourcePolicy: SANDBOX_RESOURCE_POLICY,
    })

    expect(summary.hasFailures).toEqual(true)
    expect(summary.hosts[0].failed).toEqual(1) // the failing exec

    // fail-at-end should have continued past the failure
    // Total results: file (changed) + exec (failed) + file (changed) = 3
    const totalResults = summary.hosts[0].results.length
    expect(totalResults).toEqual(3)
  })

  test("error mode fail-fast stops after first failure", async () => {
    await sb.conn.exec("rm -f /tmp/ignition-e2e-error-test.txt /tmp/ignition-e2e-after-failure.txt")

    const summary = await runRecipe({
      recipe: failingRecipe,
      hosts: [{ host, connection: conn }],
      mode: "apply",
      errorMode: "fail-fast",
      verbose: false,
      reporter: silentReporter(),
      resourcePolicy: SANDBOX_RESOURCE_POLICY,
    })

    expect(summary.hasFailures).toEqual(true)
    expect(summary.hosts[0].failed).toEqual(1)

    // fail-fast should have stopped after the failure
    // Only: file (changed) + exec (failed) = 2 results
    const totalResults = summary.hosts[0].results.length
    expect(totalResults).toEqual(2)
  })
})

if (SKIP) {
  console.log("Set DENO_DEPLOY_TOKEN and IGNITION_RUN_SANDBOX_TESTS=1 to run e2e recipe tests")
}
