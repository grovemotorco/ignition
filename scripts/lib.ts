/**
 * Shared utilities for Ignition build and sandbox scripts.
 *
 * Console helpers, process execution, build steps, and path constants
 * used across multiple scripts in this directory.
 */

import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DIST_DIR = join(PROJECT_ROOT, "dist")
export const DIST_LIBRARY = join(DIST_DIR, "ignition-lib.js")
export const DIST_BINARY = join(
  DIST_DIR,
  process.platform === "win32" ? "ignition.exe" : "ignition",
)

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

export function banner(msg: string): void {
  console.log(`\n\x1b[1;36m── ${msg} ${"─".repeat(Math.max(0, 60 - msg.length))}\x1b[0m`)
}

export function kv(key: string, value: string): void {
  console.log(`  \x1b[33m${key}\x1b[0m  ${value}`)
}

export function pass(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
}

export function fail(msg: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

/** Run a command, capture stdout/stderr, return results. */
export async function shell(
  cmd: string[],
  opts?: { quiet?: boolean; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: opts?.quiet ? "pipe" : "pipe",
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (opts?.timeout) {
    timeoutId = setTimeout(() => proc.kill(), opts.timeout)
  }

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  if (timeoutId) clearTimeout(timeoutId)

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: proc.exitCode ?? 1 }
}

/** Run a command with inherited stdio (visible to user). Exits on failure. */
export async function run(command: string[], label?: string): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: PROJECT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    if (label) console.error(`${label} failed`)
    process.exit(exitCode)
  }
}

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

/** Bundle the public API into a single ESM file for embedding in the compiled binary. */
export async function bundleLibrary(): Promise<void> {
  await mkdir(DIST_DIR, { recursive: true })
  await run(
    ["bun", "build", "./src/index.ts", "--outfile", DIST_LIBRARY, "--target=bun", "--format=esm"],
    "Library bundle",
  )
}

/** Compile the CLI into a standalone executable. */
export async function compileBinary(outfile?: string): Promise<string> {
  const resolvedOutfile = outfile
    ? isAbsolute(outfile)
      ? outfile
      : resolve(PROJECT_ROOT, outfile)
    : DIST_BINARY
  await mkdir(dirname(resolvedOutfile), { recursive: true })
  await run(
    ["bun", "build", "--compile", "./src/cli.ts", "--outfile", resolvedOutfile],
    "Binary compile",
  )
  return resolvedOutfile
}
