import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../src/cli.ts"

function stringify(items: unknown[]): string {
  return items.map((value) => (typeof value === "string" ? value : String(value))).join(" ")
}

/** Capture console output from main(). */
async function mainWithOutput(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error

  console.log = (...items: unknown[]) => {
    stdout.push(stringify(items))
  }
  console.error = (...items: unknown[]) => {
    stderr.push(stringify(items))
  }

  try {
    const code = await main(args)
    return {
      code,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

// ---------------------------------------------------------------------------
// Entry point routing
// ---------------------------------------------------------------------------

test("main returns 1 for help command (unsupported help alias)", async () => {
  const { code, stderr } = await mainWithOutput(["help"])

  expect(code).toEqual(1)
  expect(stderr).toContain('Unknown command "help"')
})

test("main returns 0 for --help flag", async () => {
  const code = await main(["--help"])

  expect(code).toEqual(0)
})

test("main returns 0 for -h flag", async () => {
  const code = await main(["-h"])

  expect(code).toEqual(0)
})

test("main returns 0 for no args (shows help)", async () => {
  const { code, stdout } = await mainWithOutput([])

  expect(code).toEqual(0)
  expect(stdout).toContain("Usage")
})

test("main returns 1 for help run (unsupported help alias)", async () => {
  const { code, stderr } = await mainWithOutput(["help", "run"])

  expect(code).toEqual(1)
  expect(stderr).toContain('Unknown command "help"')
})

test("main returns 1 for unknown command", async () => {
  const { code, stderr } = await mainWithOutput(["deploy"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown command")
  expect(stderr).toContain('"deploy"')
})

test("main returns 1 for missing positional args", async () => {
  const { code, stderr } = await mainWithOutput(["run"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Missing argument")
})

test("main returns 1 for unknown option", async () => {
  const { code, stderr } = await mainWithOutput(["run", "setup.ts", "@web", "--unknown"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--unknown")
})

// ---------------------------------------------------------------------------
// Intentional compatibility break: --vars is no longer supported
// ---------------------------------------------------------------------------

test("--vars key=value is rejected (use --var)", async () => {
  const { code, stderr } = await mainWithOutput([
    "check",
    "setup.ts",
    "@web",
    "--vars",
    "env=staging",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--vars")
  expect(stderr).toContain("--var")
})

test("--vars=key=value is rejected (use --var)", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "--vars=env=staging"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--vars")
  expect(stderr).toContain("--var")
})

// ---------------------------------------------------------------------------
// help fallback
// ---------------------------------------------------------------------------

test("help with unknown command returns 1 (help alias unsupported)", async () => {
  const { code, stderr } = await mainWithOutput(["help", "unknown"])

  expect(code).toEqual(1)
  expect(stderr).toContain('Unknown command "help"')
})

test("help check returns 1 (help alias unsupported)", async () => {
  const { code, stderr } = await mainWithOutput(["help", "check"])

  expect(code).toEqual(1)
  expect(stderr).toContain('Unknown command "help"')
})

// ---------------------------------------------------------------------------
// Flags before command are rejected
// ---------------------------------------------------------------------------

test("--verbose before command is rejected as unknown flag", async () => {
  const { code, stderr } = await mainWithOutput(["--verbose", "run"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
})

test("--format before command is rejected as unknown flag", async () => {
  const { code, stderr } = await mainWithOutput(["--format", "json", "run"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
})

// ---------------------------------------------------------------------------
// init command integration
// ---------------------------------------------------------------------------

test("main routes init --help", async () => {
  const code = await main(["init", "--help"])

  expect(code).toEqual(0)
})

// ---------------------------------------------------------------------------
// inventory command — error case (no file)
// ---------------------------------------------------------------------------

test("inventory command returns 1 when no file specified", async () => {
  const code = await main(["inventory"])

  expect(code).toEqual(1)
})

// ---------------------------------------------------------------------------
// Version flag
// ---------------------------------------------------------------------------

test("--version returns 0", async () => {
  const code = await main(["--version"])

  expect(code).toEqual(0)
})

test("-V returns 0", async () => {
  const code = await main(["-V"])

  expect(code).toEqual(0)
})

// ---------------------------------------------------------------------------
// dashboard command help
// ---------------------------------------------------------------------------

test("dashboard --help returns 0", async () => {
  const code = await main(["dashboard", "--help"])

  expect(code).toEqual(0)
})

// ---------------------------------------------------------------------------
// Stricli error message compatibility
// ---------------------------------------------------------------------------

test("run with only recipe (missing target) returns 1", async () => {
  const { code, stderr } = await mainWithOutput(["run", "setup.ts"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Missing argument")
})

test("check with no args returns 1", async () => {
  const { code, stderr } = await mainWithOutput(["check"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Missing argument")
})

// ---------------------------------------------------------------------------
// Did-you-mean suggestions
// ---------------------------------------------------------------------------

test("unknown option suggests similar flag with -- prefix", async () => {
  const { code, stderr } = await mainWithOutput(["run", "setup.ts", "@web", "--verbos"])

  expect(code).toEqual(1)
  expect(stderr).toContain("--verbose")
})

test("unknown command suggests similar command", async () => {
  const { code, stderr } = await mainWithOutput(["rin"])

  expect(code).toEqual(1)
  expect(stderr).toContain("run")
})

// ---------------------------------------------------------------------------
// Repeated boolean flags are rejected by the parser
// ---------------------------------------------------------------------------

test("--cache --cache is rejected as duplicate", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "--cache", "--cache"])

  expect(code).toEqual(1)
  expect(stderr).toContain("can only occur once")
})

test("-v -v is rejected as duplicate", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "-v", "-v"])

  expect(code).toEqual(1)
  expect(stderr).toContain("can only occur once")
})

test("-v --verbose is rejected as duplicate", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "-v", "--verbose"])

  expect(code).toEqual(1)
  expect(stderr).toContain("can only occur once")
})

test("--cache-clear --cache-clear is rejected as duplicate", async () => {
  const { code, stderr } = await mainWithOutput([
    "check",
    "setup.ts",
    "@web",
    "--cache-clear",
    "--cache-clear",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("can only occur once")
})

test("--no-multiplex --no-multiplex is rejected as duplicate", async () => {
  const { code, stderr } = await mainWithOutput([
    "check",
    "setup.ts",
    "@web",
    "--no-multiplex",
    "--no-multiplex",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("can only occur once")
})

// ---------------------------------------------------------------------------
// Negated forms --no-verbose, --no-cache, --no-confirm are not supported
// ---------------------------------------------------------------------------

test("--no-cache is rejected as unknown option", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "--no-cache"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--no-cache")
})

test("--no-verbose is rejected as unknown option", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "--no-verbose"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--no-verbose")
})

test("--no-confirm is rejected as unknown option", async () => {
  const { code, stderr } = await mainWithOutput(["check", "setup.ts", "@web", "--no-confirm"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--no-confirm")
})

// ---------------------------------------------------------------------------
// --dashboard= edge case
// ---------------------------------------------------------------------------

test("--dashboard= (empty equals) is accepted by Stricli inferEmpty", async () => {
  // Should not fail with a parse error — Stricli inferEmpty handles the empty string.
  // The command will fail later (missing inventory), but the flag is accepted.
  const { stderr } = await mainWithOutput(["check", "setup.ts", "@web", "--dashboard="])

  expect(stderr.includes("Unknown option")).toEqual(false)
  expect(stderr.includes("Invalid")).toEqual(false)
})

// ---------------------------------------------------------------------------
// schema command routing
// ---------------------------------------------------------------------------

test("schema returns 0 (dispatches to schema handler)", async () => {
  const code = await main(["schema"])

  expect(code).toEqual(0)
})

test("help schema returns 1 (help alias unsupported)", async () => {
  const { code, stderr } = await mainWithOutput(["help", "schema"])

  expect(code).toEqual(1)
  expect(stderr).toContain('Unknown command "help"')
})

test("schema --help returns 0", async () => {
  const code = await main(["schema", "--help"])

  expect(code).toEqual(0)
})

test("schema rejects unknown flags", async () => {
  const { code, stderr } = await mainWithOutput(["schema", "--bogus"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown option")
  expect(stderr).toContain("--bogus")
})

test("schema rejects unknown subcommand", async () => {
  const { code, stderr } = await mainWithOutput(["schema", "unknown"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Unknown command")
  expect(stderr).toContain("unknown")
})

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

test("thrown IgnitionError is concise and does not print stack trace", async () => {
  const { code, stderr } = await mainWithOutput(["run", "setup.ts", "@web"])

  expect(code).toEqual(1)
  expect(stderr).toContain("Error [InventoryError]:")
  expect(stderr.includes("\n    at ")).toEqual(false)
  expect(stderr.includes("file://")).toEqual(false)
})

// ---------------------------------------------------------------------------
// Config file error formatting
// ---------------------------------------------------------------------------

/** Run main() in a temporary directory containing the given config file. */
async function mainWithConfig(
  configContent: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ignition-test-"))
  writeFileSync(join(dir, "ignition.config.ts"), configContent)
  const original = process.cwd()
  process.chdir(dir)
  try {
    const { code, stderr } = await mainWithOutput(args)
    return { code, stderr }
  } finally {
    process.chdir(original)
    await rm(dir, { recursive: true })
  }
}

test("invalid config format shows clean error without stack trace", async () => {
  const { code, stderr } = await mainWithConfig('export default { format: "xml" }\n', [
    "check",
    "setup.ts",
    "host",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("Config error:")
  expect(stderr).toContain("Invalid format")
  expect(stderr.includes("\n    at ")).toEqual(false)
})

test("invalid config parallelism shows clean error without stack trace", async () => {
  const { code, stderr } = await mainWithConfig("export default { parallelism: -1 }\n", [
    "run",
    "setup.ts",
    "host",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("Config error:")
  expect(stderr).toContain("Invalid parallelism")
  expect(stderr.includes("\n    at ")).toEqual(false)
})

test("invalid config errorMode shows clean error without stack trace", async () => {
  const { code, stderr } = await mainWithConfig('export default { errorMode: "yolo" }\n', [
    "check",
    "setup.ts",
    "host",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("Config error:")
  expect(stderr).toContain("Invalid errorMode")
  expect(stderr.includes("\n    at ")).toEqual(false)
})

test("malformed config syntax shows clean error without stack trace", async () => {
  const { code, stderr } = await mainWithConfig("export default {{{bad syntax\n", [
    "check",
    "setup.ts",
    "host",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("Config error:")
  expect(stderr.includes("\n    at ")).toEqual(false)
})

test("config with wrong type (verbose: string) shows clean error without stack trace", async () => {
  const { code, stderr } = await mainWithConfig('export default { verbose: "true" }\n', [
    "check",
    "setup.ts",
    "host",
  ])

  expect(code).toEqual(1)
  expect(stderr).toContain("Config error:")
  expect(stderr).toContain("verbose")
  expect(stderr.includes("\n    at ")).toEqual(false)
})

// ---------------------------------------------------------------------------
// -h consistency (Finding 3)
// ---------------------------------------------------------------------------

test("run -h shows branded help (not Stricli default)", async () => {
  const code = await main(["run", "-h"])

  expect(code).toEqual(0)
})

test("check -h shows branded help", async () => {
  const code = await main(["check", "-h"])

  expect(code).toEqual(0)
})

test("schema -h shows help (not rejected as unknown flag)", async () => {
  const code = await main(["schema", "-h"])

  expect(code).toEqual(0)
})

test("init -h shows branded help", async () => {
  const code = await main(["init", "-h"])

  expect(code).toEqual(0)
})
