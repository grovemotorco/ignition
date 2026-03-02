/**
 * Install Ignition CLI globally from source.
 *
 * 1. Bundles `src/index.ts` into `dist/ignition-lib.js` (self-contained library)
 * 2. Compiles `src/cli.ts` into a standalone executable
 * 3. Symlinks the binary into `~/.local/bin/`
 *
 * The embedded library bundle allows `ignition init` to bootstrap projects
 * without requiring the package to be published to npm.
 *
 * Usage: bun run scripts/install.ts
 *        bun run scripts/install.ts --uninstall
 */

import { existsSync } from "node:fs"
import { mkdir, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { bundleLibrary, compileBinary, DIST_BINARY } from "./lib.ts"

const installDir = join(homedir(), ".local", "bin")
const installPath = join(installDir, "ignition")

async function uninstall(): Promise<void> {
  if (existsSync(installPath)) {
    await unlink(installPath)
    console.log(`Removed ${installPath}`)
  } else {
    console.log(`Nothing to remove (${installPath} does not exist)`)
  }
}

async function install(): Promise<void> {
  await bundleLibrary()
  await compileBinary()

  await mkdir(installDir, { recursive: true })

  if (existsSync(installPath)) {
    await unlink(installPath)
  }

  await symlink(DIST_BINARY, installPath)
  console.log(`Installed: ${installPath} -> ${DIST_BINARY}`)

  // Check if install dir is on PATH
  const pathDirs = (process.env.PATH ?? "").split(":")
  if (!pathDirs.includes(installDir)) {
    console.log(`\nNote: ${installDir} is not on your PATH.`)
    console.log(`Add it with: export PATH="${installDir}:$PATH"`)
  }
}

if (process.argv.includes("--uninstall")) {
  await uninstall()
} else {
  await install()
}
