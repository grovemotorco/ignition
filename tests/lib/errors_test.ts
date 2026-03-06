import { test, expect } from "bun:test"
import { formatError } from "../../src/lib/errors.ts"
import {
  SSHConnectionError,
  SSHCommandError,
  TransferError,
  ResourceError,
  RecipeLoadError,
  InventoryError,
  CapabilityError,
} from "../../src/core/errors.ts"

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

test("formatError — includes error tag and message", () => {
  const err = new SSHConnectionError("web-1", "Connection refused")
  const output = formatError(err)

  expect(output).toContain("SSHConnectionError")
  expect(output).toContain("Connection refused")
})

test("formatError — shows host context", () => {
  const err = new SSHConnectionError("web-1", "Timeout")
  const output = formatError(err)

  expect(output).toContain("Host: web-1")
})

test("formatError — shows file context", () => {
  const err = new RecipeLoadError("/app/recipe.ts", "Syntax error")
  const output = formatError(err)

  expect(output).toContain("File: /app/recipe.ts")
})

test("formatError — shows command context", () => {
  const err = new SSHCommandError("apt-get install nginx", 1, "", "E: Unable to locate")
  const output = formatError(err)

  expect(output).toContain("Command: apt-get install nginx")
})

test("formatError — shows resource context", () => {
  const err = new ResourceError("apt", "nginx", "Package not found")
  const output = formatError(err)

  expect(output).toContain("Resource: apt (nginx)")
})

test("formatError — shows capability context", () => {
  const err = new CapabilityError("transfer", "file")
  const output = formatError(err)

  expect(output).toContain("Capability: transfer")
})

test("formatError — includes hint for SSHConnectionError", () => {
  const err = new SSHConnectionError("web-1", "refused")
  const output = formatError(err)

  expect(output).toContain("Hint:")
  expect(output).toContain("reachable")
})

test("formatError — shows port in host context when provided", () => {
  const err = new SSHConnectionError("web-1", "Connection refused", undefined, 2222)
  const output = formatError(err)

  expect(output).toContain("Host: web-1:2222")
})

test("formatError — includes hint for SSHCommandError", () => {
  const err = new SSHCommandError("ls", 1, "", "")
  const output = formatError(err)

  expect(output).toContain("--trace")
})

test("formatError — includes hint for TransferError", () => {
  const err = new TransferError("/local", "/remote", "scp failed")
  const output = formatError(err)

  expect(output).toContain("writable")
})

test("formatError — includes hint for RecipeLoadError", () => {
  const err = new RecipeLoadError("/app/r.ts", "not found")
  const output = formatError(err)

  expect(output).toContain("default export")
})

test("formatError — includes hint for InventoryError", () => {
  const err = new InventoryError("/app/inv.ts", "bad format")
  const output = formatError(err)

  expect(output).toContain("ignition schema inventory")
})

test("formatError — includes hint for ResourceError", () => {
  const err = new ResourceError("apt", "nginx", "failed")
  const output = formatError(err)

  expect(output).toContain("resource input")
})

test("formatError — includes hint for CapabilityError", () => {
  const err = new CapabilityError("transfer", "file")
  const output = formatError(err)

  expect(output).toContain("transport")
})
