import { test, expect } from "bun:test"
import {
  defaultRegistry,
  formatAllForAgent,
  formatCliForAgent,
  formatResourceForAgent,
  formatResourceListForAgent,
  formatResourceListPretty,
  formatResourcePretty,
  getAllDefinitions,
  getAllResourceSchemas,
  getCliSchema,
  getDefinition,
  getFullSchema,
  getInventorySchema,
  getRecipeSchema,
  getResourceSchema,
  getResourceTypes,
  getRunSummarySchema,
  ResourceRegistry,
} from "../../src/core/registry.ts"
import type {
  CheckResult,
  ExecutionContext,
  ResourceDefinition,
  ResourceSchema,
} from "../../src/core/types.ts"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"
import { createResources } from "../../src/resources/index.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubConnection(): SSHConnection {
  const config: SSHConnectionConfig = {
    hostname: "10.0.1.10",
    port: 22,
    user: "deploy",
    hostKeyPolicy: "strict",
  }
  return {
    config,
    capabilities() {
      return ALL_TRANSPORT_CAPABILITIES
    },
    exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }
}

function makeCtx(): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: stubConnection(),
    mode: "check",
    errorMode: "fail-fast",
    verbose: false,
    host: { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} },
    reporter: {
      resourceStart() {},
      resourceEnd() {},
    },
  })
}

/** A minimal resource definition for testing registration. */
function fakeDefinition(type: string): ResourceDefinition<{ value: string }, { result: string }> {
  return {
    type,
    formatName(input) {
      return input.value
    },
    check(_ctx: ExecutionContext, input): Promise<CheckResult<{ result: string }>> {
      return Promise.resolve({
        inDesiredState: true,
        current: { value: input.value },
        desired: { value: input.value },
        output: { result: input.value },
      })
    },
    apply(_ctx: ExecutionContext, input): Promise<{ result: string }> {
      return Promise.resolve({ result: input.value })
    },
  }
}

// ---------------------------------------------------------------------------
// ResourceRegistry — register / get / types / definitions
// ---------------------------------------------------------------------------

test("ResourceRegistry: register and get a definition", () => {
  const registry = new ResourceRegistry()
  const def = fakeDefinition("custom")
  registry.register(def)
  expect(registry.get("custom")).toEqual(def)
})

test("ResourceRegistry: get returns undefined for unregistered type", () => {
  const registry = new ResourceRegistry()
  expect(registry.get("nonexistent")).toEqual(undefined)
})

test("ResourceRegistry: types returns registered type names", () => {
  const registry = new ResourceRegistry()
  registry.register(fakeDefinition("alpha"))
  registry.register(fakeDefinition("beta"))
  expect([...registry.types()].sort()).toEqual(["alpha", "beta"])
})

test("ResourceRegistry: definitions returns all definitions", () => {
  const registry = new ResourceRegistry()
  const a = fakeDefinition("alpha")
  const b = fakeDefinition("beta")
  registry.register(a)
  registry.register(b)
  const defs = registry.definitions()
  expect(defs.length).toEqual(2)
  expect(defs[0]).toEqual(a)
  expect(defs[1]).toEqual(b)
})

test("ResourceRegistry: duplicate type registration throws", () => {
  const registry = new ResourceRegistry()
  registry.register(fakeDefinition("dup"))
  expect(() => registry.register(fakeDefinition("dup"))).toThrow('duplicate type "dup"')
})

// ---------------------------------------------------------------------------
// ResourceRegistry — createBoundResources
// ---------------------------------------------------------------------------

test("ResourceRegistry: createBoundResources returns callable functions", async () => {
  const registry = new ResourceRegistry()
  registry.register(fakeDefinition("ping"))
  const ctx = makeCtx()
  const bound = registry.createBoundResources(ctx)
  expect(bound.ping).toBeDefined()
  const result = await bound.ping({ value: "hello" })
  expect(result.type).toEqual("ping")
  expect(result.status).toEqual("ok")
  expect(result.output).toEqual({ result: "hello" })
})

