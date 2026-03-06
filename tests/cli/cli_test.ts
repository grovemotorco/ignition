import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = join(import.meta.dir, "../../src/cli.ts")

async function run(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Help and version
// ---------------------------------------------------------------------------

test("--help returns 0", async () => {
  const { code, stdout } = await run(["--help"])
  expect(code).toEqual(0)
  expect(stdout).toContain("ignition")
  expect(stdout).toContain("run")
  expect(stdout).toContain("dashboard")
  expect(stdout).not.toContain("\n  check ")
})

test("--version returns 0", async () => {
  const { code } = await run(["--version"])
  expect(code).toEqual(0)
})

test("no args shows help", async () => {
  const { code } = await run([])
  expect(code).toEqual(0)
})

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

test("unknown command returns non-zero", async () => {
  const { code } = await run(["deploy"])
  expect(code).not.toEqual(0)
})

test("run with missing args returns non-zero", async () => {
  const { code } = await run(["run"])
  expect(code).not.toEqual(0)
})

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

test("init --help returns 0", async () => {
  const { code } = await run(["init", "--help"])
  expect(code).toEqual(0)
})

// ---------------------------------------------------------------------------
// schema command routing
// ---------------------------------------------------------------------------

test("schema resources returns 0", async () => {
  const { code, stdout } = await run(["schema", "resources"])
  expect(code).toEqual(0)
  expect(stdout).toContain("exec")
})

test("schema --help returns 0", async () => {
  const { code, stdout } = await run(["schema", "--help"])
  expect(code).toEqual(0)
  expect(stdout).toContain("output")
  expect(stdout).not.toContain("\n  all ")
  expect(stdout).not.toContain("\n  cli ")
})

// ---------------------------------------------------------------------------
// dashboard command help
// ---------------------------------------------------------------------------

test("dashboard --help returns 0", async () => {
  const { code, stdout } = await run(["dashboard", "--help"])
  expect(code).toEqual(0)
  expect(stdout).toContain("--host")
  expect(stdout).toContain("--port")
  expect(stdout).toContain("--max-history")
  expect(stdout).not.toContain("history=<n>")
})

// ---------------------------------------------------------------------------
// run command — error cases
// ---------------------------------------------------------------------------

test("run with recipe but no targets returns non-zero", async () => {
  const { code } = await run(["run", "setup.ts"])
  expect(code).not.toEqual(0)
})

test("legacy check command returns non-zero", async () => {
  const { code, stdout } = await run(["check"])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("COMMAND_NOT_FOUND")
})

// ---------------------------------------------------------------------------
// --llms returns CLI manifest
// ---------------------------------------------------------------------------

test("--llms returns 0 and includes command info", async () => {
  const { code, stdout } = await run(["--llms"])
  expect(code).toEqual(0)
  expect(stdout).toContain("ignition")
})

// ---------------------------------------------------------------------------
// Config file error formatting
// ---------------------------------------------------------------------------

async function withConfig(
  configContent: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ignition-test-"))
  writeFileSync(join(dir, "ignition.config.ts"), configContent)
  try {
    return await run(args, { cwd: dir })
  } finally {
    await rm(dir, { recursive: true })
  }
}

test("invalid config format shows error", async () => {
  const { code, stdout } = await withConfig('export default { format: "xml" }\n', [
    "run",
    "--check",
    "setup.ts",
    "host",
  ])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("format")
})

test("invalid config parallelism shows error", async () => {
  const { code, stdout } = await withConfig("export default { parallelism: -1 }\n", [
    "run",
    "setup.ts",
    "host",
  ])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("parallelism")
})
