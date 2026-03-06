import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFileSync } from "node:fs"

const CLI = join(import.meta.dir, "../../../src/cli.ts")

async function runInit(opts?: {
  cwd?: string
  args?: string[]
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, "init", ...(opts?.args ?? [])], {
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

async function withTempDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ign-init-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readPackageJson(tmpDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(tmpDir, "package.json"), "utf-8")) as Record<
    string,
    unknown
  >
}

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

test("init --help returns 0", async () => {
  const { code, stdout } = await runInit({ args: ["--help"] })
  expect(code).toEqual(0)
  expect(stdout).toContain("Scaffold a new Ignition project")
})

// ---------------------------------------------------------------------------
// Bootstrap + scaffold
// ---------------------------------------------------------------------------

test("init bootstraps package.json and scaffolds files", async () => {
  await withTempDir(async (tmpDir) => {
    await runInit({ cwd: tmpDir })
    // install will fail (no registry), but scaffolding should still succeed

    const packageExists = await Bun.file(join(tmpDir, "package.json")).exists()
    expect(packageExists).toEqual(true)

    const configExists = await Bun.file(join(tmpDir, "ignition.config.ts")).exists()
    expect(configExists).toEqual(true)

    const inventoryExists = await Bun.file(join(tmpDir, "inventory.ts")).exists()
    expect(inventoryExists).toEqual(true)

    const recipeExists = await Bun.file(join(tmpDir, "recipe.ts")).exists()
    expect(recipeExists).toEqual(true)

    const pkg = await readPackageJson(tmpDir)
    expect(pkg.private).toEqual(true)
    expect(pkg.type).toEqual("module")

    const recipeContent = await readFile(join(tmpDir, "recipe.ts"), "utf-8")
    expect(recipeContent).toContain("ExecutionContext")
    expect(recipeContent).toContain("export default")
  })
})

test("init skips existing files", async () => {
  await withTempDir(async (tmpDir) => {
    writeFileSync(join(tmpDir, "inventory.ts"), "existing content")
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        private: true,
        dependencies: { "@grovemotorco/ignition": "^1.2.3" },
      }),
    )

    const { code, stdout } = await runInit({ cwd: tmpDir })
    expect(code).toEqual(0)

    // Should mention skipping
    expect(stdout).toContain("skip")

    // inventory.ts should be unchanged
    const content = await readFile(join(tmpDir, "inventory.ts"), "utf-8")
    expect(content).toEqual("existing content")

    // recipe.ts should still be created
    const recipeStat = await stat(join(tmpDir, "recipe.ts"))
    expect(recipeStat.isFile()).toEqual(true)
  })
})

// ---------------------------------------------------------------------------
// Dependency handling
// ---------------------------------------------------------------------------

test("init skips install when dependency already present", async () => {
  await withTempDir(async (tmpDir) => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "my-app",
        private: true,
        dependencies: { "@grovemotorco/ignition": "^1.0.0" },
      }),
    )

    const { code, stdout } = await runInit({ cwd: tmpDir })
    expect(code).toEqual(0)
    expect(stdout).toContain("skip")
    expect(stdout).toContain("already present")
  })
})

test("init skips dependency for @grovemotorco/ignition package itself", async () => {
  await withTempDir(async (tmpDir) => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "@grovemotorco/ignition", private: true }),
    )

    const { code, stdout } = await runInit({ cwd: tmpDir })
    expect(code).toEqual(0)
    expect(stdout).toContain("skip")
    expect(stdout).toContain("current package")
  })
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

test("init reports error for invalid package.json", async () => {
  await withTempDir(async (tmpDir) => {
    writeFileSync(join(tmpDir, "package.json"), "{invalid json")

    const { code, stdout } = await runInit({ cwd: tmpDir })
    expect(code).not.toEqual(0)
    expect(stdout).toContain("parse")
  })
})
