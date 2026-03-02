/**
 * Bump version, run quality gate, git tag, and publish to npm.
 *
 * Usage:
 *   bun run publish          # defaults to patch bump
 *   bun run publish patch
 *   bun run publish minor
 *   bun run publish major
 *   bun run publish 1.2.3    # explicit version
 *
 * Flags:
 *   --dry-run   Show what would happen without making changes
 *   --no-git    Skip git commit and tag
 */

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { banner, fail, kv, pass, PROJECT_ROOT, run } from "./lib"

type Bump = "patch" | "minor" | "major"

function bumpVersion(current: string, bump: Bump): string {
  const parts = current.split(".").map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: ${current}`)
  }
  const [major, minor, patch] = parts
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`
    case "minor":
      return `${major}.${minor + 1}.0`
    case "patch":
      return `${major}.${minor}.${patch + 1}`
  }
}

function isExplicitVersion(s: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(s)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const noGit = args.includes("--no-git")
const positional = args.filter((a) => !a.startsWith("--"))

const input = positional[0] ?? "patch"

// Read current version
const pkgPath = join(PROJECT_ROOT, "package.json")
const pkgJson = JSON.parse(await readFile(pkgPath, "utf-8"))
const currentVersion: string = pkgJson.version

// Determine next version
let nextVersion: string
if (isExplicitVersion(input)) {
  nextVersion = input
} else if (["patch", "minor", "major"].includes(input)) {
  nextVersion = bumpVersion(currentVersion, input as Bump)
} else {
  fail(`Invalid bump argument: ${input}`)
  console.log("  Usage: bun run publish [patch|minor|major|x.y.z]")
  process.exit(1)
}

banner("Publish")
kv("current", currentVersion)
kv("next", nextVersion)
kv("dry-run", String(dryRun))
kv("git", String(!noGit))

if (dryRun) {
  console.log("\n  Dry run — stopping here.\n")
  process.exit(0)
}

// 1. Run quality gate
banner("Verify")
await run(["bun", "run", "verify"], "verify")
pass("Quality gate passed")

// 2. Bump version in package.json
banner("Bump version")
pkgJson.version = nextVersion
await writeFile(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`)
pass(`package.json → ${nextVersion}`)

// 3. Git commit + tag
if (!noGit) {
  banner("Git")
  await run(["git", "add", "package.json"], "git add")
  await run(["git", "commit", "-m", `chore(release): v${nextVersion}`], "git commit")
  await run(["git", "tag", "-a", `v${nextVersion}`, "-m", `v${nextVersion}`], "git tag")
  pass(`Tagged v${nextVersion}`)
}

// 4. Publish
banner("Publish to npm")
await run(["bun", "publish", "--access", "public"], "bun publish")
pass(`Published @grovemotorco/ignition@${nextVersion}`)

banner("Done")
