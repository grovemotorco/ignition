#!/usr/bin/env bun
/**
 * Docker-based sandbox environment for local testing.
 *
 * Spins up an ephemeral Ubuntu Docker container with SSH access, prints
 * connection details, then waits for you to finish. Use it to manually test
 * recipes, SSH commands, or just poke around a disposable Linux box.
 *
 * Requires Docker to be running.
 *
 * Usage:
 *   bun run scripts/docker-sandbox.ts                              # interactive sandbox
 *   bun run scripts/docker-sandbox.ts -- examples/smoke-test.ts    # run recipe then keep sandbox alive
 *
 * The script prints:
 *   - ssh command for manual access
 *   - ad-hoc target string for ignition CLI
 *   - example ignition commands
 *
 * Press Ctrl+C to tear down the sandbox.
 */

import { banner, kv, shell } from "./lib.ts"
import { startSandbox, stopSandbox } from "./docker.ts"

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Args {
  recipe?: string
  help: boolean
}

function usage(): never {
  console.log(`
Usage: bun run scripts/docker-sandbox.ts [-- recipe.ts]

Arguments:
  -- recipe.ts     Optional recipe to run against the sandbox before entering
                   interactive mode. Runs with "ignition run".

Requirements:
  Docker must be running.

Examples:
  bun run scripts/docker-sandbox.ts                              # interactive sandbox
  bun run scripts/docker-sandbox.ts -- examples/smoke-test.ts    # run recipe, then stay open
`)
  process.exit(0)
}

function parseCliArgs(): Args {
  const argv = process.argv.slice(2)
  const help = argv.includes("--help") || argv.includes("-h")
  if (help) usage()

  const ddIdx = argv.indexOf("--")
  const recipe = ddIdx >= 0 ? argv[ddIdx + 1] : undefined

  return { recipe, help: false }
}

// ---------------------------------------------------------------------------
// Recipe runner
// ---------------------------------------------------------------------------

async function runRecipe(target: string, keyPath: string, recipe: string): Promise<boolean> {
  banner(`Running recipe: ${recipe}`)
  const proc = Bun.spawn(
    ["bun", "run", "dev", "run", recipe, target, "--host-key-policy", "off", "--identity", keyPath],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  await proc.exited
  const code = proc.exitCode ?? 1
  if (code !== 0) {
    console.error(`\x1b[31mRecipe exited with code ${code}\x1b[0m`)
  }
  return code === 0
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs()

  // Check Docker is running
  const { exitCode: dockerCheck } = await shell(["docker", "info"], { quiet: true })
  if (dockerCheck !== 0) {
    console.error("\x1b[31mError: Docker is not running.\x1b[0m")
    console.error("Start Docker Desktop or the Docker daemon and try again.")
    process.exit(1)
  }

  banner("Creating sandbox")

  const sandbox = await startSandbox()
  const { containerId, port, keyDir, privateKey, target } = sandbox

  banner("Sandbox ready")
  kv("container:", containerId.slice(0, 12))
  kv("ssh:", `ssh -o StrictHostKeyChecking=no -i ${privateKey} -p ${port} root@127.0.0.1`)
  kv("target:", target)
  kv("key:", privateKey)

  banner("Ignition commands")
  console.log(`  \x1b[2m# Dry-run\x1b[0m`)
  console.log(
    `  bun run dev check examples/smoke-test.ts ${target} --host-key-policy off --identity ${privateKey}`,
  )
  console.log()
  console.log(`  \x1b[2m# Apply\x1b[0m`)
  console.log(
    `  bun run dev run examples/smoke-test.ts ${target} --host-key-policy off --identity ${privateKey}`,
  )
  console.log()
  console.log(`  \x1b[2m# System info\x1b[0m`)
  console.log(
    `  bun run dev run examples/system-info.ts ${target} --host-key-policy off --identity ${privateKey}`,
  )
  console.log()
  console.log(`  \x1b[2m# File roundtrip\x1b[0m`)
  console.log(
    `  bun run dev run examples/file-roundtrip.ts ${target} --host-key-policy off --identity ${privateKey}`,
  )

  // Run recipe if specified
  if (args.recipe) {
    await runRecipe(target, privateKey, args.recipe)
  }

  banner("Sandbox alive — press Ctrl+C to tear down")
  console.log()

  // Keep alive until Ctrl+C
  const ac = new AbortController()
  process.on("SIGINT", () => ac.abort())

  try {
    await new Promise<void>((_resolve, reject) => {
      ac.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
    })
  } catch {
    // Ctrl+C
  }

  banner("Tearing down sandbox")
  await stopSandbox(containerId, keyDir)
  console.log("  Done.\n")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
