import { Cli } from "incur"
import { run } from "./commands/run.ts"
import { init } from "./commands/init.ts"
import { inventory } from "./commands/inventory.ts"
import { dashboard } from "./commands/dashboard.ts"
import { schema } from "./commands/schema.ts"
import { loggerMiddleware, loggerVarsSchema } from "./logger.ts"
import pkg from "../../package.json" with { type: "json" }
import { test } from "./commands/test.ts"

export const VERSION: string = pkg.version

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
  .command(test)
