import { test, expect } from "bun:test"
import {
  loadConfig,
  mergeWithConfig,
  validateConfig,
  ConfigValidationError,
} from "../../src/lib/config.ts"
import type { RunCheckOptions } from "../../src/cli/types.ts"

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test("loadConfig — returns empty config when file does not exist", async () => {
  const config = await loadConfig("/tmp/nonexistent-dir-ignition-test")
  expect(config).toEqual({})
})

// ---------------------------------------------------------------------------
// mergeWithConfig
// ---------------------------------------------------------------------------

/** Options where nothing was set by CLI (all undefined except required fields). */
function unsetOptions(): RunCheckOptions {
  return {
    tags: [],
    vars: {},
  }
}

test("mergeWithConfig — returns hardcoded defaults when config and CLI are both empty", () => {
  const result = mergeWithConfig(unsetOptions(), {})
  expect(result.verbose).toEqual(false)
  expect(result.format).toEqual("pretty")
  expect(result.errorMode).toEqual("fail-fast")
  expect(result.parallelism).toEqual(5)
  expect(result.hostKeyPolicy).toEqual("accept-new")
  expect(result.multiplex).toEqual(true)
  expect(result.confirm).toEqual(false)
  expect(result.cache).toEqual(false)
})

test("mergeWithConfig — config fills undefined fields", () => {
  const result = mergeWithConfig(unsetOptions(), {
    inventory: "hosts.ts",
    verbose: true,
    parallelism: 10,
    format: "json",
    dashboard: "127.0.0.1:9090",
    logDir: "/var/log/ignition",
  })

  expect(result.inventory).toEqual("hosts.ts")
  expect(result.verbose).toEqual(true)
  expect(result.parallelism).toEqual(10)
  expect(result.format).toEqual("json")
  expect(result.dashboard).toEqual("127.0.0.1:9090")
  expect(result.logDir).toEqual("/var/log/ignition")
})

test("mergeWithConfig — CLI values always win over config", () => {
  const options: RunCheckOptions = {
    ...unsetOptions(),
    inventory: "cli-hosts.ts",
    parallelism: 3,
    verbose: false,
    format: "minimal",
  }
  const result = mergeWithConfig(options, {
    inventory: "config-hosts.ts",
    parallelism: 10,
    verbose: true,
    format: "json",
  })

  expect(result.inventory).toEqual("cli-hosts.ts")
  expect(result.parallelism).toEqual(3)
  expect(result.verbose).toEqual(false)
  expect(result.format).toEqual("minimal")
})

test("mergeWithConfig — explicit --no-verbose wins over config verbose: true", () => {
  const options: RunCheckOptions = { ...unsetOptions(), verbose: false }
  const result = mergeWithConfig(options, { verbose: true })
  expect(result.verbose).toEqual(false)
})

test("mergeWithConfig — explicit --parallelism 5 wins over config parallelism: 10", () => {
  const options: RunCheckOptions = { ...unsetOptions(), parallelism: 5 }
  const result = mergeWithConfig(options, { parallelism: 10 })
  expect(result.parallelism).toEqual(5)
})

test("mergeWithConfig — config vars merge with CLI vars (CLI wins)", () => {
  const options: RunCheckOptions = { ...unsetOptions(), vars: { region: "us-west-2" } }
  const result = mergeWithConfig(options, {
    vars: { region: "eu-west-1", env: "prod" },
  })

  expect(result.vars).toEqual({ region: "us-west-2", env: "prod" })
})

test("mergeWithConfig — pass-through fields are preserved", () => {
  const options: RunCheckOptions = { ...unsetOptions(), tags: ["web"] }
  const result = mergeWithConfig(options, { verbose: true })

  expect(result.tags).toEqual(["web"])
})

test("mergeWithConfig — config cache fields fill undefined CLI values", () => {
  const result = mergeWithConfig(unsetOptions(), {
    cache: true,
    cacheTtl: 300000,
    cacheClear: true,
  })

  expect(result.cache).toEqual(true)
  expect(result.cacheTtl).toEqual(300000)
  expect(result.cacheClear).toEqual(true)
})

