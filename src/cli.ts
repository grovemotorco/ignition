/**
 * Ignition CLI entry point.
 */

import { cli, VERSION } from "./cli/index.ts"
import { handleCliError } from "./cli/runtime.ts"

export { VERSION }

export async function main(args: string[]): Promise<number> {
  try {
    await cli.parse(args)
    return 0
  } catch (error) {
    return handleCliError(error)
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
