import { Command } from "@cliffy/command"
import pkg from "../../package.json" with { type: "json" }
import { run, check } from "./commands/shared.ts"
import { dashboard } from "./commands/dashboard.ts"
import { init } from "./commands/init.ts"
import { inventory } from "./commands/inventory.ts"
import { schema } from "./commands/schema.ts"

export const VERSION: string = pkg.version

export const cli = new Command()
  .name("ignition")
  .description("Ignition — SSH-based server provisioning")
  .version(VERSION)
  .noExit()
  .action(function () {
    this.showHelp()
    console.log("\nFor agent/LLM usage: ignition schema --format agent")
  })
  .command("run", run as unknown as Command)
  .command("check", check as unknown as Command)
  .command("inventory", inventory as unknown as Command)
  .command("init", init)
  .command("dashboard", dashboard)
  .command("schema", schema as unknown as Command)
