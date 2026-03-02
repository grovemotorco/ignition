#!/usr/bin/env bun
/**
 * Interactive sandbox environment for manual / live testing.
 *
 * Spins up an ephemeral Deno Sandbox microVM with SSH access, prints connection
 * details, then waits for you to finish. Use it to manually test recipes, SSH
 * commands, or just poke around a disposable Linux box.
 *
 * Requires DENO_DEPLOY_TOKEN in .env (or environment).
 *
 * Usage:
 *   bun run scripts/deno-sandbox.ts                        # interactive sandbox, default 10m timeout
 *   bun run scripts/deno-sandbox.ts 15m                    # custom timeout
 *   bun run scripts/deno-sandbox.ts 5m -- examples/smoke-test.ts   # run recipe then keep sandbox alive
 *
 * The script prints:
 *   - ssh command for manual access
 *   - ad-hoc target string for ignition CLI
 *   - example ignition commands
 *
 * Press Ctrl+C or type "exit" to tear down the sandbox early.
 */

import { Sandbox } from "@deno/sandbox"
import { banner, kv } from "./lib.ts"

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Args {
  timeout: string
  recipe?: string
  help: boolean
}

function usage(): never {
  console.log(`
Usage: bun run scripts/deno-sandbox.ts [timeout] [-- recipe.ts]

Arguments:
  timeout          Sandbox lifetime (default: 10m). Examples: 5m, 15m, 1h
  -- recipe.ts     Optional recipe to run against the sandbox before entering
                   interactive mode. Runs with "ignition run".

Environment:
  DENO_DEPLOY_TOKEN   Required. Authenticates with Deno Deploy sandbox API.

Examples:
  bun run scripts/deno-sandbox.ts                              # 10 minute sandbox
  bun run scripts/deno-sandbox.ts 15m                          # 15 minute sandbox
  bun run scripts/deno-sandbox.ts 5m -- examples/smoke-test.ts # run recipe, then stay open
`)
  process.exit(0)
}

function parseCliArgs(): Args {
  const argv = process.argv.slice(2)
  const help = argv.includes("--help") || argv.includes("-h")
  if (help) usage()

  const ddIdx = argv.indexOf("--")
  const positional = ddIdx >= 0 ? argv.slice(0, ddIdx) : argv.filter((a) => !a.startsWith("-"))
  const recipe = ddIdx >= 0 ? argv[ddIdx + 1] : undefined

  const timeout = positional[0] ?? "10m"

  return { timeout, recipe, help: false }
}

// ---------------------------------------------------------------------------
// Recipe runner
// ---------------------------------------------------------------------------

async function runRecipe(target: string, recipe: string): Promise<boolean> {
  banner(`Running recipe: ${recipe}`)
  const proc = Bun.spawn(["bun", "run", "dev", "run", recipe, target, "--host-key-policy", "off"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
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

  const token = process.env.DENO_DEPLOY_TOKEN
  if (!token) {
    console.error("\x1b[31mError: DENO_DEPLOY_TOKEN is not set.\x1b[0m")
    console.error("Create a .env file with your token or export it in your shell.")
    process.exit(1)
  }

  banner("Creating sandbox")
  console.log(`  Timeout: ${args.timeout}`)

  const sandbox = await Sandbox.create({ lifetime: args.timeout as `${number}m`, region: "ord" })
  const ssh = await sandbox.exposeSsh()

  const target = `${ssh.username}@${ssh.hostname}`

  banner("Sandbox ready")
  kv("hostname:", ssh.hostname)
  kv("username:", ssh.username)
  kv("ssh:", `ssh -o StrictHostKeyChecking=no ${target}`)
  kv("target:", target)

  banner("Ignition commands")
  console.log(`  \x1b[2m# Dry-run\x1b[0m`)
  console.log(`  bun run dev check examples/smoke-test.ts ${target} --host-key-policy off`)
  console.log()
  console.log(`  \x1b[2m# Apply\x1b[0m`)
  console.log(`  bun run dev run examples/smoke-test.ts ${target} --host-key-policy off`)
  console.log()
  console.log(`  \x1b[2m# System info\x1b[0m`)
  console.log(`  bun run dev run examples/system-info.ts ${target} --host-key-policy off`)
  console.log()
  console.log(`  \x1b[2m# File roundtrip\x1b[0m`)
  console.log(`  bun run dev run examples/file-roundtrip.ts ${target} --host-key-policy off`)

  // Run recipe if specified
  if (args.recipe) {
    await runRecipe(target, args.recipe)
  }

  banner(`Sandbox alive — press Ctrl+C to tear down`)
  console.log(`  Auto-expires in ${args.timeout}\n`)

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
  await sandbox.kill()
  console.log("  Done.\n")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
