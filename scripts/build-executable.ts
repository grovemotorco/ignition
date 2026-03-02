/**
 * Build a single-file Ignition executable using Bun's compile mode.
 *
 * Usage:
 *   bun run scripts/build-executable.ts
 *   bun run scripts/build-executable.ts --outfile=dist/ignition-custom
 *
 * Steps:
 * 1) Build + embed dashboard UI into src/dashboard/assets.ts
 * 2) Bundle the public API library for init scaffolding
 * 3) Compile src/cli.ts into a single executable
 */

import { bundleLibrary, compileBinary, run } from "./lib.ts"

function getOutfileArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--outfile" && i + 1 < args.length) {
      return args[i + 1]
    }
    if (arg.startsWith("--outfile=")) {
      return arg.slice("--outfile=".length)
    }
  }
  return null
}

const outfile = getOutfileArg(process.argv.slice(2))

await run(["bun", "run", "dashboard:build"])
await bundleLibrary()
const resolvedOutfile = await compileBinary(outfile ?? undefined)

console.log(`Built single-file executable: ${resolvedOutfile}`)
