import { test, expect } from "bun:test"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { aptDefinition, createApt } from "../../src/resources/apt.ts"
import type { HostContext, HostFacts, Reporter } from "../../src/core/types.ts"
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
    facts: HostFacts
  }> = {},
): ExecutionContextImpl {
  return new ExecutionContextImpl({
    connection: stubConnection(overrides.execFn),
    mode: overrides.mode ?? "apply",
    errorMode: overrides.errorMode ?? "fail-fast",
    verbose: false,
    host: stubHost(),
    reporter: silentReporter(),
    facts: overrides.facts,
  })
}

// ---------------------------------------------------------------------------
// formatName
// ---------------------------------------------------------------------------

test("formatName returns single package name", () => {
  expect(aptDefinition.formatName({ name: "nginx" })).toEqual("nginx")
})

test("formatName returns comma-separated package names", () => {
  expect(aptDefinition.formatName({ name: ["nginx", "curl"] })).toEqual("nginx, curl")
})

// ---------------------------------------------------------------------------
// check() — package installed, state present
// ---------------------------------------------------------------------------

test("check() returns in desired state when package installed and state present", async () => {
  const ctx = makeCtx({
    execFn: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
        stderr: "",
      }),
  })

  const result = await aptDefinition.check(ctx, { name: "nginx" })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.packages).toEqual({ nginx: "1.18.0-6" })
})

// ---------------------------------------------------------------------------
// check() — package not installed, state present
// ---------------------------------------------------------------------------

test("check() returns not in desired state when package missing and state present", async () => {
  const ctx = makeCtx({
    execFn: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "nginx\tdeinstall ok config-files\t1.18.0-6\n",
        stderr: "",
      }),
  })

  const result = await aptDefinition.check(ctx, { name: "nginx" })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — package installed, state absent
// ---------------------------------------------------------------------------

test("check() returns not in desired state when package installed and state absent", async () => {
  const ctx = makeCtx({
    execFn: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
        stderr: "",
      }),
  })

  const result = await aptDefinition.check(ctx, { name: "nginx", state: "absent" })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — package not installed, state absent
// ---------------------------------------------------------------------------

test("check() returns in desired state when package missing and state absent", async () => {
  const ctx = makeCtx({
    execFn: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  })

  const result = await aptDefinition.check(ctx, { name: "nginx", state: "absent" })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// check() — state latest, already latest
// ---------------------------------------------------------------------------

test("check() returns in desired state when already at latest version", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          exitCode: 0,
          stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
          stderr: "",
        })
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: "nginx:\n  Installed: 1.18.0-6\n  Candidate: 1.18.0-6\n",
        stderr: "",
      })
    },
  })

  const result = await aptDefinition.check(ctx, { name: "nginx", state: "latest" })

  expect(result.inDesiredState).toEqual(true)
})

// ---------------------------------------------------------------------------
// check() — state latest, newer available
// ---------------------------------------------------------------------------

test("check() returns not in desired state when newer version available", async () => {
  let callCount = 0
  const ctx = makeCtx({
    execFn: () => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          exitCode: 0,
          stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
          stderr: "",
        })
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: "nginx:\n  Installed: 1.18.0-6\n  Candidate: 1.20.0-1\n",
        stderr: "",
      })
    },
  })

  const result = await aptDefinition.check(ctx, { name: "nginx", state: "latest" })

  expect(result.inDesiredState).toEqual(false)
})

// ---------------------------------------------------------------------------
// check() — multiple packages
// ---------------------------------------------------------------------------

test("check() handles multiple packages", async () => {
  const ctx = makeCtx({
    execFn: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "nginx\tinstall ok installed\t1.18.0-6\ncurl\tinstall ok installed\t7.74.0-1\n",
        stderr: "",
      }),
  })

  const result = await aptDefinition.check(ctx, { name: ["nginx", "curl"] })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.packages).toEqual({ nginx: "1.18.0-6", curl: "7.74.0-1" })
})