test("ResourceRegistry: createBoundResources returns all registered types", () => {
  const registry = new ResourceRegistry()
  registry.register(fakeDefinition("alpha"))
  registry.register(fakeDefinition("beta"))
  registry.register(fakeDefinition("gamma"))
  const ctx = makeCtx()
  const bound = registry.createBoundResources(ctx)
  expect(Object.keys(bound).sort()).toEqual(["alpha", "beta", "gamma"])
})

// ---------------------------------------------------------------------------
// defaultRegistry — built-in resources
// ---------------------------------------------------------------------------

test("defaultRegistry has all 5 built-in resources", () => {
  expect([...defaultRegistry.types()].sort()).toEqual([
    "apt",
    "directory",
    "exec",
    "file",
    "service",
  ])
})

test("defaultRegistry definitions match types", () => {
  for (const def of defaultRegistry.definitions()) {
    expect(defaultRegistry.get(def.type)).toEqual(def)
  }
})

test("defaultRegistry duplicate registration throws", () => {
  expect(() => defaultRegistry.register(fakeDefinition("exec"))).toThrow('duplicate type "exec"')
})

// ---------------------------------------------------------------------------
// createResources — custom registry support
// ---------------------------------------------------------------------------

test("createResources with custom registry includes extra resources", () => {
  const registry = new ResourceRegistry()
  registry.register(fakeDefinition("custom"))
  const ctx = makeCtx()
  const resources = createResources(ctx, registry)
  // Built-in resources present
  expect(resources.exec).toBeDefined()
  expect(resources.file).toBeDefined()
  expect(resources.apt).toBeDefined()
  expect(resources.service).toBeDefined()
  expect(resources.directory).toBeDefined()
  // Custom resource present (access via record indexing)
  expect((resources as any).custom).toBeDefined()
})

test("createResources with custom registry executes custom resource", async () => {
  const registry = new ResourceRegistry()
  registry.register(fakeDefinition("widget"))
  const ctx = makeCtx()
  const resources = createResources(ctx, registry)
  const result = await (resources as any).widget({ value: "test" })
  expect(result.type).toEqual("widget")
  expect(result.status).toEqual("ok")
})

test("createResources without registry returns only built-ins", () => {
  const ctx = makeCtx()
  const resources = createResources(ctx)
  expect(Object.keys(resources).sort()).toEqual(["apt", "directory", "exec", "file", "service"])
})

test("createResources delegates base bindings to defaultRegistry", () => {
  const ctx = makeCtx()
  let delegated = false

  const original = defaultRegistry.createBoundResources.bind(defaultRegistry)
  ;(defaultRegistry as any).createBoundResources = (innerCtx: ExecutionContext) => {
    delegated = true
    return original(innerCtx)
  }

  try {
    createResources(ctx)
    expect(delegated).toEqual(true)
  } finally {
    ;(defaultRegistry as any).createBoundResources = original
  }
})

// ---------------------------------------------------------------------------
// Registry — getAllDefinitions
// ---------------------------------------------------------------------------

test("getAllDefinitions returns all 5 resources", () => {
  const defs = getAllDefinitions()
  expect(defs.size).toEqual(5)
  expect([...defs.keys()].sort()).toEqual(["apt", "directory", "exec", "file", "service"])
})

test("getAllDefinitions returns definitions with type matching key", () => {
  const defs = getAllDefinitions()
  for (const [key, def] of defs) {
    expect(def.type).toEqual(key)
  }
})

// ---------------------------------------------------------------------------
// Registry — getDefinition
// ---------------------------------------------------------------------------

test("getDefinition returns definition by type", () => {
  const def = getDefinition("exec")
  expect(def).toBeDefined()
  expect(def?.type).toEqual("exec")
})

test("getDefinition returns undefined for unknown type", () => {
  const def = getDefinition("nonexistent")
  expect(def).toEqual(undefined)
})

// ---------------------------------------------------------------------------
// Registry — getResourceTypes
// ---------------------------------------------------------------------------

test("getResourceTypes returns all type names", () => {
  const types = getResourceTypes()
  expect(types.sort()).toEqual(["apt", "directory", "exec", "file", "service"])
})

// ---------------------------------------------------------------------------
// Registry — getResourceSchema
// ---------------------------------------------------------------------------

