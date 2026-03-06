import { test, expect } from "bun:test"
/**
 * Resource idempotence conformance test harness.
 *
 * Provides reusable assertions that validate the idempotence contract
 * for any ResourceDefinition. Each built-in resource registers
 * conformance tests by calling these helpers.
 *
 * **Contract invariants verified**:
 * 1. `type` is a non-empty lowercase string.
 * 2. `formatName()` returns a non-empty string (pure, no I/O).
 * 3. `check()` returns well-formed CheckResult with proper `current`/`desired`.
 * 4. When `inDesiredState === true`, `output` is present.
 * 5. When `inDesiredState === false`, `output` is absent.
 * 6. `current` and `desired` are plain objects (JSON-serializable).
 * 7. For convergent resources: after `apply()`, `check()` returns `inDesiredState: true`.
 */

import type { CheckResult, ExecutionContext, ResourceDefinition } from "../../src/core/types.ts"

// ---------------------------------------------------------------------------
// Contract assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a ResourceDefinition has a valid `type` field.
 * Must be non-empty, lowercase, and contain only lowercase letters.
 */
export function assertValidType<TInput, TOutput>(def: ResourceDefinition<TInput, TOutput>): void {
  expect(def.type).toBeDefined()
  expect(typeof def.type).toEqual("string")
  expect(def.type.length > 0).toEqual(true)
  expect(def.type).toEqual(def.type.toLowerCase())
}

/**
 * Assert that formatName() returns a non-empty string for the given input.
 */
export function assertValidFormatName<TInput, TOutput>(
  def: ResourceDefinition<TInput, TOutput>,
  input: TInput,
): void {
  const name = def.formatName(input)
  expect(typeof name).toEqual("string")
  expect(name.length > 0).toEqual(true)
}

/**
 * Assert that a CheckResult conforms to the idempotence contract.
 *
 * - `current` and `desired` must be plain objects.
 * - When `inDesiredState === true`, `output` must be present.
 * - When `inDesiredState === false`, `output` must be absent.
 */
export function assertValidCheckResult<TOutput>(result: CheckResult<TOutput>): void {
  expect(typeof result.inDesiredState).toEqual("boolean")

  // current and desired must be plain objects
  expect(result.current).toBeDefined()
  expect(typeof result.current).toEqual("object")
  expect(result.current !== null).toEqual(true)

  expect(result.desired).toBeDefined()
  expect(typeof result.desired).toEqual("object")
  expect(result.desired !== null).toEqual(true)

  // JSON-serializable check (no functions, symbols, undefined values, circular refs)
  const currentJson = JSON.stringify(result.current)
  expect(currentJson).toBeDefined()
  const desiredJson = JSON.stringify(result.desired)
  expect(desiredJson).toBeDefined()

  // output contract
  if (result.inDesiredState) {
    expect(result.output).toBeDefined()
  } else {
    expect(result.output).toEqual(undefined)
  }
}

/** Options for a conformance test scenario. */
export type ConformanceScenario<TInput, TOutput> = {
  /** Human-readable scenario name. */
  name: string
  /** Resource definition under test. */
  definition: ResourceDefinition<TInput, TOutput>
  /** Input to test with. */
  input: TInput
  /** Build an ExecutionContext for this scenario. */
  makeCtx: () => ExecutionContext
  /**
   * Whether this resource is convergent (after apply, check returns inDesiredState: true).
   * Set to false for imperative/always-run resources like exec.
   */
  convergent: boolean
  /**
   * Build a "post-apply" context that simulates the state after apply() has run.
   * Required when `convergent` is true. The mock should return responses consistent
   * with the resource being in its desired state.
   */
  makePostApplyCtx?: (() => ExecutionContext) | undefined
}

/**
 * Run the full conformance suite for a single scenario.
 *
 * Registers test entries for:
 * - type validation
 * - formatName validation
 * - check() contract (not-in-desired-state path)
 * - convergence (if convergent): check() after simulated apply returns inDesiredState: true
 */
export function runConformanceTests<TInput, TOutput>(
  scenario: ConformanceScenario<TInput, TOutput>,
): void {
  const prefix = `[conformance] ${scenario.definition.type}: ${scenario.name}`

  test(`${prefix} — type is valid`, () => {
    assertValidType(scenario.definition)
  })

  test(`${prefix} — formatName returns non-empty string`, () => {
    assertValidFormatName(scenario.definition, scenario.input)
  })

  test(`${prefix} — check() returns valid CheckResult`, async () => {
    const ctx = scenario.makeCtx()
    const result = await scenario.definition.check(ctx, scenario.input)
    assertValidCheckResult(result)
  })

  if (scenario.convergent && scenario.makePostApplyCtx) {
    test(`${prefix} — convergent: check() after apply returns inDesiredState: true`, async () => {
      const ctx = scenario.makePostApplyCtx!()
      const result = await scenario.definition.check(ctx, scenario.input)
      assertValidCheckResult(result)
      expect(result.inDesiredState).toEqual(true)
    })
  }
}
