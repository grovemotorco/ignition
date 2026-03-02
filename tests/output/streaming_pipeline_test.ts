import { test, expect } from "bun:test"
/**
 * Integration test: full streaming pipeline.
 *
 * Exercises the complete path from mock SSH transport with streaming callbacks
 * through executeResource (verbose mode) → EventBus → dashboard state reducer.
 * Verifies that output produced by a resource's exec() calls flows end-to-end
 * into the UI state model.
 *
 * ISSUE-0037
 */

import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { EventBus } from "../../src/output/events.ts"
import type { LifecycleEvent } from "../../src/output/events.ts"
import { createInitialState, eventReducer } from "../../src/dashboard/ui/src/state.ts"
import type { LifecycleEvent as UILifecycleEvent } from "../../src/dashboard/ui/src/state.ts"
import { createMockHost, createMockSSH, silentReporter } from "../fixtures/mock_ssh.ts"
import type { ExecOptions, ExecResult } from "../../src/ssh/types.ts"
import type { ResourceDefinition } from "../../src/core/types.ts"

test("full pipeline: mock SSH → executeResource → EventBus → dashboard reducer", async () => {
  // --- Layer 1: Mock transport that produces output ---
  const { connection } = createMockSSH({
    exec: (_cmd: string, _opts?: ExecOptions): Promise<ExecResult> => {
      // The mock fixture invokes onStdout/onStderr with the returned
      // stdout/stderr, so we just need to return meaningful output.
      return Promise.resolve({
        exitCode: 0,
        stdout: "installed nginx 1.24\n",
        stderr: "dpkg: warning: overriding\n",
      })
    },
  })

  // --- Layer 2: EventBus collects all lifecycle events ---
  const bus = new EventBus("test-run")
  const events: LifecycleEvent[] = []
  bus.on((e) => events.push(e))

  // Simulate run/host start so correlation context exists
  bus.runStarted("apply", "fail-fast", 1)
  const hostId = bus.nextId()
  bus.hostStarted(hostId, {
    name: "web-1",
    hostname: "10.0.1.10",
    user: "deploy",
    port: 22,
    vars: {},
  })

  // --- Layer 3: executeResource with verbose=true ---
  const def: ResourceDefinition<{ pkg: string }, string> = {
    type: "apt",
    formatName: (input) => input.pkg,
    check: (ctx, _input) =>
      ctx.connection.exec("dpkg-query -W nginx").then(() => ({
        inDesiredState: false,
        current: { installed: false },
        desired: { installed: true },
      })),
    apply: (ctx, _input) => ctx.connection.exec("apt-get install -y nginx").then(() => "installed"),
  }

  const ctx = new ExecutionContextImpl({
    connection,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: true,
    host: createMockHost(),
    reporter: silentReporter(),
    eventBus: bus,
    hostCorrelationId: hostId,
  })

  await executeResource(ctx, def, { pkg: "nginx" }, { retries: 0, timeoutMs: 0 })

  // --- Layer 4: Verify event pipeline contains output events ---
  const outputEvents = events.filter((e) => e.type === "resource_output")
  // check() and apply() each produce stdout + stderr = 4 output events
  expect(outputEvents.length).toEqual(4)

  // --- Layer 5: Feed events through dashboard reducer ---
  let state = createInitialState()
  for (const event of events) {
    // Events from EventBus are serialized as JSON over WebSocket.
    // Round-trip through JSON to match real dashboard behavior.
    const uiEvent = JSON.parse(JSON.stringify(event)) as UILifecycleEvent
    state = eventReducer(state, uiEvent)
  }

  // Verify the dashboard state accumulated output on the resource
  const host = state.hosts.get(hostId)
  expect(host !== undefined).toEqual(true)

  // Find the resource — it should be the only one
  const resources = [...host!.resources.values()]
  expect(resources.length).toEqual(1)

  const resource = resources[0]
  expect(resource.type).toEqual("apt")
  expect(resource.name).toEqual("nginx")
  expect(resource.status).toEqual("changed")

  // Output should contain all 4 chunks (2 from check, 2 from apply)
  expect(resource.output.length).toEqual(4)
  expect(resource.output[0]).toEqual({ stream: "stdout", text: "installed nginx 1.24" })
  expect(resource.output[1]).toEqual({ stream: "stderr", text: "dpkg: warning: overriding" })
  expect(resource.output[2]).toEqual({ stream: "stdout", text: "installed nginx 1.24" })
  expect(resource.output[3]).toEqual({ stream: "stderr", text: "dpkg: warning: overriding" })
})

test("full pipeline: verbose=false still emits output events to event bus", async () => {
  const { connection } = createMockSSH({
    exec: (): Promise<ExecResult> =>
      Promise.resolve({ exitCode: 0, stdout: "some output\n", stderr: "" }),
  })

  const bus = new EventBus("test-run")
  const events: LifecycleEvent[] = []
  bus.on((e) => events.push(e))

  bus.runStarted("apply", "fail-fast", 1)
  const hostId = bus.nextId()
  bus.hostStarted(hostId, {
    name: "web-1",
    hostname: "10.0.1.10",
    user: "deploy",
    port: 22,
    vars: {},
  })

  const def: ResourceDefinition<{ cmd: string }, string> = {
    type: "exec",
    formatName: (input) => input.cmd,
    check: (ctx, input) =>
      ctx.connection.exec(input.cmd).then(() => ({
        inDesiredState: true,
        current: {},
        desired: {},
        output: "done",
      })),
    apply: () => Promise.resolve("done"),
  }

  const reporter = silentReporter()
  const reporterCalls: string[] = []
  reporter.resourceOutput = (_type, _name, stream, _chunk) => {
    reporterCalls.push(stream)
  }

  const ctx = new ExecutionContextImpl({
    connection,
    mode: "apply",
    errorMode: "fail-fast",
    verbose: false,
    host: createMockHost(),
    reporter,
    eventBus: bus,
    hostCorrelationId: hostId,
  })

  await executeResource(ctx, def, { cmd: "whoami" }, { retries: 0, timeoutMs: 0 })

  // Output events ARE emitted to event bus even with verbose=false
  const outputEvents = events.filter((e) => e.type === "resource_output")
  expect(outputEvents.length).toBeGreaterThan(0)

  // Reporter should NOT receive output calls (verbose=false suppresses terminal display)
  expect(reporterCalls.length).toEqual(0)

  // Dashboard state should have output on the resource
  let state = createInitialState()
  for (const event of events) {
    const uiEvent = JSON.parse(JSON.stringify(event)) as UILifecycleEvent
    state = eventReducer(state, uiEvent)
  }

  const host = state.hosts.get(hostId)!
  const resources = [...host.resources.values()]
  expect(resources.length).toEqual(1)
  expect(resources[0].output.length).toBeGreaterThan(0)
})
