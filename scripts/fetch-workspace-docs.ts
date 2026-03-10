#!/usr/bin/env bun
/**
 * Standalone docs fetcher for repos outside the workspace.
 *
 * Populates .docs/ from the workspace GitHub repo via sparse checkout
 * into a shared cache at ~/.grove/docs-cache/. When inside the workspace,
 * the existing symlink approach takes precedence — this script exits early.
 *
 * Usage:
 *   bun scripts/fetch-docs.ts             # clone cache if missing, link .docs/
 *   bun scripts/fetch-docs.ts --refresh   # update cache to latest
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, rmSync, appendFileSync } from "node:fs"
import { resolve, basename } from "node:path"
import { homedir } from "node:os"

const REPO_URL = "https://github.com/grovemotorco/workspace.git"

const PROJECT_DIRS = ["context", "issues", "decisions"] as const
const WORKSPACE_DIRS = ["context", "decisions", "issues"] as const

const CACHE_DIR = resolve(homedir(), ".grove", "docs-cache")
const REPO_ROOT = resolve(import.meta.dir, "..")
const DOCS_DIR = resolve(REPO_ROOT, ".docs")

const refreshFlag = process.argv.includes("--refresh")

// ── Step 1: Exit early if .docs/ has working workspace symlinks ──

function isWorkspaceLinked(): boolean {
  try {
    if (!lstatSync(DOCS_DIR).isDirectory()) return false
    for (const dir of PROJECT_DIRS) {
      const p = resolve(DOCS_DIR, dir)
      try {
        const s = lstatSync(p)
        if (s.isSymbolicLink()) {
          const real = Bun.spawnSync(["readlink", p]).stdout.toString().trim()
          if (!real.includes(".grove")) return true
        }
      } catch {
        continue
      }
    }
  } catch {
    // .docs doesn't exist
  }
  return false
}

if (isWorkspaceLinked()) {
  console.log("✓ .docs/ already linked via workspace — skipping fetch")
  process.exit(0)
}

// ── Step 2: Detect project name ──

function detectProject(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"))
    const name: string = pkg.name ?? ""
    const slash = name.lastIndexOf("/")
    if (slash !== -1) return name.slice(slash + 1)
    if (name) return name
  } catch {
    // no package.json
  }
  return basename(REPO_ROOT)
}

const project = detectProject()
console.log(`Project: ${project}`)

// ── Step 3: Clone or refresh cache ──

function cloneCache(): boolean {
  console.log("Cloning docs cache...")
  mkdirSync(resolve(homedir(), ".grove"), { recursive: true })

  const result = Bun.spawnSync(
    ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO_URL, CACHE_DIR],
    { stderr: "pipe" },
  )

  if (result.exitCode !== 0) return false

  Bun.spawnSync(["git", "sparse-checkout", "set", "docs/"], { cwd: CACHE_DIR })
  return true
}

function refreshCache(): boolean {
  console.log("Refreshing docs cache...")

  const result = Bun.spawnSync(["git", "fetch", "--depth", "1", "origin", "main"], {
    cwd: CACHE_DIR,
    stderr: "pipe",
  })

  if (result.exitCode !== 0) {
    console.warn("⚠ Could not refresh cache (fetch failed)")
    return false
  }

  Bun.spawnSync(["git", "reset", "--hard", "origin/main"], { cwd: CACHE_DIR })
  return true
}

let cacheReady = false

if (existsSync(resolve(CACHE_DIR, ".git"))) {
  if (refreshFlag) {
    cacheReady = refreshCache()
  } else {
    cacheReady = true
    console.log("✓ Using existing docs cache")
  }
} else {
  if (existsSync(CACHE_DIR)) {
    rmSync(CACHE_DIR, { recursive: true })
  }
  cacheReady = cloneCache()
}

if (!cacheReady) {
  console.error("✗ Could not clone docs cache. Check your git credentials and try again.")
  process.exit(0) // non-fatal — repo works without docs
}

// ── Step 4: Create .docs/ symlinks into cache ──

function createLink(target: string, linkPath: string) {
  try {
    const s = lstatSync(linkPath)
    if (s.isSymbolicLink() || s.isFile()) unlinkSync(linkPath)
    else if (s.isDirectory()) rmSync(linkPath, { recursive: true })
  } catch {
    // doesn't exist
  }
  mkdirSync(resolve(linkPath, ".."), { recursive: true })
  symlinkSync(target, linkPath)
}

// Clean existing .docs/ if it's not a workspace link
try {
  const s = lstatSync(DOCS_DIR)
  if (s.isDirectory() || s.isSymbolicLink()) {
    rmSync(DOCS_DIR, { recursive: true, force: true })
  }
} catch {
  // doesn't exist
}

mkdirSync(DOCS_DIR, { recursive: true })

let linked = 0
for (const dir of PROJECT_DIRS) {
  const target = resolve(CACHE_DIR, "docs", project, dir)
  if (!existsSync(target)) continue
  createLink(target, resolve(DOCS_DIR, dir))
  linked++
}

for (const dir of WORKSPACE_DIRS) {
  const target = resolve(CACHE_DIR, "docs", "workspace", dir)
  if (!existsSync(target)) continue
  createLink(target, resolve(DOCS_DIR, "workspace", dir))
  linked++
}

// ── Step 5: Write commit ref ──

const shaResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: CACHE_DIR })
const sha = shaResult.stdout.toString().trim()
await Bun.write(resolve(DOCS_DIR, ".grove-docs-ref"), sha + "\n")

// ── Step 6: Ensure .gitignore ──

const gitignorePath = resolve(REPO_ROOT, ".gitignore")
if (existsSync(gitignorePath)) {
  const content = readFileSync(gitignorePath, "utf-8")
  if (!content.split("\n").some((line) => line.trim() === ".docs")) {
    appendFileSync(gitignorePath, "\n.docs\n")
  }
} else {
  appendFileSync(gitignorePath, ".docs\n")
}

console.log(`✓ Linked ${linked} doc dirs into .docs/ (ref: ${sha.slice(0, 8)})`)