test("getResourceSchema returns schema for known type", () => {
  const schema = getResourceSchema("apt")
  expect(schema).toBeDefined()
  expect(typeof schema?.description).toEqual("string")
})

test("getResourceSchema returns undefined for unknown type", () => {
  const schema = getResourceSchema("nonexistent")
  expect(schema).toEqual(undefined)
})

// ---------------------------------------------------------------------------
// Registry — getAllResourceSchemas
// ---------------------------------------------------------------------------

test("getAllResourceSchemas returns 5 schemas", () => {
  const schemas = getAllResourceSchemas()
  expect(schemas.size).toEqual(5)
})

// ---------------------------------------------------------------------------
// Schema structure validation — all resources have required fields
// ---------------------------------------------------------------------------

test("every resource schema has all required fields", () => {
  const schemas = getAllResourceSchemas()
  for (const schema of schemas.values()) {
    expect(schema.description).toBeDefined()
    expect(schema.whenToUse).toBeDefined()
    expect(schema.whenToUse.length > 0).toEqual(true)
    expect(schema.triggerPatterns).toBeDefined()
    expect(schema.triggerPatterns.length > 0).toEqual(true)
    expect(schema.hints).toBeDefined()
    expect(schema.hints.length > 0).toEqual(true)
    expect(schema.input).toBeDefined()
    expect(schema.output).toBeDefined()
    expect(schema.examples).toBeDefined()
    expect(schema.examples.length > 0).toEqual(true)
    expect(schema.annotations).toBeDefined()
    expect(schema.requiredCapabilities).toBeDefined()
  }
})

// ---------------------------------------------------------------------------
// Schema — naturalLanguage examples
// ---------------------------------------------------------------------------

test("each resource schema has at least one example with naturalLanguage", () => {
  const schemas = getAllResourceSchemas()
  for (const schema of schemas.values()) {
    const hasNL = schema.examples.some((ex) => ex.naturalLanguage !== undefined)
    expect(hasNL).toEqual(true)
  }
})

// ---------------------------------------------------------------------------
// Schema — annotation accuracy
// ---------------------------------------------------------------------------

test("exec annotations: destructive, non-idempotent, imperative", () => {
  const schema = getResourceSchema("exec")!
  expect(schema.annotations.destructive).toEqual(true)
  expect(schema.annotations.idempotent).toEqual(false)
  expect(schema.nature).toEqual("imperative")
})

test("file annotations: destructive (state:absent), idempotent, declarative", () => {
  const schema = getResourceSchema("file")!
  expect(schema.annotations.destructive).toEqual(true)
  expect(schema.annotations.idempotent).toEqual(true)
  expect(schema.nature).toEqual("declarative")
})

test("apt annotations: destructive (state:absent), idempotent, declarative", () => {
  const schema = getResourceSchema("apt")!
  expect(schema.annotations.destructive).toEqual(true)
  expect(schema.annotations.idempotent).toEqual(true)
  expect(schema.nature).toEqual("declarative")
})

test("service annotations: non-destructive, non-idempotent, imperative", () => {
  const schema = getResourceSchema("service")!
  expect(schema.annotations.destructive).toEqual(false)
  expect(schema.annotations.idempotent).toEqual(false)
  expect(schema.nature).toEqual("imperative")
})

test("directory annotations: destructive (state:absent), idempotent, declarative", () => {
  const schema = getResourceSchema("directory")!
  expect(schema.annotations.destructive).toEqual(true)
  expect(schema.annotations.idempotent).toEqual(true)
  expect(schema.nature).toEqual("declarative")
})

// ---------------------------------------------------------------------------
// Schema — destructive resources mention state:absent in hints
// ---------------------------------------------------------------------------

test("destructive resources mention state-dependent destructiveness in hints", () => {
  const destructiveResources = ["file", "apt", "directory"]
  for (const type of destructiveResources) {
    const schema = getResourceSchema(type)!
    const mentionsAbsent = schema.hints.some((h) => h.toLowerCase().includes("absent"))
    expect(mentionsAbsent).toEqual(true)
  }
})

// ---------------------------------------------------------------------------
// Schema — all readOnly annotations are false (none are read-only)
// ---------------------------------------------------------------------------

