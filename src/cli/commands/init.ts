import { Cli } from "incur"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileExists } from "../../lib/fs.ts"
import { loggerVarsSchema } from "../logger.ts"

const EXAMPLE_INVENTORY = `import type { Inventory } from '@grovemotorco/ignition'

const inventory: Inventory = {
\tdefaults: {
\t\tport: 22,
\t},
\tvars: {
\t\tenv: 'production',
\t},
\thosts: {
    'target': {
      hostname: 'ssh.hostname.net',
      user: 'my-user',
    },
  },
}

export default inventory
`

const EXAMPLE_CONFIG = `import type { IgnitionConfig } from '@grovemotorco/ignition'

const config: IgnitionConfig = {
\tinventory: 'inventory.ts',
\ttrace: true,
}

export default config
`

const EXAMPLE_RECIPE = `import type { ExecutionContext } from '@grovemotorco/ignition'
import { createResources } from '@grovemotorco/ignition'

export const meta = {
\tdescription: 'Example recipe — uname',
\ttags: ['hello-world', 'uname'],
}

export default async function (ctx: ExecutionContext) {
\tconst { exec } = createResources(ctx)

\tawait exec({command:'uname -a'})
}
`

const PACKAGE_JSON_FILE = "package.json"
const IGNITION_PACKAGE = "@grovemotorco/ignition"
const DEFAULT_DEPENDENCY_SPEC = "latest"

type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

type PackageJson = {
  name?: string | undefined
  private?: boolean | undefined
  type?: string | undefined
  dependencies?: Record<string, unknown> | undefined
  devDependencies?: Record<string, unknown> | undefined
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizePackageName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "")
  return cleaned.length > 0 ? cleaned : "ignition-project"
}

async function writePackageJson(pkg: PackageJson): Promise<void> {
  await writeFile(PACKAGE_JSON_FILE, `${JSON.stringify(pkg, null, 2)}\n`)
}

