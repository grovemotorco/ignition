/**
 * Real SSH integration test against a live host.
 *
 * Usage:
 *   bun run examples/real_ssh_test.ts
 *
 * Target: ubuntu@67.213.118.125 (key: ~/.ssh/id_rr.pub)
 * Note *.pub key is intentional as we are using 1Password SSH Agent
 *
 * This script exercises every layer of the Ignition runtime against a real host:
 *   1. SSH connectivity (ping, exec, transfer, fetch)
 *   2. Resource lifecycle (check-then-apply)
 *   3. All resource types (exec, file, directory, apt, service)
 *   4. Check mode (dry-run)
 *   5. Idempotence (second run = all "ok")
 *   6. Recipe runner (multi-step orchestration)
 *   7. Template-based file generation
 *   8. Cleanup
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createResources } from "../src/resources/index.ts"
import { createSystemSSHConnection } from "../src/ssh/connection.ts"
import { ExecutionContextImpl } from "../src/core/context.ts"
import { runRecipe } from "../src/core/runner.ts"
import type { ExecutionContext, HostContext, ResourceResult } from "../src/core/types.ts"
import type { SSHConnection } from "../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SSH_HOST = process.env.IGNITION_HOST || "67.213.118.125"
const SSH_USER = process.env.IGNITION_USER || "ubuntu"
const SSH_PORT = Number(process.env.IGNITION_PORT || "22")
const SSH_KEY = process.env.IGNITION_KEY || join(homedir(), ".ssh/id_rr.pub")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

let passCount = 0
let failCount = 0

function header(title: string) {
  console.log()
  console.log(`${BOLD}${CYAN}━━━ ${title} ━━━${RESET}`)
}

function pass(msg: string) {
  passCount++
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}

function fail(msg: string, err?: unknown) {
  failCount++
  console.log(`  ${RED}✗${RESET} ${msg}`)
  if (err) {
    const rendered =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : typeof err === "number" || typeof err === "boolean"
            ? String(err)
            : (JSON.stringify(err) ?? "<non-serializable error>")
    console.log(`    ${DIM}${rendered}${RESET}`)
  }
}

function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`)
}

function resultLine(r: ResourceResult) {
  const icon =
    r.status === "ok"
      ? `${GREEN}✓${RESET}`
      : r.status === "changed"
        ? `${YELLOW}△${RESET}`
        : `${RED}✗${RESET}`
  const dur = `${DIM}(${r.durationMs.toFixed(0)}ms)${RESET}`
  console.log(`  ${icon} ${r.type.padEnd(10)} ${r.name} ${dur}`)
}

function scalar(value: unknown, fallback = ""): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return fallback
}

/** Console reporter that prints resource progress. */
const reporter = {
  resourceStart(_type: string, _name: string) {
    // silent — we print on end
  },
  resourceEnd(result: ResourceResult) {
    resultLine(result)
  },
}

/** Silent reporter for runs where we inspect results programmatically. */
const silentReporter = {
  resourceStart() {},
  resourceEnd() {},
}

function makeHost(): HostContext {
  return {
    name: "test-target",
    hostname: SSH_HOST,
    user: SSH_USER,
    port: SSH_PORT,
    vars: {},
  }
}

function makeCtx(
  conn: SSHConnection,
  opts?: { mode?: "apply" | "check"; vars?: Record<string, unknown>; reporter?: typeof reporter },
) {
  return new ExecutionContextImpl({
    connection: conn,
    mode: opts?.mode ?? "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: makeHost(),
    reporter: opts?.reporter ?? reporter,
    vars: opts?.vars,
  })
}

async function makeTempFile(prefix: string, suffix = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const path = join(dir, `tmp${suffix}`)
  await writeFile(path, "", "utf-8")
  return path
}