test("all resource annotations have readOnly: false", () => {
  const schemas = getAllResourceSchemas()
  for (const schema of schemas.values()) {
    expect(schema.annotations.readOnly).toEqual(false)
  }
})

// ---------------------------------------------------------------------------
// Recipe schema
// ---------------------------------------------------------------------------

test("getRecipeSchema returns valid recipe format", () => {
  const recipe = getRecipeSchema()
  expect(recipe.format).toEqual("typescript")
  expect(recipe.defaultExport).toBeDefined()
  expect(recipe.completeExample).toBeDefined()
  expect(recipe.pattern).toBeDefined()
  expect(recipe.imports).toBeDefined()
})

test("recipe schema completeExample includes createResources pattern", () => {
  const recipe = getRecipeSchema()
  const example = recipe.completeExample as string
  expect(example.includes("createResources")).toEqual(true)
  expect(example.includes("ExecutionContext")).toEqual(true)
})

// ---------------------------------------------------------------------------
// Inventory schema
// ---------------------------------------------------------------------------

test("getInventorySchema returns valid inventory format", () => {
  const inv = getInventorySchema()
  expect(inv.format).toEqual("typescript")
  expect(inv.targetSyntax).toBeDefined()
  expect(inv.variablePrecedence).toBeDefined()
  expect(inv.schema).toBeDefined()
})

test("inventory schema has all target syntax forms", () => {
  const inv = getInventorySchema()
  const ts = inv.targetSyntax as Record<string, string>
  expect(ts.namedHost).toBeDefined()
  expect(ts.groupExpansion).toBeDefined()
  expect(ts.multiple).toBeDefined()
  expect(ts.adHoc).toBeDefined()
})

// ---------------------------------------------------------------------------
// CLI schema
// ---------------------------------------------------------------------------

test("getCliSchema returns valid CLI grammar", () => {
  const cli = getCliSchema()
  expect(cli.binary).toEqual("ignition")
  expect(cli.commands).toBeDefined()
  expect(cli.globalFlags).toBeDefined()
})

test("CLI schema includes all commands", () => {
  const cli = getCliSchema()
  const cmds = cli.commands as Record<string, unknown>
  expect(cmds.run).toBeDefined()
  expect(cmds.check).toBeDefined()
  expect(cmds.schema).toBeDefined()
  expect(cmds.inventory).toBeDefined()
  expect(cmds.init).toBeDefined()
  expect(cmds.dashboard).toBeDefined()
})

test("CLI schema run/check flags stay in sync", () => {
  const cli = getCliSchema() as {
    commands: {
      run: { flags: Array<{ name: string }> }
      check: { flags: Array<{ name: string }> }
    }
  }

  const expected = [
    "--cache",
    "--cache-clear",
    "--cache-ttl",
    "--confirm",
    "--dashboard",
    "--error-mode",
    "--format",
    "--host-key-policy",
    "--host-timeout",
    "--identity",
    "--inventory",
    "--log-dir",
    "--no-multiplex",
    "--parallelism",
    "--resource-timeout",
    "--retries",
    "--retry-delay",
    "--tags",
    "--var",
    "--verbose",
  ]

  const runFlags = cli.commands.run.flags.map((f) => f.name).sort()
  const checkFlags = cli.commands.check.flags.map((f) => f.name).sort()

  expect(runFlags).toEqual(expected)
  expect(checkFlags).toEqual(runFlags)
})

test("CLI schema does not include unsupported boolean negation forms", () => {
  const cli = getCliSchema() as {
    commands: {
      run: { flags: Array<{ name: string; negated?: string }> }
    }
  }
  const flags = new Map(cli.commands.run.flags.map((f) => [f.name, f]))
  expect(flags.get("--verbose")?.negated).toBeUndefined()
  expect(flags.get("--confirm")?.negated).toBeUndefined()
  expect(flags.get("--cache")?.negated).toBeUndefined()
})

test("formatCliForAgent uses current dashboard syntax and embeds CLI JSON", () => {
  const output = formatCliForAgent()
  expect(output.includes("ignition dashboard [address] [--var key=value] [--verbose]")).toEqual(
    true,
  )
  expect(output.includes('"name": "--log-dir"')).toEqual(true)
})

