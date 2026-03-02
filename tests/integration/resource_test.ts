/**
 * Integration test: Resource types against a real Deno Sandbox microVM.
 *
 * Tests file, directory, and exec resources individually against a shared
 * sandbox, exercising the actual SSH commands that check() and apply() emit.
 * Skips gracefully when DENO_DEPLOY_TOKEN is not set. See ADR-0017, ISSUE-0022.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { hasSandboxToken, createSandboxHandle, type SandboxHandle } from "./sandbox_fixture.ts"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { createResources } from "../../src/resources/index.ts"
import type { Reporter } from "../../src/core/types.ts"

const SKIP = !hasSandboxToken()

function silentReporter(): Reporter {
  return {
    resourceStart() {},
    resourceEnd() {},
  }
}

function makeCtx(
  sb: SandboxHandle,
  opts?: { mode?: "apply" | "check"; vars?: Record<string, unknown> },
): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: sb.conn,
    mode: opts?.mode ?? "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: { name: "sandbox", hostname: sb.ssh.hostname, user: sb.ssh.username, port: 22, vars: {} },
    reporter: silentReporter(),
    vars: opts?.vars,
  })
}

// ---------------------------------------------------------------------------
// file resource tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("integration: file resource", () => {
  let sb: SandboxHandle

  beforeAll(async () => {
    sb = await createSandboxHandle()
  })

  afterAll(async () => {
    await sb?.kill()
  })

  test("create with inline content, verify checksum match", async () => {
    const ctx = makeCtx(sb)
    const { file } = createResources(ctx)

    const content = "hello from ignition integration test\n"
    const remotePath = "/tmp/ignition-integ-file-create.txt"

    const result = await file({ path: remotePath, content })
    expect(result.status).toEqual("changed")

    const catResult = await sb.conn.exec(`cat ${remotePath}`)
    expect(catResult.stdout).toEqual(content)

    const sumResult = await sb.conn.exec(`sha256sum ${remotePath} | awk '{print $1}'`)
    const data = new TextEncoder().encode(content)
    const hash = await crypto.subtle.digest("SHA-256", data)
    const localChecksum = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    expect(sumResult.stdout.trim()).toEqual(localChecksum)
  })

  test("idempotence, second apply is a no-op", async () => {
    const content = "idempotent content\n"
    const remotePath = "/tmp/ignition-integ-file-idempotent.txt"

    const ctx1 = makeCtx(sb)
    const { file: file1 } = createResources(ctx1)
    const r1 = await file1({ path: remotePath, content })
    expect(r1.status).toEqual("changed")

    const ctx2 = makeCtx(sb)
    const { file: file2 } = createResources(ctx2)
    const r2 = await file2({ path: remotePath, content })
    expect(r2.status).toEqual("ok")
  })

  test("state=absent removes an existing file", async () => {
    const remotePath = "/tmp/ignition-integ-file-absent.txt"

    const ctx1 = makeCtx(sb)
    const { file: file1 } = createResources(ctx1)
    await file1({ path: remotePath, content: "to be removed\n" })

    const existCheck = await sb.conn.exec(`test -f ${remotePath} && echo EXISTS || echo MISSING`)
    expect(existCheck.stdout.trim()).toEqual("EXISTS")

    const ctx2 = makeCtx(sb)
    const { file: file2 } = createResources(ctx2)
    const r = await file2({ path: remotePath, state: "absent" })
    expect(r.status).toEqual("changed")

    const goneCheck = await sb.conn.exec(`test -f ${remotePath} && echo EXISTS || echo MISSING`)
    expect(goneCheck.stdout.trim()).toEqual("MISSING")
  })

  test("template function renders vars into content", async () => {
    const remotePath = "/tmp/ignition-integ-file-template.txt"
    const vars = { greeting: "hello", target: "world" }

    const ctx = makeCtx(sb, { vars })
    const { file } = createResources(ctx)

    await file({
      path: remotePath,
      template: (v) => `${String(v.greeting)}, ${String(v.target)}!\n`,
    })

    const catResult = await sb.conn.exec(`cat ${remotePath}`)
    expect(catResult.stdout).toEqual("hello, world!\n")
  })
})

// ---------------------------------------------------------------------------
// directory resource tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("integration: directory resource", () => {
  let sb: SandboxHandle

  beforeAll(async () => {
    sb = await createSandboxHandle()
  })

  afterAll(async () => {
    await sb?.kill()
  })

  test("create and verify existence", async () => {
    const remotePath = "/tmp/ignition-integ-dir-create"

    const ctx = makeCtx(sb)
    const { directory } = createResources(ctx)

    const r = await directory({ path: remotePath })
    expect(r.status).toEqual("changed")

    const check = await sb.conn.exec(`test -d ${remotePath} && echo EXISTS || echo MISSING`)
    expect(check.stdout.trim()).toEqual("EXISTS")
  })

  test("state=absent removes directory", async () => {
    const remotePath = "/tmp/ignition-integ-dir-absent"

    const ctx1 = makeCtx(sb)
    const { directory: dir1 } = createResources(ctx1)
    await dir1({ path: remotePath })

    const existCheck = await sb.conn.exec(`test -d ${remotePath} && echo EXISTS || echo MISSING`)
    expect(existCheck.stdout.trim()).toEqual("EXISTS")

    const ctx2 = makeCtx(sb)
    const { directory: dir2 } = createResources(ctx2)
    const r = await dir2({ path: remotePath, state: "absent" })
    expect(r.status).toEqual("changed")

    const goneCheck = await sb.conn.exec(`test -d ${remotePath} && echo EXISTS || echo MISSING`)
    expect(goneCheck.stdout.trim()).toEqual("MISSING")
  })

  test("nested recursive creation", async () => {
    const remotePath = "/tmp/ignition-integ-dir-nested/a/b/c"

    const ctx = makeCtx(sb)
    const { directory } = createResources(ctx)

    const r = await directory({ path: remotePath })
    expect(r.status).toEqual("changed")

    for (const p of ["/tmp/ignition-integ-dir-nested", remotePath]) {
      const check = await sb.conn.exec(`test -d ${p} && echo EXISTS || echo MISSING`)
      expect(check.stdout.trim()).toEqual("EXISTS")
    }
  })
})

// ---------------------------------------------------------------------------
// exec resource tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("integration: exec resource", () => {
  let sb: SandboxHandle

  beforeAll(async () => {
    sb = await createSandboxHandle()
  })

  afterAll(async () => {
    await sb?.kill()
  })

  test("basic command with stdout capture", async () => {
    const ctx = makeCtx(sb)
    const { exec } = createResources(ctx)

    const r = await exec({ command: "echo hello" })
    expect(r.status).toEqual("changed")
    expect(r.output!.stdout).toContain("hello")
  })

  test("environment variables passed correctly", async () => {
    const ctx = makeCtx(sb)
    const { exec } = createResources(ctx)

    const r = await exec({
      command: "printenv FOO",
      env: { FOO: "bar" },
    })
    expect(r.status).toEqual("changed")
    expect(r.output!.stdout.trim()).toEqual("bar")
  })

  test("working directory (cwd)", async () => {
    const ctx = makeCtx(sb)
    const { exec } = createResources(ctx)

    const r = await exec({ command: "pwd", cwd: "/tmp" })
    expect(r.status).toEqual("changed")
    expect(r.output!.stdout.trim()).toEqual("/tmp")
  })

  test("check=false tolerates non-zero exit", async () => {
    const ctx = makeCtx(sb)
    const { exec } = createResources(ctx)

    const r = await exec({ command: "exit 42", check: false })
    expect(r.status).toEqual("changed")
    expect(r.output!.exitCode).toEqual(42)
  })

  test("stdin piping via raw connection", async () => {
    const input = "piped stdin content"
    const result = await sb.conn.exec("cat", { stdin: input })
    expect(result.exitCode).toEqual(0)
    expect(result.stdout.trim()).toEqual(input)
  })
})

if (SKIP) {
  console.log(
    "Set DENO_DEPLOY_TOKEN and IGNITION_RUN_SANDBOX_TESTS=1 to run resource integration tests",
  )
}
