import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTargets } from "../../../src/inventory/loader.ts"

const CLI = join(import.meta.dir, "../../../src/cli.ts")

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
// resolveTargets unit test
// ---------------------------------------------------------------------------

test("resolveTargets throws InventoryError for unknown group target", () => {
  expect(() => resolveTargets({}, ["@web"])).toThrow()
})

// ---------------------------------------------------------------------------
// CLI routing — run command
// ---------------------------------------------------------------------------

test("run with no args returns non-zero", async () => {
  const { code } = await run(["run"])
  expect(code).not.toEqual(0)
})

test("run with recipe but no targets returns non-zero", async () => {
  const { code } = await run(["run", "setup.ts"])
  expect(code).not.toEqual(0)
})

test("run --help returns 0", async () => {
  const { code, stdout } = await run(["run", "--help"])
  expect(code).toEqual(0)
  expect(stdout).toContain("recipe")
  expect(stdout).toContain("--check")
  expect(stdout).toContain("--trace")
  expect(stdout).toContain("--dashboard-host")
  expect(stdout).toContain("--dashboard-port")
})

test("run --schema returns schema", async () => {
  const { code, stdout } = await run(["run", "--schema"])
  expect(code).toEqual(0)
  expect(stdout).toContain("recipe")
  expect(stdout).toContain("targets")
  expect(stdout).toContain("check")
  expect(stdout).toContain("dashboardHost")
  expect(stdout).toContain("dashboardPort")
})

test("run failure preserves structured summary output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ignition-run-test-"))
  const recipe = join(import.meta.dir, "../../fixtures/recipes/valid_recipe.ts")

  try {
    const { code, stdout } = await run(
      ["run", "--check", recipe, "root@127.0.0.1:1", "--format", "json"],
      { cwd },
    )

    expect(code).toEqual(1)

    const summary = JSON.parse(stdout)
    expect(summary.mode).toEqual("check")
    expect(summary.hasFailures).toEqual(true)
    expect(summary.hosts).toHaveLength(1)
    expect(summary.hosts[0]?.name).toEqual("root@127.0.0.1:1")
    expect(summary.hosts[0]?.failed).toBeGreaterThan(0)
  } finally {
    await rm(cwd, { recursive: true })
  }
})
