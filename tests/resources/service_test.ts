import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { createService, serviceDefinition } from "../../src/resources/service.ts"
import type { HostContext, Reporter } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { ExecResult, SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubConnection(execFn?: (cmd: string) => Promise<ExecResult>): SSHConnection {
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
    exec: execFn ?? (() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
    transfer: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  }
}

function stubHost(): HostContext {
  return { name: "web-1", hostname: "10.0.1.10", user: "deploy", port: 22, vars: {} }
}

function silentReporter(): Reporter {
  return {
    resourceStart() {},
    resourceEnd() {},
  }
}

function makeCtx(
  overrides: Partial<{
    mode: "apply" | "check"
    errorMode: "fail-fast" | "fail-at-end" | "ignore"
    execFn: (cmd: string) => Promise<ExecResult>
  }> = {},
): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: stubConnection(overrides.execFn),
    mode: overrides.mode ?? "apply",
    errorMode: overrides.errorMode ?? "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
  })
}

// ---------------------------------------------------------------------------
// formatName
// ---------------------------------------------------------------------------

test("formatName returns the service name", () => {
  expect(serviceDefinition.formatName({ name: "nginx" })).toEqual("nginx")
})

// ---------------------------------------------------------------------------
// check() — service active and started desired
// ---------------------------------------------------------------------------

test("check() returns in desired state when active and state started", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "started" })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.active).toEqual("active")
})

// ---------------------------------------------------------------------------
// check() — service inactive and started desired
// ---------------------------------------------------------------------------

test("check() returns not in desired state when inactive and state started", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "started" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ state: "started" })
})

// ---------------------------------------------------------------------------
// check() — service active and stopped desired
// ---------------------------------------------------------------------------

test("check() returns not in desired state when active and state stopped", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "stopped" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ state: "stopped" })
})

// ---------------------------------------------------------------------------
// check() — service inactive and stopped desired
// ---------------------------------------------------------------------------

test("check() returns in desired state when inactive and state stopped", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "stopped" })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// check() — restarted always returns not in desired state
// ---------------------------------------------------------------------------

test("check() restarted always returns not in desired state", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "restarted" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ state: "restarted" })
})

// ---------------------------------------------------------------------------
// check() — reloaded always returns not in desired state
// ---------------------------------------------------------------------------

test("check() reloaded always returns not in desired state", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", state: "reloaded" })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — enabled mismatch
// ---------------------------------------------------------------------------

test("check() returns not in desired state when disabled and enabled desired", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", enabled: true })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ enabled: true })
})

test("check() returns not in desired state when enabled and disabled desired", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", enabled: false })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({ enabled: false })
})

// ---------------------------------------------------------------------------
// check() — enabled matches
// ---------------------------------------------------------------------------

test("check() returns in desired state when enabled matches", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await serviceDefinition.check(ctx, { name: "nginx", enabled: true })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// apply() — start service
// ---------------------------------------------------------------------------

test("apply() starts service", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await serviceDefinition.apply(ctx, { name: "nginx", state: "started" })

  expect(commands[0]).toEqual("sudo systemctl start 'nginx'")
  expect(output.changed).toEqual(true)
  expect(output.active).toEqual("active")
})

// ---------------------------------------------------------------------------
// apply() — stop service
// ---------------------------------------------------------------------------

test("apply() stops service", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await serviceDefinition.apply(ctx, { name: "nginx", state: "stopped" })

  expect(commands[0]).toEqual("sudo systemctl stop 'nginx'")
})

// ---------------------------------------------------------------------------
// apply() — restart service
// ---------------------------------------------------------------------------

test("apply() restarts service", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await serviceDefinition.apply(ctx, { name: "nginx", state: "restarted" })

  expect(commands[0]).toEqual("sudo systemctl restart 'nginx'")
})

// ---------------------------------------------------------------------------
// apply() — reload service
// ---------------------------------------------------------------------------

test("apply() reloads service", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await serviceDefinition.apply(ctx, { name: "nginx", state: "reloaded" })

  expect(commands[0]).toEqual("sudo systemctl reload 'nginx'")
})

// ---------------------------------------------------------------------------
// apply() — enable service
// ---------------------------------------------------------------------------

test("apply() enables service", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await serviceDefinition.apply(ctx, { name: "nginx", enabled: true })

  expect(commands[0]).toEqual("sudo systemctl enable 'nginx'")
})

// ---------------------------------------------------------------------------
// apply() — disable service
// ---------------------------------------------------------------------------

test("apply() disables service", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await serviceDefinition.apply(ctx, { name: "nginx", enabled: false })

  expect(commands[0]).toEqual("sudo systemctl disable 'nginx'")
})

// ---------------------------------------------------------------------------
// apply() — state + enabled combined
// ---------------------------------------------------------------------------

test("apply() handles state and enabled together", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await serviceDefinition.apply(ctx, { name: "nginx", state: "started", enabled: true })

  expect(commands[0]).toEqual("sudo systemctl start 'nginx'")
  expect(commands[1]).toEqual("sudo systemctl enable 'nginx'")
})

// ---------------------------------------------------------------------------
// createService() — bound factory
// ---------------------------------------------------------------------------

test("createService() returns bound function producing ResourceResult", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: (cmd) => {
      callCount++
      // check phase: is-active, is-enabled
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
      if (callCount === 2) return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
      // apply phase: start, then is-active, is-enabled
      if (cmd.includes("is-active"))
        return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      if (cmd.includes("is-enabled"))
        return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })
  const service = createService(ctx)

  const result = await service({ name: "nginx", state: "started" })

  expect(result.type).toEqual("service")
  expect(result.name).toEqual("nginx")
  expect(result.status).toEqual("changed")
  expect(result.output?.changed).toEqual(true)
})

// ---------------------------------------------------------------------------
// check mode — dry-run skips apply
// ---------------------------------------------------------------------------

test("service in check mode returns changed without applying", async () => {
  let applyCalled = false
  let callCount = 0
  const ctx = makeCtx({
    mode: "check",
    execFn: (_cmd) => {
      callCount++
      if (callCount <= 2) {
        if (callCount === 1)
          return Promise.resolve({ exitCode: 0, stdout: "inactive\n", stderr: "" })
        return Promise.resolve({ exitCode: 0, stdout: "disabled\n", stderr: "" })
      }
      applyCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, serviceDefinition, { name: "nginx", state: "started" })

  expect(result.status).toEqual("changed")
  expect(applyCalled).toEqual(false)
})

// ---------------------------------------------------------------------------
// already in desired state returns ok
// ---------------------------------------------------------------------------

test("service returns ok when already in desired state", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) return Promise.resolve({ exitCode: 0, stdout: "active\n", stderr: "" })
      return Promise.resolve({ exitCode: 0, stdout: "enabled\n", stderr: "" })
    },
  })

  const result = await executeResource(ctx, serviceDefinition, {
    name: "nginx",
    state: "started",
    enabled: true,
  })

  expect(result.status).toEqual("ok")
})
