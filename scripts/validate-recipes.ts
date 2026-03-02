#!/usr/bin/env bun
/**
 * Validates all example recipes against the Docker sandbox.
 *
 * Spins up an ephemeral sandbox, runs each recipe in check mode and apply mode,
 * reports pass/fail, then tears down.
 *
 * Usage:
 *   bun run scripts/validate-recipes.ts
 *   bun run scripts/validate-recipes.ts --apply          # also run in apply mode
 *   bun run scripts/validate-recipes.ts --recipe smoke-test  # single recipe
 */

import { basename } from "node:path"
import { banner, pass, fail, shell } from "./lib.ts"
import { startSandbox, stopSandbox } from "./docker.ts"

// ---------------------------------------------------------------------------
// Types & config
// ---------------------------------------------------------------------------

interface RecipeResult {
  recipe: string
  checkPassed: boolean
  checkOutput: string
  applyPassed?: boolean
  applyOutput?: string
}

const RECIPES = [
  "examples/smoke-test.ts",
  "examples/system-info.ts",
  "examples/file-roundtrip.ts",
  "examples/node-server.ts",
  "examples/dev-environment.ts",
  "examples/node-app.ts",
  "examples/nginx.ts",
  "examples/postgres.ts",
  "examples/security-hardening.ts",
]

// ---------------------------------------------------------------------------
// Recipe runner
// ---------------------------------------------------------------------------

async function runRecipe(
  mode: "check" | "run",
  recipe: string,
  target: string,
  keyPath: string,
): Promise<{ passed: boolean; output: string }> {
  const { stdout, stderr, exitCode } = await shell([
    "bun",
    "run",
    "dev",
    mode,
    recipe,
    target,
    "--host-key-policy",
    "off",
    "--identity",
    keyPath,
    "--error-mode",
    "fail-at-end",
  ])

  return {
    passed: exitCode === 0,
    output: stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ""),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const doApply = argv.includes("--apply")
  const recipeFilter = argv.includes("--recipe") ? argv[argv.indexOf("--recipe") + 1] : undefined

  const recipes = recipeFilter ? RECIPES.filter((r) => r.includes(recipeFilter)) : RECIPES

  if (recipes.length === 0) {
    console.error(`No recipes match filter: ${recipeFilter}`)
    process.exit(1)
  }

  banner("Starting Docker sandbox")
  const { containerId, port, keyDir, privateKey, target } = await startSandbox()
  console.log(`  Container: ${containerId.slice(0, 12)}  Port: ${port}`)

  const results: RecipeResult[] = []

  for (const recipe of recipes) {
    const name = basename(recipe, ".ts")
    banner(`Checking: ${name}`)

    const check = await runRecipe("check", recipe, target, privateKey)
    const result: RecipeResult = {
      recipe: name,
      checkPassed: check.passed,
      checkOutput: check.output,
    }

    if (check.passed) {
      pass(`check mode`)
    } else {
      fail(`check mode`)
      console.log(check.output.split("\n").slice(-10).join("\n"))
    }

    if (doApply) {
      banner(`Applying: ${name}`)
      const apply = await runRecipe("run", recipe, target, privateKey)
      result.applyPassed = apply.passed
      result.applyOutput = apply.output

      if (apply.passed) {
        pass(`apply mode`)
      } else {
        fail(`apply mode`)
        console.log(apply.output.split("\n").slice(-10).join("\n"))
      }
    }

    results.push(result)
  }

  // --- Summary ---
  banner("Results")

  const checkPass = results.filter((r) => r.checkPassed).length
  const checkFail = results.filter((r) => !r.checkPassed).length
  console.log(
    `\n  Check mode:  \x1b[32m${checkPass} passed\x1b[0m  \x1b[31m${checkFail} failed\x1b[0m`,
  )

  if (doApply) {
    const applyPass = results.filter((r) => r.applyPassed).length
    const applyFail = results.filter((r) => r.applyPassed === false).length
    console.log(
      `  Apply mode:  \x1b[32m${applyPass} passed\x1b[0m  \x1b[31m${applyFail} failed\x1b[0m`,
    )
  }

  console.log()
  for (const r of results) {
    const checkIcon = r.checkPassed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
    const applyIcon =
      r.applyPassed === undefined ? "·" : r.applyPassed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
    console.log(`  ${checkIcon} ${applyIcon}  ${r.recipe}`)
  }

  banner("Tearing down sandbox")
  await stopSandbox(containerId, keyDir)
  console.log("  Done.\n")

  if (checkFail > 0) process.exit(1)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
