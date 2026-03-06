import { test, expect } from "bun:test"
import { join } from "node:path"

const CLI = join(import.meta.dir, "../../../src/cli.ts")

/** Resolve a fixture inventory path to an absolute file path. */
function fixturePath(name: string): string {
  return join(import.meta.dir, "../../fixtures/inventories", name)
}

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
// No file specified
// ---------------------------------------------------------------------------

test("inventory command returns non-zero when no file specified", async () => {
  const { code, stdout } = await run(["inventory"])
  expect(code).not.toEqual(0)
  expect(stdout).toContain("NO_INVENTORY")
})

// ---------------------------------------------------------------------------
// Uses --inventory option when no positional file
// ---------------------------------------------------------------------------

test("inventory command uses --inventory option", async () => {
  const { code } = await run(["inventory", "--inventory", fixturePath("valid_inventory.ts")])
  expect(code).toEqual(0)
})

test("inventory --help shows trace flag", async () => {
  const { code, stdout } = await run(["inventory", "--help"])
  expect(code).toEqual(0)
  expect(stdout).toContain("--trace")
})

// ---------------------------------------------------------------------------
// Loads and displays inventory
// ---------------------------------------------------------------------------

test("inventory command loads and displays inventory", async () => {
  const { code, stdout } = await run(["inventory", fixturePath("valid_inventory.ts")])
  expect(code).toEqual(0)
  expect(stdout).toContain("web-1")
  expect(stdout).toContain("10.0.1.10")
})

test("inventory command supports json format", async () => {
  const { code, stdout } = await run([
    "inventory",
    fixturePath("valid_inventory.ts"),
    "--format",
    "json",
  ])
  expect(code).toEqual(0)
  const inv = JSON.parse(stdout)
  expect(inv.groups.web.hosts["web-1"].hostname).toEqual("10.0.1.10")
  expect(inv.hosts.bastion.hostname).toEqual("203.0.113.1")
})

test("inventory command loads minimal inventory", async () => {
  const { code, stdout } = await run([
    "inventory",
    fixturePath("minimal_inventory.ts"),
    "--format",
    "json",
  ])
  expect(code).toEqual(0)
  const inv = JSON.parse(stdout)
  expect(inv.hosts["server-1"].hostname).toEqual("192.168.1.100")
})
