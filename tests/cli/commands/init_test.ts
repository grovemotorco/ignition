import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { initCommand } from "../../../src/cli/commands/init.ts"

async function withTempDir(fn: (tmpDir: string) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ign-"))
  const originalCwd = process.cwd()
  try {
    process.chdir(tmpDir)
    await fn(tmpDir)
  } finally {
    process.chdir(originalCwd)
    await rm(tmpDir, { recursive: true, force: true })
  }
}

async function readPackageJson(tmpDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(tmpDir, "package.json"), "utf-8")) as Record<
    string,
    unknown
  >
}

// ---------------------------------------------------------------------------
// Bootstrap + scaffold
// ---------------------------------------------------------------------------

test("init command bootstraps package.json and scaffolds files", async () => {
  await withTempDir(async (tmpDir) => {
    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(calls).toEqual([["bun", "add", "@grovemotorco/ignition@latest"]])

    const packageStat = await stat(join(tmpDir, "package.json"))
    const inventoryStat = await stat(join(tmpDir, "inventory.ts"))
    const configStat = await stat(join(tmpDir, "ignition.config.ts"))
    const recipeStat = await stat(join(tmpDir, "recipe.ts"))

    expect(packageStat.isFile()).toEqual(true)
    expect(inventoryStat.isFile()).toEqual(true)
    expect(configStat.isFile()).toEqual(true)
    expect(recipeStat.isFile()).toEqual(true)

    const pkg = await readPackageJson(tmpDir)
    expect(typeof pkg.name).toEqual("string")
    expect((pkg.name as string).startsWith("ign-")).toEqual(true)
    expect(pkg.private).toEqual(true)
    expect(pkg.type).toEqual("module")

    const dependencies = pkg.dependencies as Record<string, unknown>
    expect(dependencies["@grovemotorco/ignition"]).toEqual("latest")

    const recipeContent = await readFile(join(tmpDir, "recipe.ts"), "utf-8")
    expect(recipeContent.includes("ExecutionContext")).toEqual(true)
    expect(recipeContent.includes("export default")).toEqual(true)
  })
})

test("init command skips existing recipe/inventory files", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(join(tmpDir, "inventory.ts"), "existing content")
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "my-app",
          private: true,
          dependencies: {
            "@grovemotorco/ignition": "^1.2.3",
          },
        },
        null,
        2,
      ),
    )

    let runCalled = false
    const code = await initCommand({
      runCommand: async () => {
        runCalled = true
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(runCalled).toEqual(false)

    const inventoryContent = await readFile(join(tmpDir, "inventory.ts"), "utf-8")
    expect(inventoryContent).toEqual("existing content")

    const recipeStat = await stat(join(tmpDir, "recipe.ts"))
    expect(recipeStat.isFile()).toEqual(true)
  })
})

// ---------------------------------------------------------------------------
// Dependency handling
// ---------------------------------------------------------------------------

test("init command adds dependency when package.json exists but dependency is missing", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "my-app",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    )

    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(calls).toEqual([["bun", "add", "@grovemotorco/ignition@latest"]])

    const pkg = await readPackageJson(tmpDir)
    const dependencies = pkg.dependencies as Record<string, unknown>
    expect(dependencies["@grovemotorco/ignition"]).toEqual("latest")
  })
})

test("init command treats devDependencies as already satisfied", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "my-app",
          private: true,
          devDependencies: {
            "@grovemotorco/ignition": "^1.2.3",
          },
        },
        null,
        2,
      ),
    )

    let runCalled = false
    const code = await initCommand({
      runCommand: async () => {
        runCalled = true
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(runCalled).toEqual(false)
  })
})

test("init command skips dependency injection for @grovemotorco/ignition package itself", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "@grovemotorco/ignition",
          private: true,
        },
        null,
        2,
      ),
    )

    let runCalled = false
    const code = await initCommand({
      runCommand: async () => {
        runCalled = true
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(runCalled).toEqual(false)

    const pkg = await readPackageJson(tmpDir)
    const dependencies = pkg.dependencies as Record<string, unknown> | undefined
    expect(dependencies?.["@grovemotorco/ignition"]).toEqual(undefined)
  })
})

// ---------------------------------------------------------------------------
// Package manager selection
// ---------------------------------------------------------------------------

test("init command detects pnpm from lockfile", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'")
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "my-app" }))

    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(calls).toEqual([["pnpm", "add", "@grovemotorco/ignition@latest"]])
  })
})

test("init command detects yarn from lockfile", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(join(tmpDir, "yarn.lock"), "")
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "my-app" }))

    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(calls).toEqual([["yarn", "add", "@grovemotorco/ignition@latest"]])
  })
})

test("init command detects npm from lockfile", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(join(tmpDir, "package-lock.json"), "{}")
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "my-app" }))

    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(calls).toEqual([["npm", "install", "@grovemotorco/ignition@latest"]])
  })
})

test("init command prefers bun when multiple lockfiles exist", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(join(tmpDir, "bun.lock"), "")
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'")
    await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "my-app" }))

    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 0
      },
    })

    expect(code).toEqual(0)
    expect(calls).toEqual([["bun", "add", "@grovemotorco/ignition@latest"]])
  })
})

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

test("init command writes embedded library when install fails", async () => {
  await withTempDir(async (tmpDir) => {
    const calls: string[][] = []
    const code = await initCommand({
      runCommand: async (cmd) => {
        calls.push([...cmd])
        return 1 // install fails
      },
      getEmbeddedLibrary: () => "export const foo = 42\n",
    })

    expect(code).toEqual(0)
    expect(calls.length).toEqual(1)
    expect(calls[0]).toEqual(["bun", "add", "@grovemotorco/ignition@latest"])

    // Verify embedded lib was written to node_modules
    const libContent = await readFile(
      join(tmpDir, "node_modules", "@grovemotorco", "ignition", "index.js"),
      "utf-8",
    )
    expect(libContent).toEqual("export const foo = 42\n")

    const libPkg = JSON.parse(
      await readFile(
        join(tmpDir, "node_modules", "@grovemotorco", "ignition", "package.json"),
        "utf-8",
      ),
    )
    expect(libPkg.name).toEqual("@grovemotorco/ignition")
    expect(libPkg.type).toEqual("module")

    const recipeStat = await stat(join(tmpDir, "recipe.ts"))
    expect(recipeStat.isFile()).toEqual(true)
  })
})

test("init command returns 1 when install fails and no embedded library", async () => {
  await withTempDir(async (tmpDir) => {
    const code = await initCommand({
      runCommand: async () => 2,
      getEmbeddedLibrary: () => null,
    })

    expect(code).toEqual(1)

    const recipeStat = await stat(join(tmpDir, "recipe.ts"))
    const inventoryStat = await stat(join(tmpDir, "inventory.ts"))
    expect(recipeStat.isFile()).toEqual(true)
    expect(inventoryStat.isFile()).toEqual(true)
  })
})

test("init command returns 1 for invalid package.json", async () => {
  await withTempDir(async (tmpDir) => {
    await writeFile(join(tmpDir, "package.json"), "{invalid json")

    let runCalled = false
    const code = await initCommand({
      runCommand: async () => {
        runCalled = true
        return 0
      },
    })

    expect(code).toEqual(1)
    expect(runCalled).toEqual(false)
    expect(await Bun.file(join(tmpDir, "recipe.ts")).exists()).toEqual(false)
  })
})