async function ensureProjectPackageJson(): Promise<{ pkg: PackageJson; created: boolean }> {
  if (!(await fileExists(PACKAGE_JSON_FILE))) {
    const pkg: PackageJson = {
      name: sanitizePackageName(basename(process.cwd())),
      private: true,
      type: "module",
    }
    await writePackageJson(pkg)
    return { pkg, created: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(PACKAGE_JSON_FILE, "utf-8"))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse ${PACKAGE_JSON_FILE}: ${message}`)
  }

  if (!isRecord(parsed)) {
    throw new Error(`${PACKAGE_JSON_FILE} must contain a JSON object`)
  }

  return { pkg: parsed as PackageJson, created: false }
}

function hasIgnitionDependency(pkg: PackageJson): boolean {
  if (isRecord(pkg.dependencies) && typeof pkg.dependencies[IGNITION_PACKAGE] === "string") {
    return true
  }
  if (isRecord(pkg.devDependencies) && typeof pkg.devDependencies[IGNITION_PACKAGE] === "string") {
    return true
  }
  return false
}

async function ensureIgnitionDependency(pkg: PackageJson): Promise<"self" | "present" | "added"> {
  if (pkg.name === IGNITION_PACKAGE) return "self"
  if (hasIgnitionDependency(pkg)) return "present"

  const dependencies = isRecord(pkg.dependencies) ? { ...pkg.dependencies } : {}
  dependencies[IGNITION_PACKAGE] = DEFAULT_DEPENDENCY_SPEC
  pkg.dependencies = dependencies
  await writePackageJson(pkg)
  return "added"
}

async function detectPackageManager(): Promise<PackageManager> {
  const lockfiles: Array<{ manager: PackageManager; files: string[] }> = [
    { manager: "bun", files: ["bun.lock", "bun.lockb"] },
    { manager: "pnpm", files: ["pnpm-lock.yaml"] },
    { manager: "yarn", files: ["yarn.lock"] },
    { manager: "npm", files: ["package-lock.json", "npm-shrinkwrap.json"] },
  ]

  for (const { manager, files } of lockfiles) {
    for (const file of files) {
      if (await fileExists(file)) return manager
    }
  }
  return "bun"
}

function getInstallCommand(manager: PackageManager): string[] {
  switch (manager) {
    case "bun":
      return ["bun", "add", `${IGNITION_PACKAGE}@${DEFAULT_DEPENDENCY_SPEC}`]
    case "pnpm":
      return ["pnpm", "add", `${IGNITION_PACKAGE}@${DEFAULT_DEPENDENCY_SPEC}`]
    case "yarn":
      return ["yarn", "add", `${IGNITION_PACKAGE}@${DEFAULT_DEPENDENCY_SPEC}`]
    case "npm":
      return ["npm", "install", `${IGNITION_PACKAGE}@${DEFAULT_DEPENDENCY_SPEC}`]
  }
}

function getEmbeddedLibrary(): string | null {
  try {
    const libPath = join(dirname(process.execPath), "ignition-lib.js")
    return readFileSync(libPath, "utf-8")
  } catch {
    return null
  }
}

async function writeEmbeddedLibraryToNodeModules(content: string): Promise<boolean> {
  try {
    const pkgDir = join("node_modules", "@grovemotorco", "ignition")
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, "package.json"),
      `${JSON.stringify({ name: IGNITION_PACKAGE, main: "index.js", type: "module" }, null, 2)}\n`,
    )
    await writeFile(join(pkgDir, "index.js"), content)
    return true
  } catch {
    return false
  }
}

function runInstallCommand(command: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

/** CLI command that scaffolds a starter Ignition project in the current directory. */
export const init = Cli.create("init", {
  description: "Scaffold a new Ignition project",
  vars: loggerVarsSchema,
  async *run(c) {
    let installFailed = false
    const logger = c.var.logger

    // 1. Ensure package.json
    let pkg: PackageJson
    try {
      const ensured = await ensureProjectPackageJson()
      pkg = ensured.pkg
      if (ensured.created) {
        yield "create  package.json"
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.error({ code: "INIT_FAILED", message })
    }

    // 2. Ensure dependency
    const dependencyState = await ensureIgnitionDependency(pkg)
    switch (dependencyState) {
      case "self":
        yield `skip  ${IGNITION_PACKAGE} dependency (current package is ${IGNITION_PACKAGE})`
        break
      case "present":
        yield `skip  ${IGNITION_PACKAGE} dependency (already present)`
        break
      case "added": {
        yield `update  package.json (add ${IGNITION_PACKAGE}@${DEFAULT_DEPENDENCY_SPEC})`
        const manager = await detectPackageManager()
        const installCmd = getInstallCommand(manager)
        yield `install  ${installCmd.join(" ")}`

        let installExit = 1
        try {
          installExit = await runInstallCommand(installCmd)
        } catch {
          // install failed -- will try embedded fallback
        }

        if (installExit !== 0) {
          const embeddedLib = getEmbeddedLibrary()
          if (embeddedLib) {
            yield `embed  writing bundled ${IGNITION_PACKAGE} to node_modules/`
            const written = await writeEmbeddedLibraryToNodeModules(embeddedLib)
            if (!written) {
              installFailed = true
              logger.writeln(`Failed to write embedded ${IGNITION_PACKAGE} to node_modules/`)
            }
          } else {
            installFailed = true
            logger.writeln(`Could not install ${IGNITION_PACKAGE}. Run manually:`)
            logger.writeln(`  ${installCmd.join(" ")}`)
          }
        }
        break
      }
    }

    // 3. Scaffold files
    const files: Array<{ path: string; content: string; label: string }> = [
      { path: "ignition.config.ts", content: EXAMPLE_CONFIG, label: "ignition.config.ts" },
      { path: "inventory.ts", content: EXAMPLE_INVENTORY, label: "inventory.ts" },
      { path: "recipe.ts", content: EXAMPLE_RECIPE, label: "recipe.ts" },
    ]

    let created = 0
    for (const { path, content, label } of files) {
      if (await fileExists(path)) {
        yield `skip  ${label} (already exists)`
        continue
      }
      await writeFile(path, content)
      yield `create  ${label}`
      created++
    }

    if (created === 0) {
      yield "Nothing to create -- all files already exist."
    }

    if (installFailed) {
      return c.error({
        code: "INIT_FAILED",
        message: "Init completed with errors. Dependency installation failed.",
      })
    }

    return c.ok(undefined, {
      cta: {
        commands: [
          { command: "run recipe.ts @all", description: "Run the example recipe" },
          { command: "run --check recipe.ts @all", description: "Dry-run the example recipe" },
        ],
      },
    })
  },
})