test("check() detects missing package in multi-package input", async () => {
  const ctx = makeCtx({
    execFn: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "nginx\tinstall ok installed\t1.18.0-6\n",
        stderr: "",
      }),
  })

  const result = await aptDefinition.check(ctx, { name: ["nginx", "curl"] })

  expect(result.inDesiredState).toEqual(false)
})

test("check() fails fast with clear error when facts report non-apt manager", async () => {
  const ctx = makeCtx({
    facts: {
      distro: "rhel",
      distroId: "rocky",
      distroVersion: "9.2",
      pkgManager: "dnf",
      initSystem: "systemd",
      arch: "x86_64",
    },
    execFn: () => Promise.reject(new Error("should not execute apt commands")),
  })

  let threw = false
  try {
    await aptDefinition.check(ctx, { name: "nginx" })
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("apt resource requires apt-compatible host")
  }
  expect(threw).toEqual(true)
})

// ---------------------------------------------------------------------------
// apply() — install package
// ---------------------------------------------------------------------------

test("apply() installs package with apt-get", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("dpkg-query")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: "nginx\t1.18.0-6\n",
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await aptDefinition.apply(ctx, { name: "nginx" })

  expect(commands[0]).toEqual("sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq 'nginx'")
  expect(output.packages).toEqual({ nginx: "1.18.0-6" })
  expect(output.changed).toEqual(true)
})

// ---------------------------------------------------------------------------
// apply() — with update
// ---------------------------------------------------------------------------

test("apply() runs apt-get update when update: true", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("dpkg-query")) {
        return Promise.resolve({ exitCode: 0, stdout: "nginx\t1.18.0-6\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await aptDefinition.apply(ctx, { name: "nginx", update: true })

  expect(commands[0]).toEqual("sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq")
  expect(commands[1]).toEqual("sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq 'nginx'")
})

// ---------------------------------------------------------------------------
// apply() — remove package
// ---------------------------------------------------------------------------

test("apply() removes package when state absent", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd.includes("dpkg-query")) {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await aptDefinition.apply(ctx, { name: "nginx", state: "absent" })

  expect(commands[0]).toEqual("sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq 'nginx'")
})

test("apply() fails fast with clear error when facts report non-apt manager", async () => {
  const ctx = makeCtx({
    facts: {
      distro: "alpine",
      distroId: "alpine",
      distroVersion: "3.19",
      pkgManager: "apk",
      initSystem: "openrc",
      arch: "x86_64",
    },
    execFn: () => Promise.reject(new Error("should not execute apt commands")),
  })

  let threw = false
  try {
    await aptDefinition.apply(ctx, { name: "nginx" })
  } catch (error) {
    threw = true
    expect((error as Error).message).toContain("detected package manager 'apk'")
  }
  expect(threw).toEqual(true)
})

// ---------------------------------------------------------------------------
// createApt() — bound factory
// ---------------------------------------------------------------------------

test("createApt() returns bound function producing ResourceResult", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd.includes("dpkg-query") && cmd.includes("Status")) {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd.includes("dpkg-query")) {
        return Promise.resolve({ exitCode: 0, stdout: "nginx\t1.18.0-6\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })
  const apt = createApt(ctx)

  const result = await apt({ name: "nginx" })

  expect(result.type).toEqual("apt")
  expect(result.name).toEqual("nginx")
  expect(result.status).toEqual("changed")
  expect(result.output?.changed).toEqual(true)
})

// ---------------------------------------------------------------------------
// check mode — dry-run skips apply
// ---------------------------------------------------------------------------

test("apt in check mode returns changed without applying", async () => {
  let applyCalled = false
  const ctx = makeCtx({
    mode: "check",
    execFn: (cmd) => {
      if (cmd.includes("apt-get")) applyCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, aptDefinition, { name: "nginx" })

  expect(result.status).toEqual("changed")
  expect(applyCalled).toEqual(false)
})