test("mergeWithConfig — CLI cache fields win over config", () => {
  const options: RunCheckOptions = { ...unsetOptions(), cache: false, cacheTtl: 60000 }
  const result = mergeWithConfig(options, { cache: true, cacheTtl: 300000 })

  expect(result.cache).toEqual(false)
  expect(result.cacheTtl).toEqual(60000)
})

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

test("validateConfig — accepts valid config", () => {
  expect(() => validateConfig({ format: "json", parallelism: 10 })).not.toThrow()
})

test("validateConfig — accepts empty config", () => {
  expect(() => validateConfig({})).not.toThrow()
})

test("validateConfig — rejects invalid format", () => {
  expect(() => validateConfig({ format: "xml" as never })).toThrow(ConfigValidationError)
})

test("validateConfig — rejects invalid errorMode", () => {
  expect(() => validateConfig({ errorMode: "yolo" as never })).toThrow(ConfigValidationError)
})

test("validateConfig — rejects invalid hostKeyPolicy", () => {
  expect(() => validateConfig({ hostKeyPolicy: "none" as never })).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-positive parallelism", () => {
  expect(() => validateConfig({ parallelism: 0 })).toThrow(ConfigValidationError)
  expect(() => validateConfig({ parallelism: -1 })).toThrow(ConfigValidationError)
})

test("validateConfig — rejects negative timeouts", () => {
  expect(() => validateConfig({ hostTimeout: -1 })).toThrow(ConfigValidationError)
  expect(() => validateConfig({ resourceTimeout: -1 })).toThrow(ConfigValidationError)
})

test("validateConfig — rejects negative retries/retryDelay", () => {
  expect(() => validateConfig({ retries: -1 })).toThrow(ConfigValidationError)
  expect(() => validateConfig({ retryDelay: -1 })).toThrow(ConfigValidationError)
})

test("validateConfig — accepts zero for timeouts and retries", () => {
  expect(() =>
    validateConfig({ hostTimeout: 0, resourceTimeout: 0, retries: 0, retryDelay: 0 }),
  ).not.toThrow()
})

// ---------------------------------------------------------------------------
// Type validation (Finding 2: incomplete type checking)
// ---------------------------------------------------------------------------

test("validateConfig — rejects non-object default export", () => {
  expect(() => validateConfig(null as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig("string" as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig([] as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-string inventory", () => {
  expect(() => validateConfig({ inventory: 42 } as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig({ inventory: true } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-string dashboard", () => {
  expect(() => validateConfig({ dashboard: 9090 } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-string logDir", () => {
  expect(() => validateConfig({ logDir: false } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-boolean verbose", () => {
  expect(() => validateConfig({ verbose: "true" } as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig({ verbose: 1 } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-boolean multiplex", () => {
  expect(() => validateConfig({ multiplex: "false" } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-object vars", () => {
  expect(() => validateConfig({ vars: "key=value" } as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig({ vars: ["a"] } as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig({ vars: null } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects non-boolean cache and cacheClear", () => {
  expect(() => validateConfig({ cache: "true" } as never)).toThrow(ConfigValidationError)
  expect(() => validateConfig({ cacheClear: 1 } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — rejects invalid cacheTtl", () => {
  expect(() => validateConfig({ cacheTtl: -1 })).toThrow(ConfigValidationError)
  expect(() => validateConfig({ cacheTtl: "30000" } as never)).toThrow(ConfigValidationError)
})

test("validateConfig — accepts valid string, boolean, and vars fields", () => {
  expect(() =>
    validateConfig({
      inventory: "hosts.ts",
      dashboard: "127.0.0.1:9090",
      logDir: "/var/log",
      verbose: true,
      multiplex: false,
      vars: { region: "us-east-1" },
    }),
  ).not.toThrow()
})

// ---------------------------------------------------------------------------
// Config load errors (Finding 1: syntax errors should not leak stack traces)
// ---------------------------------------------------------------------------

test("loadConfig — wraps syntax/import errors as ConfigValidationError", async () => {
  const fsPromises = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")

  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ignition-config-test-"))
  await fsPromises.writeFile(
    path.join(dir, "ignition.config.ts"),
    "export default {{{invalid syntax",
  )
  try {
    let caught: unknown
    try {
      await loadConfig(dir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigValidationError)
  } finally {
    await fsPromises.rm(dir, { recursive: true })
  }
})
