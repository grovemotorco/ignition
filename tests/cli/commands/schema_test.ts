import { test, expect } from "bun:test"
import { join } from "node:path"

const CLI = join(import.meta.dir, "../../../src/cli.ts")

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

// ---------------------------------------------------------------------------
// schema resources
// ---------------------------------------------------------------------------

test("schema resources returns 0 and lists all resource types", async () => {
  const { code, stdout } = await run(["schema", "resources"])
  expect(code).toEqual(0)
  for (const type of ["exec", "file", "apt", "service", "directory"]) {
    expect(stdout).toContain(type)
  }
})

test("schema resources --format json returns valid JSON with all 5 resources", async () => {
  const { code, stdout } = await run(["schema", "resources", "--format", "json"])
  expect(code).toEqual(0)
  const obj = JSON.parse(stdout)
  expect(Object.keys(obj).sort()).toEqual(["apt", "directory", "exec", "file", "service"])
})

// ---------------------------------------------------------------------------
// schema resource <name>
// ---------------------------------------------------------------------------

test("schema resource exec returns exec schema", async () => {
  const { code, stdout } = await run(["schema", "resource", "exec", "--format", "json"])
  expect(code).toEqual(0)
  const schema = JSON.parse(stdout)
  expect(schema.nature).toEqual("imperative")
  expect(schema.description).toContain("command")
  expect(schema.annotations.destructive).toEqual(true)
})

test("schema resource bogus returns non-zero with error", async () => {
  const { code, stdout } = await run(["schema", "resource", "bogus"])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("UNKNOWN_RESOURCE")
})

// ---------------------------------------------------------------------------
// schema recipe
// ---------------------------------------------------------------------------

test("schema recipe returns valid recipe format", async () => {
  const { code, stdout } = await run(["schema", "recipe", "--format", "json"])
  expect(code).toEqual(0)
  const recipe = JSON.parse(stdout)
  expect(recipe.format).toEqual("typescript")
  expect(recipe.defaultExport).toBeDefined()
  expect(recipe.pattern).toBeDefined()
})

// ---------------------------------------------------------------------------
// schema inventory
// ---------------------------------------------------------------------------

test("schema inventory returns valid inventory format", async () => {
  const { code, stdout } = await run(["schema", "inventory", "--format", "json"])
  expect(code).toEqual(0)
  const inv = JSON.parse(stdout)
  expect(inv.format).toEqual("typescript")
  expect(inv.targetSyntax).toBeDefined()
  expect(inv.variablePrecedence).toBeDefined()
})

// ---------------------------------------------------------------------------
// schema output
// ---------------------------------------------------------------------------

test("schema output returns valid output schema", async () => {
  const { code, stdout } = await run(["schema", "output", "--format", "json"])
  expect(code).toEqual(0)
  const output = JSON.parse(stdout)
  expect(output.successEnvelope).toBeDefined()
  expect(output.resourceResult).toBeDefined()
  expect(output.errorSerialization).toBeDefined()
})

// ---------------------------------------------------------------------------
// schema --help
// ---------------------------------------------------------------------------

test("schema --help returns 0", async () => {
  const { code, stdout } = await run(["schema", "--help"])
  expect(code).toEqual(0)
  expect(stdout).toContain("output")
  expect(stdout).not.toContain("\n  all ")
  expect(stdout).not.toContain("\n  cli ")
})

test("schema all returns non-zero", async () => {
  const { code, stdout } = await run(["schema", "all"])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("COMMAND_NOT_FOUND")
})

test("schema cli returns non-zero", async () => {
  const { code, stdout } = await run(["schema", "cli"])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("COMMAND_NOT_FOUND")
})