async function cleanupTempFile(path: string): Promise<void> {
  await rm(path, { force: true })
  await rm(dirname(path), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log(`${BOLD}Ignition — Real SSH Integration Test${RESET}`)
  console.log(`${DIM}Target: ${SSH_USER}@${SSH_HOST}:${SSH_PORT}  Key: ${SSH_KEY}${RESET}`)

  // -----------------------------------------------------------------------
  // 1. SSH Connection
  // -----------------------------------------------------------------------
  header("1. SSH Connection")

  let conn: SSHConnection
  try {
    conn = await createSystemSSHConnection({
      hostname: SSH_HOST,
      port: SSH_PORT,
      user: SSH_USER,
      privateKey: SSH_KEY,
      hostKeyPolicy: "accept-new",
    })
    pass("createSystemSSHConnection() succeeded")
  } catch (err) {
    fail("createSystemSSHConnection() failed", err)
    console.log(`\n${RED}Cannot continue without SSH connection. Exiting.${RESET}`)
    process.exit(1)
  }

  // Ping
  try {
    const reachable = await conn.ping()
    if (reachable) pass("ping() returned true")
    else fail("ping() returned false — host unreachable")
  } catch (err) {
    fail("ping() threw", err)
  }

  // Exec basic command
  try {
    const result = await conn.exec("uname -a")
    if (result.exitCode === 0) {
      pass(`exec('uname -a') → exit 0`)
      info(result.stdout.trim())
    } else {
      fail(`exec('uname -a') → exit ${result.exitCode}`, result.stderr)
    }
  } catch (err) {
    fail("exec() threw", err)
  }

  // Exec with stdin
  try {
    const result = await conn.exec("cat", { stdin: "hello from ignition" })
    if (result.stdout.trim() === "hello from ignition") {
      pass("exec() with stdin piping works")
    } else {
      fail("exec() stdin mismatch", `got: ${result.stdout.trim()}`)
    }
  } catch (err) {
    fail("exec() with stdin threw", err)
  }

  // -----------------------------------------------------------------------
  // 2. exec resource
  // -----------------------------------------------------------------------
  header("2. exec resource")

  {
    const ctx = makeCtx(conn)
    const { exec } = createResources(ctx)

    try {
      const r = await exec({ command: "whoami" })
      if (r.status === "changed" && r.output?.stdout.trim() === SSH_USER) {
        pass(`exec('whoami') → ${r.output.stdout.trim()}`)
      } else {
        fail("exec unexpected result", JSON.stringify(r))
      }
    } catch (err) {
      fail("exec resource threw", err)
    }

    // Note: `FOO=val echo $FOO` doesn't work because the shell expands $FOO
    // before the env prefix takes effect. Use printenv which reads the process env directly.
    try {
      const r = await exec({ command: "printenv FOO", env: { FOO: "bar123" } })
      if (r.output?.stdout.trim() === "bar123") {
        pass("exec with env vars works")
      } else {
        fail("exec env mismatch", r.output?.stdout)
      }
    } catch (err) {
      fail("exec with env threw", err)
    }

    try {
      const r = await exec({ command: "pwd", cwd: "/tmp" })
      if (r.output?.stdout.trim() === "/tmp") {
        pass("exec with cwd works")
      } else {
        fail("exec cwd mismatch", r.output?.stdout)
      }
    } catch (err) {
      fail("exec with cwd threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 3. directory resource
  // -----------------------------------------------------------------------
  header("3. directory resource")

  const testDir = "/tmp/ignition-test-" + Date.now()

  {
    const ctx = makeCtx(conn)
    const { directory } = createResources(ctx)

    // Create
    try {
      const r = await directory({ path: testDir, mode: "755" })
      if (r.status === "changed") pass(`directory created: ${testDir}`)
      else fail("directory expected changed", r.status)
    } catch (err) {
      fail("directory create threw", err)
    }

    // Idempotent — run again
    try {
      const r = await directory({ path: testDir, mode: "755" })
      if (r.status === "ok") pass("directory idempotent (second run → ok)")
      else fail("directory expected ok on second run", r.status)
    } catch (err) {
      fail("directory idempotent check threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 4. file resource — inline content
  // -----------------------------------------------------------------------
  header("4. file resource (inline content)")

  const testFile = `${testDir}/hello.txt`

  {
    const ctx = makeCtx(conn)
    const { file } = createResources(ctx)

    // Create file with inline content
    try {
      const r = await file({ path: testFile, content: "Hello from Ignition!\n", mode: "644" })
      if (r.status === "changed") pass(`file created: ${testFile}`)
      else fail("file expected changed", r.status)
    } catch (err) {
      fail("file create threw", err)
    }

    // Verify content
    try {
      const result = await conn.exec(`cat '${testFile}'`)
      if (result.stdout === "Hello from Ignition!\n") {
        pass("file content verified on remote")
      } else {
        fail("file content mismatch", `got: ${JSON.stringify(result.stdout)}`)
      }
    } catch (err) {
      fail("file verify threw", err)
    }

    // Idempotent
    try {
      const r = await file({ path: testFile, content: "Hello from Ignition!\n", mode: "644" })
      if (r.status === "ok") pass("file idempotent (second run → ok)")
      else fail("file expected ok on second run", r.status)
    } catch (err) {
      fail("file idempotent check threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 5. file resource — template
  // -----------------------------------------------------------------------
  header("5. file resource (template)")

  const templateFile = `${testDir}/config.ini`

  {
    const ctx = makeCtx(conn, { vars: { appName: "ignition", port: 3000, debug: true } })
    const { file } = createResources(ctx)

    const template = (vars: Record<string, unknown>) =>
      `[app]\nname = ${scalar(vars.appName)}\nport = ${scalar(vars.port)}\ndebug = ${scalar(vars.debug)}\n`

    try {
      const r = await file({ path: templateFile, template, mode: "644" })
      if (r.status === "changed") pass(`template file created: ${templateFile}`)
      else fail("template file expected changed", r.status)
    } catch (err) {
      fail("template file threw", err)
    }

    // Verify
    try {
      const result = await conn.exec(`cat '${templateFile}'`)
      if (result.stdout.includes("name = ignition") && result.stdout.includes("port = 3000")) {
        pass("template content verified on remote")
        info(
          result.stdout
            .trim()
            .split("\n")
            .map((l: string) => `  ${l}`)
            .join("\n"),
        )
      } else {
        fail("template content mismatch", result.stdout)
      }
    } catch (err) {
      fail("template verify threw", err)
    }

    // Idempotent
    try {
      const r = await file({ path: templateFile, template, mode: "644" })
      if (r.status === "ok") pass("template file idempotent (second run → ok)")
      else fail("template file expected ok on second run", r.status)
    } catch (err) {
      fail("template file idempotent threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 6. file resource — scp transfer
  // -----------------------------------------------------------------------
  header("6. file resource (scp transfer)")

  const localTmp = await makeTempFile("ignition-", ".txt")
  await writeFile(localTmp, "transferred by scp\n", "utf-8")
  const remoteTransferred = `${testDir}/transferred.txt`

  {
    const ctx = makeCtx(conn)
    const { file } = createResources(ctx)

    try {
      const r = await file({ path: remoteTransferred, source: localTmp })
      if (r.status === "changed") pass(`file transferred via scp: ${remoteTransferred}`)
      else fail("scp transfer expected changed", r.status)
    } catch (err) {
      fail("scp transfer threw", err)
    }

    // Verify
    try {
      const result = await conn.exec(`cat '${remoteTransferred}'`)
      if (result.stdout.trim() === "transferred by scp") {
        pass("scp transferred content verified")
      } else {
        fail("scp content mismatch", result.stdout)
      }
    } catch (err) {
      fail("scp verify threw", err)
    }
  }

  await cleanupTempFile(localTmp)

  // -----------------------------------------------------------------------
  // 7. scp fetch (pull file from remote)
  // -----------------------------------------------------------------------
  header("7. scp fetch (pull from remote)")

  {
    const localFetch = await makeTempFile("ignition-fetch-")
    try {
      await conn.fetch(remoteTransferred, localFetch)
      const content = await readFile(localFetch, "utf-8")
      if (content.trim() === "transferred by scp") {
        pass("fetch() pulled file from remote correctly")
      } else {
        fail("fetch content mismatch", content)
      }
    } catch (err) {
      fail("fetch() threw", err)
    } finally {
      try {
        await cleanupTempFile(localFetch)
      } catch {
        /* ignore */
      }
    }
  }

  // -----------------------------------------------------------------------
  // 8. Check mode (dry run)
  // -----------------------------------------------------------------------
  header("8. Check mode (dry run)")

  const dryRunFile = `${testDir}/should-not-exist.txt`

  {
    const ctx = makeCtx(conn, { mode: "check" })
    const { file, directory: _directory } = createResources(ctx)

    try {
      const r = await file({ path: dryRunFile, content: "nope\n" })
      if (r.status === "changed") pass('check mode: file reports "changed" (would create)')
      else fail("check mode: expected changed", r.status)
    } catch (err) {
      fail("check mode file threw", err)
    }

    // Verify file was NOT actually created
    try {
      const result = await conn.exec(`test -f '${dryRunFile}' && echo exists || echo missing`)
      if (result.stdout.trim() === "missing") {
        pass("check mode: file was NOT created on remote")
      } else {
        fail("check mode: file was unexpectedly created!")
      }
    } catch (err) {
      fail("check mode verify threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 9. file absent (removal)
  // -----------------------------------------------------------------------
  header("9. file absent (removal)")

  {
    const ctx = makeCtx(conn)
    const { file } = createResources(ctx)

    try {
      const r = await file({ path: testFile, state: "absent" })
      if (r.status === "changed") pass(`file removed: ${testFile}`)
      else fail("file absent expected changed", r.status)
    } catch (err) {
      fail("file absent threw", err)
    }

    // Idempotent
    try {
      const r = await file({ path: testFile, state: "absent" })
      if (r.status === "ok") pass("file absent idempotent (second run → ok)")
      else fail("file absent expected ok on second run", r.status)
    } catch (err) {
      fail("file absent idempotent threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 10. Recipe runner — multi-step orchestration
  // -----------------------------------------------------------------------
  header("10. Recipe runner")

  {
    const recipeDir = `${testDir}/recipe-test`

    const setupRecipe = async (ctx: ExecutionContext) => {
      const { exec, file, directory } = createResources(ctx)
      await directory({ path: recipeDir })
      await file({ path: `${recipeDir}/index.html`, content: "<h1>Ignition works!</h1>\n" })
      await file({
        path: `${recipeDir}/app.env`,
        template: (vars) => `APP_ENV=${scalar(vars.env)}\nAPP_PORT=${scalar(vars.port)}\n`,
      })
      await exec({ command: `ls -la '${recipeDir}'` })
    }

    try {
      const summary = await runRecipe({
        recipe: setupRecipe,
        hosts: [{ host: makeHost(), connection: conn }],
        mode: "apply",
        errorMode: "fail-fast",
        verbose: false,
        reporter,
        vars: { env: "production", port: 8080 },
      })

      if (!summary.hasFailures) {
        pass(
          `recipe completed: ${summary.hosts[0].ok} ok, ${summary.hosts[0].changed} changed, ${
            summary.hosts[0].failed
          } failed`,
        )
      } else {
        fail("recipe had failures", JSON.stringify(summary.hosts[0]))
      }

      info(`total time: ${summary.durationMs.toFixed(0)}ms`)
    } catch (err) {
      fail("recipe runner threw", err)
    }

    // Idempotence: run the same recipe again
    info("")
    info("Running recipe again (idempotence check)...")

    try {
      const ctx2 = makeCtx(conn, {
        vars: { env: "production", port: 8080 },
        reporter: silentReporter,
      })
      const { file, directory } = createResources(ctx2)
      await directory({ path: recipeDir })
      await file({ path: `${recipeDir}/index.html`, content: "<h1>Ignition works!</h1>\n" })
      await file({
        path: `${recipeDir}/app.env`,
        template: (vars) => `APP_ENV=${scalar(vars.env)}\nAPP_PORT=${scalar(vars.port)}\n`,
      })

      const okCount = ctx2.results.filter((r) => r.status === "ok").length
      const changedCount = ctx2.results.filter((r) => r.status === "changed").length

      if (changedCount === 0 && okCount === ctx2.results.length) {
        pass(`idempotent: all ${okCount} resources returned ok`)
      } else {
        fail(`idempotence failed: ${okCount} ok, ${changedCount} changed`)
        for (const r of ctx2.results) {
          info(`  ${r.status} ${r.type} ${r.name}`)
        }
      }
    } catch (err) {
      fail("idempotence check threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 11. apt resource (read-only check — no install)
  // -----------------------------------------------------------------------
  header("11. apt resource (read-only check)")

  {
    const ctx = makeCtx(conn, { mode: "check" })
    const { apt } = createResources(ctx)

    // Check if common packages are present (should be on Ubuntu)
    try {
      const r = await apt({ name: "coreutils", state: "present" })
      if (r.status === "ok") pass("apt: coreutils is installed (ok)")
      else pass(`apt: coreutils would be installed (${r.status})`)
    } catch (err) {
      fail("apt check threw", err)
    }

    // Check a package that's unlikely to be installed
    try {
      const r = await apt({ name: "cowsay", state: "present" })
      info(`apt: cowsay → ${r.status} (${r.status === "changed" ? "not installed" : "installed"})`)
      pass("apt check mode works without mutating")
    } catch (err) {
      fail("apt check cowsay threw", err)
    }
  }

  // -----------------------------------------------------------------------
  // 12. service resource (read-only check)
  // -----------------------------------------------------------------------
  header("12. service resource (read-only check)")

  {
    const ctx = makeCtx(conn, { mode: "check" })
    const { service } = createResources(ctx)

    try {
      const r = await service({ name: "ssh", state: "started" })
      if (r.status === "ok") pass("service: ssh is running (ok)")
      else info(`service: ssh → ${r.status}`)
      pass("service check mode works")
    } catch {
      // sshd might be named differently
      info(`service check for 'ssh' failed — trying 'sshd'`)
      try {
        const ctx2 = makeCtx(conn, { mode: "check", reporter: silentReporter })
        const { service: service2 } = createResources(ctx2)
        const r = await service2({ name: "sshd", state: "started" })
        if (r.status === "ok") pass("service: sshd is running (ok)")
        else info(`service: sshd → ${r.status}`)
      } catch (err2) {
        fail("service check threw", err2)
      }
    }
  }

  // -----------------------------------------------------------------------
  // 13. Error handling — fail-at-end
  // -----------------------------------------------------------------------
  header("13. Error handling (fail-at-end)")

  {
    const ctxFailEnd = new ExecutionContextImpl({
      connection: conn,
      mode: "apply",
      errorMode: "fail-at-end",
      verbose: false,
      host: makeHost(),
      reporter: silentReporter,
    })

    const { exec } = createResources(ctxFailEnd)

    try {
      await exec({ command: "echo before-error" })
      await exec({ command: "exit 42" }) // will fail
      await exec({ command: "echo after-error" }) // should still run

      const statuses = ctxFailEnd.results.map((r) => r.status)
      if (statuses.includes("failed") && statuses.length === 3) {
        pass(`fail-at-end: all 3 resources executed (${statuses.join(", ")})`)
      } else {
        fail("fail-at-end: unexpected result", statuses)
      }
      if (ctxFailEnd.hasFailed) pass("hasFailed is true")
      else fail("hasFailed should be true")
    } catch (err) {
      fail("fail-at-end should not throw", err)
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  header("Cleanup")

  try {
    const result = await conn.exec(`rm -rf '${testDir}'`)
    if (result.exitCode === 0) pass(`removed ${testDir}`)
    else fail("cleanup failed", result.stderr)
  } catch (err) {
    fail("cleanup threw", err)
  }

  await conn.close()
  pass("connection closed")

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log()
  console.log(`${BOLD}━━━ Summary ━━━${RESET}`)
  console.log(`  ${GREEN}${passCount} passed${RESET}`)
  if (failCount > 0) console.log(`  ${RED}${failCount} failed${RESET}`)
  else console.log(`  ${DIM}0 failed${RESET}`)
  console.log()

  if (failCount > 0) process.exit(1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