// ---------------------------------------------------------------------------
// RunSummary schema
// ---------------------------------------------------------------------------

test("getRunSummarySchema returns valid output schema", () => {
  const output = getRunSummarySchema()
  expect(output.successEnvelope).toBeDefined()
  expect(output.resourceResult).toBeDefined()
  expect(output.errorSerialization).toBeDefined()
})

// ---------------------------------------------------------------------------
// Full schema
// ---------------------------------------------------------------------------

test("getFullSchema aggregates all sections", () => {
  const full = getFullSchema()
  expect(full.resources).toBeDefined()
  expect(full.recipe).toBeDefined()
  expect(full.inventory).toBeDefined()
  expect(full.cli).toBeDefined()
  expect(full.output).toBeDefined()

  const resources = full.resources as Record<string, ResourceSchema>
  expect(Object.keys(resources).sort()).toEqual(["apt", "directory", "exec", "file", "service"])
})

// ---------------------------------------------------------------------------
// Agent format output
// ---------------------------------------------------------------------------

test("formatAllForAgent includes all resource sections", () => {
  const output = formatAllForAgent()
  expect(output.includes("## Resource: `exec`")).toEqual(true)
  expect(output.includes("## Resource: `file`")).toEqual(true)
  expect(output.includes("## Resource: `apt`")).toEqual(true)
  expect(output.includes("## Resource: `service`")).toEqual(true)
  expect(output.includes("## Resource: `directory`")).toEqual(true)
})

test("formatAllForAgent includes steering sections", () => {
  const output = formatAllForAgent()
  expect(output.includes("USE THIS RESOURCE WHEN")).toEqual(true)
  expect(output.includes("DO NOT USE FOR")).toEqual(true)
  expect(output.includes("TRIGGER PATTERNS")).toEqual(true)
  expect(output.includes("HINTS")).toEqual(true)
})

test("formatAllForAgent includes Next Steps section", () => {
  const output = formatAllForAgent()
  expect(output.includes("# Next Steps")).toEqual(true)
  expect(output.includes("ignition check")).toEqual(true)
  expect(output.includes("ignition run")).toEqual(true)
})

test("formatAllForAgent includes recipe and inventory sections", () => {
  const output = formatAllForAgent()
  expect(output.includes("# Recipe Format")).toEqual(true)
  expect(output.includes("# Inventory Format")).toEqual(true)
  expect(output.includes("# CLI Grammar")).toEqual(true)
  expect(output.includes("# Output Contracts")).toEqual(true)
})

test("formatResourceForAgent includes all schema sections for exec", () => {
  const schema = getResourceSchema("exec")!
  const output = formatResourceForAgent("exec", schema)
  expect(output.includes("## Resource: `exec`")).toEqual(true)
  expect(output.includes("USE THIS RESOURCE WHEN")).toEqual(true)
  expect(output.includes("HINTS")).toEqual(true)
  expect(output.includes("### Input")).toEqual(true)
  expect(output.includes("### Output")).toEqual(true)
  expect(output.includes("### Examples")).toEqual(true)
})

test("formatResourceListForAgent lists all resources", () => {
  const output = formatResourceListForAgent()
  expect(output.includes("exec")).toEqual(true)
  expect(output.includes("file")).toEqual(true)
  expect(output.includes("apt")).toEqual(true)
  expect(output.includes("service")).toEqual(true)
  expect(output.includes("directory")).toEqual(true)
})

// ---------------------------------------------------------------------------
// Pretty format output
// ---------------------------------------------------------------------------

test("formatResourceListPretty lists all resources", () => {
  const output = formatResourceListPretty()
  expect(output.includes("exec")).toEqual(true)
  expect(output.includes("file")).toEqual(true)
  expect(output.includes("apt")).toEqual(true)
  expect(output.includes("service")).toEqual(true)
  expect(output.includes("directory")).toEqual(true)
})

test("formatResourcePretty shows resource details", () => {
  const schema = getResourceSchema("apt")!
  const output = formatResourcePretty("apt", schema)
  expect(output.includes("Resource: apt")).toEqual(true)
  expect(output.includes("Destructive:")).toEqual(true)
  expect(output.includes("Idempotent:")).toEqual(true)
})
