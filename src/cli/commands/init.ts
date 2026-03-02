import { Command } from "@cliffy/command"
import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { CliExitCode } from "../runtime.ts"

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
\tverbose: true,
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

interface PackageJson {
  name?: string
  private?: boolean
  type?: string
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  [key: string]: unknown
}

type DependencyState = "self" | "present" | "added"
type CommandRunner = (command: readonly string[]) => Promise<number>

export interface InitCommandDeps {
  runCommand?: CommandRunner
  getEmbeddedLibrary?: () => string | null
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
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
  await Bun.write(PACKAGE_JSON_FILE, `${JSON.stringify(pkg, null, 2)}\n`)
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
    parsed = JSON.parse(await Bun.file(PACKAGE_JSON_FILE).text())
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

async function ensureIgnitionDependency(pkg: PackageJson): Promise<DependencyState> {
  if (pkg.name === IGNITION_PACKAGE) {
    return "self"
  }
  if (hasIgnitionDependency(pkg)) {
    return "present"
  }

  const dependencies = isRecord(pkg.dependencies) ? { ...pkg.dependencies } : {}
  dependencies[IGNITION_PACKAGE] = DEFAULT_DEPENDENCY_SPEC
  pkg.dependencies = dependencies
  await writePackageJson(pkg)
  return "added"
}

async function detectPackageManager(): Promise<PackageManager> {
  const lockfiles: Array<{ manager: PackageManager; files: readonly string[] }> = [
    { manager: "bun", files: ["bun.lock", "bun.lockb"] },
    { manager: "pnpm", files: ["pnpm-lock.yaml"] },
    { manager: "yarn", files: ["yarn.lock"] },
    { manager: "npm", files: ["package-lock.json", "npm-shrinkwrap.json"] },
  ]

  for (const { manager, files } of lockfiles) {
    for (const file of files) {
      if (await fileExists(file)) {
        return manager
      }
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

function defaultGetEmbeddedLibrary(): string | null {
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
    await Bun.write(
      join(pkgDir, "package.json"),
      `${JSON.stringify({ name: IGNITION_PACKAGE, main: "index.js", type: "module" }, null, 2)}\n`,
    )
    await Bun.write(join(pkgDir, "index.js"), content)
    return true
  } catch {
    return false
  }
}

async function runInstallCommand(command: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...command], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  return await proc.exited
}

async function scaffoldFiles(): Promise<number> {
  const files: Array<{ path: string; content: string; label: string }> = [
    { path: "ignition.config.ts", content: EXAMPLE_CONFIG, label: "ignition.config.ts" },
    { path: "inventory.ts", content: EXAMPLE_INVENTORY, label: "inventory.ts" },
    { path: "recipe.ts", content: EXAMPLE_RECIPE, label: "recipe.ts" },
  ]

  let created = 0
  for (const { path, content, label } of files) {
    if (await fileExists(path)) {
      console.log(`  skip  ${label} (already exists)`)
      continue
    }
    await Bun.write(path, content)
    console.log(`  create  ${label}`)
    created++
  }

  if (created > 0) {
    console.log("\nNext steps:")
    console.log("  1. Edit inventory.ts with your server hostnames and SSH credentials")
    console.log("  2. Edit recipe.ts with the packages and config you want to provision")
    console.log("  3. Dry-run:  ignition check recipe.ts @web")
    console.log("  4. Apply:    ignition run recipe.ts @web")
  } else {
    console.log("\nNothing to create — all files already exist.")
  }

  return created
}

export async function initCommand(deps: InitCommandDeps = {}): Promise<number> {
  const externalCommandRunner = deps.runCommand ?? runInstallCommand
  const getEmbeddedLibrary = deps.getEmbeddedLibrary ?? defaultGetEmbeddedLibrary
  let installFailed = false

  let pkg: PackageJson
  try {
    const ensured = await ensureProjectPackageJson()
    pkg = ensured.pkg
    if (ensured.created) {
      console.log("  create  package.json")
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(message)
    return 1
  }

  const dependencyState = await ensureIgnitionDependency(pkg)
  switch (dependencyState) {
    case "self":
      console.log(`  skip  ${IGNITION_PACKAGE} dependency (current package is ${IGNITION_PACKAGE})`)
      break
    case "present":
      console.log(`  skip  ${IGNITION_PACKAGE} dependency (already present)`)
      break
    case "added": {
      console.log(`  update  package.json (add ${IGNITION_PACKAGE}@${DEFAULT_DEPENDENCY_SPEC})`)
      const manager = await detectPackageManager()
      const installCommand = getInstallCommand(manager)
      console.log(`  install  ${installCommand.join(" ")}`)

      let installExit = 1
      try {
        installExit = await externalCommandRunner(installCommand)
      } catch {
        // install failed — will try embedded fallback below
      }

      if (installExit !== 0) {
        const embeddedLib = getEmbeddedLibrary()
        if (embeddedLib) {
          console.log(`  embed  writing bundled ${IGNITION_PACKAGE} to node_modules/`)
          const written = await writeEmbeddedLibraryToNodeModules(embeddedLib)
          if (!written) {
            installFailed = true
            console.error(`Failed to write embedded ${IGNITION_PACKAGE} to node_modules/`)
          }
        } else {
          installFailed = true
          console.error(`Could not install ${IGNITION_PACKAGE}. Run manually:`)
          console.error(`  ${installCommand.join(" ")}`)
        }
      }
      break
    }
  }

  await scaffoldFiles()

  if (installFailed) {
    console.error("\nInit completed with errors. Dependency installation failed.")
    return 1
  }

  return 0
}

export const init = new Command()
  .description("Scaffold a new Ignition project.")
  .action(async () => {
    const code = await initCommand()
    if (code !== 0) throw new CliExitCode(code)
  })
