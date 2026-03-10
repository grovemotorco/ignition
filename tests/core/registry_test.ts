import { test, expect } from "bun:test"
import {
  defaultRegistry,
  getAllDefinitions,
  getAllResourceSchemas,
  getDefinition,
  getInventorySchema,
  getRecipeSchema,
  getResourceSchema,
  getResourceTypes,
  getRunSummarySchema,
  ResourceRegistry,
} from "../../src/core/registry.ts"
import type { CheckResult, ExecutionContext, ResourceDefinition } from "../../src/core/types.ts"
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

test("defaultRegistry has all 6 built-in resources", () => {
  expect([...defaultRegistry.types()].sort()).toEqual([
    "apt",
    "directory",
    "docker",
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
  expect(resources.docker).toBeDefined()
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
  expect(Object.keys(resources).sort()).toEqual([
    "apt",
    "directory",
    "docker",
    "exec",
    "file",
    "service",
  ])
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

test("getAllDefinitions returns all 6 resources", () => {
  const defs = getAllDefinitions()
  expect(defs.size).toEqual(6)
  expect([...defs.keys()].sort()).toEqual(["apt", "directory", "docker", "exec", "file", "service"])
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
  expect(types.sort()).toEqual(["apt", "directory", "docker", "exec", "file", "service"])
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

test("getAllResourceSchemas returns 6 schemas", () => {
  const schemas = getAllResourceSchemas()
  expect(schemas.size).toEqual(6)
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

test("docker annotations: destructive, non-idempotent, imperative", () => {
  const schema = getResourceSchema("docker")!
  expect(schema.annotations.destructive).toEqual(true)
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
  const destructiveResources = ["file", "apt", "docker", "directory"]
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
// RunSummary schema
// ---------------------------------------------------------------------------

test("getRunSummarySchema returns valid output schema", () => {
  const output = getRunSummarySchema()
  expect(output.successEnvelope).toBeDefined()
  expect(output.resourceResult).toBeDefined()
  expect(output.errorSerialization).toBeDefined()
})
