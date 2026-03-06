import { Cli } from "incur"
import { run } from "./commands/run.ts"
import { init } from "./commands/init.ts"
import { inventory } from "./commands/inventory.ts"
import { dashboard } from "./commands/dashboard.ts"
import { schema } from "./commands/schema.ts"
import { loggerMiddleware, loggerVarsSchema } from "./logger.ts"
import pkg from "../../package.json" with { type: "json" }

/** Current Ignition CLI version from `package.json`. */
export const VERSION: string = pkg.version

/** Root CLI definition with shared logger middleware and subcommands. */
export const cli = Cli.create("ignition", {
  description: "Ignition -- SSH-based server provisioning",
  version: VERSION,
  vars: loggerVarsSchema,
  format: "json",
})
  .use(loggerMiddleware)
  .command(run)
  .command(init)
  .command(inventory)
  .command(dashboard)
  .command(schema)
