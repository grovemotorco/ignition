import { test, expect } from "bun:test"
import { expectRejection } from "../helpers/expect-error.ts"
import { ExecutionContextImpl } from "../../src/core/context.ts"
import { executeResource } from "../../src/core/resource.ts"
import { createDocker, dockerDefinition } from "../../src/resources/docker.ts"
import type { HostContext, Reporter } from "../../src/core/types.ts"
import { ALL_TRANSPORT_CAPABILITIES } from "../../src/ssh/types.ts"
import type { ExecResult, SSHConnection, SSHConnectionConfig } from "../../src/ssh/types.ts"

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

function inspectStdout(value: unknown): string {
  return JSON.stringify([value])
}

function imageInspect(
  overrides: Partial<{
    id: string
    env: string[]
    cmd: string[]
    entrypoint: string[]
    labels: Record<string, string>
    user: string
    workdir: string
  }> = {},
) {
  return {
    Id: overrides.id ?? "sha256:image-v1",
    Config: {
      Env: overrides.env ?? ["BASE=1"],
      Cmd: overrides.cmd ?? ["serve"],
      Entrypoint: overrides.entrypoint ?? ["/bin/app"],
      Labels: overrides.labels ?? { base: "true" },
      User: overrides.user ?? "",
      WorkingDir: overrides.workdir ?? "/app",
    },
  }
}

function containerInspect(
  overrides: Partial<{
    id: string
    image: string
    imageId: string
    env: string[]
    cmd: string[]
    entrypoint: string[]
    labels: Record<string, string>
    user: string
    workdir: string
    running: boolean
    portBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }>>
    mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>
    restart: string
  }> = {},
) {
  return {
    Id: overrides.id ?? "container-1",
    Image: overrides.imageId ?? "sha256:image-v1",
    Config: {
      Image: overrides.image ?? "ghcr.io/acme/web:1.0.0",
      Env: overrides.env ?? ["BASE=1"],
      Cmd: overrides.cmd ?? ["serve"],
      Entrypoint: overrides.entrypoint ?? ["/bin/app"],
      Labels: overrides.labels ?? { base: "true" },
      User: overrides.user ?? "",
      WorkingDir: overrides.workdir ?? "/app",
    },
    HostConfig: {
      PortBindings: overrides.portBindings ?? {},
      RestartPolicy: {
        Name: overrides.restart ?? "no",
      },
    },
    Mounts: overrides.mounts ?? [],
    State: {
      Running: overrides.running ?? true,
    },
  }
}

const BASE_INPUT = {
  name: "web",
  image: "ghcr.io/acme/web:1.0.0",
} as const

test("formatName returns the container name", () => {
  expect(dockerDefinition.formatName(BASE_INPUT)).toEqual("web")
})

test("check() rejects invalid container names before running docker commands", async () => {
  let execCalled = false
  const ctx = makeCtx({
    execFn: () => {
      execCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() =>
    dockerDefinition.check(ctx, { ...BASE_INPUT, name: "bad name" }),
  )
  expect(err.message).toContain("valid container name")
  expect(execCalled).toEqual(false)
})

test("check() rejects invalid state values before running docker commands", async () => {
  let execCalled = false
  const ctx = makeCtx({
    execFn: () => {
      execCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() =>
    dockerDefinition.check(ctx, { ...BASE_INPUT, state: "paused" as any }),
  )
  expect(err.message).toContain("invalid state")
  expect(execCalled).toEqual(false)
})

test("check() rejects duplicate published host bindings before running docker commands", async () => {
  let execCalled = false
  const ctx = makeCtx({
    execFn: () => {
      execCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() =>
    dockerDefinition.check(ctx, {
      ...BASE_INPUT,
      ports: [
        { hostPort: 8080, containerPort: 80 },
        { hostPort: 8080, containerPort: 81 },
      ],
    }),
  )
  expect(err.message).toContain("duplicate published host binding")
  expect(execCalled).toEqual(false)
})

test("check() rejects empty user overrides before running docker commands", async () => {
  let execCalled = false
  const ctx = makeCtx({
    execFn: () => {
      execCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() => dockerDefinition.check(ctx, { ...BASE_INPUT, user: "" }))
  expect(err.message).toContain("empty user override")
  expect(execCalled).toEqual(false)
})

test("check() fails fast when docker CLI is missing", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() => dockerDefinition.check(ctx, BASE_INPUT))
  expect(err.message).toContain("docker resource requires Docker CLI")
})

test("check() fails fast when docker daemon is unreachable", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "permission denied" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() => dockerDefinition.check(ctx, BASE_INPUT))
  expect(err.message).toContain("docker resource requires a reachable Docker daemon")
})

test("check() returns changed when image is missing and pull is if-missing", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error: No such object: web" })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Error response from daemon: No such image: ghcr.io/acme/web:1.0.0",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, BASE_INPUT)

  expect(result.inDesiredState).toEqual(false)
  expect(result.current).toEqual({
    image: { ref: "ghcr.io/acme/web:1.0.0", present: false, id: "" },
    container: null,
  })
  expect(result.desired).toEqual({
    state: "started",
    pull: "if-missing",
    image: { ref: "ghcr.io/acme/web:1.0.0", id: "" },
    spec: {},
  })
})

test("check() fails when image is missing and pull is never", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error: No such object: web" })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "Error response from daemon: No such image: ghcr.io/acme/web:1.0.0",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const err = await expectRejection(() =>
    dockerDefinition.check(ctx, { ...BASE_INPUT, pull: "never" }),
  )
  expect(err.message).toContain("requires local image")
})

test("check() reports the inspected image snapshot when the container is missing", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error: No such object: web" })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect({ id: "sha256:image-v2" })),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, BASE_INPUT)

  expect(result.inDesiredState).toEqual(false)
  expect(result.current).toEqual({
    image: { ref: "ghcr.io/acme/web:1.0.0", present: true, id: "sha256:image-v2" },
    container: null,
  })
  expect(result.desired).toEqual({
    state: "started",
    pull: "if-missing",
    image: { ref: "ghcr.io/acme/web:1.0.0", id: "sha256:image-v2" },
    spec: {
      image: "ghcr.io/acme/web:1.0.0",
      imageId: "sha256:image-v2",
      env: { BASE: "1" },
      ports: [],
      mounts: [],
      restart: "no",
      command: ["serve"],
      entrypoint: ["/bin/app"],
      labels: { base: "true" },
      user: "",
      workdir: "/app",
    },
  })
})

test("check() returns ok when container matches desired state", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, BASE_INPUT)

  expect(result.inDesiredState).toEqual(true)
  expect(result.output).toEqual({
    name: "web",
    image: "ghcr.io/acme/web:1.0.0",
    imageId: "sha256:image-v1",
    containerId: "container-1",
    state: "running",
    changed: false,
  })
})

test("check() treats stopped containers as converged for state present", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect({ running: false })),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, { ...BASE_INPUT, state: "present" })

  expect(result.inDesiredState).toEqual(true)
  expect(result.output?.state).toEqual("stopped")
  expect(result.output?.changed).toEqual(false)
})

test("check() detects config drift and returns desired diff", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              env: ["BASE=1", "APP_ENV=dev"],
              portBindings: { "80/tcp": [{ HostPort: "8080" }] },
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, {
    ...BASE_INPUT,
    env: { APP_ENV: "prod" },
    ports: [{ hostPort: 8080, containerPort: 80 }],
  })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({
    state: "started",
    pull: "if-missing",
    image: { ref: "ghcr.io/acme/web:1.0.0", id: "sha256:image-v1" },
    spec: {
      env: { APP_ENV: "prod", BASE: "1" },
    },
  })
})

test("check() detects image ID drift", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect({ imageId: "sha256:image-old" })),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect({ id: "sha256:image-v2" })),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, BASE_INPUT)

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({
    state: "started",
    pull: "if-missing",
    image: { ref: "ghcr.io/acme/web:1.0.0", id: "sha256:image-v2" },
    spec: {
      imageId: "sha256:image-v2",
    },
  })
})

test("check() detects image reference drift even when the image ID matches", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              image: "ghcr.io/acme/web:1.0.0",
              imageId: "sha256:image-v1",
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:stable'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect({ id: "sha256:image-v1" })),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, {
    ...BASE_INPUT,
    image: "ghcr.io/acme/web:stable",
  })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({
    state: "started",
    pull: "if-missing",
    image: { ref: "ghcr.io/acme/web:stable", id: "sha256:image-v1" },
    spec: {
      image: "ghcr.io/acme/web:stable",
    },
  })
})

test("check() detects entrypoint clear drift", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, { ...BASE_INPUT, entrypoint: [] })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({
    state: "started",
    pull: "if-missing",
    image: { ref: "ghcr.io/acme/web:1.0.0", id: "sha256:image-v1" },
    spec: {
      entrypoint: [],
    },
  })
})

test("check() with state absent reports only the observed container state", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, { name: "web", state: "absent" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.current).toMatchObject({
    container: {
      id: "container-1",
      state: "running",
    },
  })
  expect("image" in result.current).toEqual(false)
  expect(result.desired).toEqual({ state: "absent" })
})

test("check() with pull always always returns changed", async () => {
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await dockerDefinition.check(ctx, { ...BASE_INPUT, pull: "always" })

  expect(result.inDesiredState).toEqual(false)
  expect(result.desired).toEqual({
    state: "started",
    pull: "always",
    image: { ref: "ghcr.io/acme/web:1.0.0", id: "sha256:image-v1" },
    spec: {
      image: "ghcr.io/acme/web:1.0.0",
      imageId: "sha256:image-v1",
      env: { BASE: "1" },
      ports: [],
      mounts: [],
      restart: "no",
      command: ["serve"],
      entrypoint: ["/bin/app"],
      labels: { base: "true" },
      user: "",
      workdir: "/app",
    },
  })
})

test("apply() pulls, creates, and starts a missing container", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        if (commands.filter((c) => c === cmd).length === 1) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error: No such object: web" })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              env: ["BASE=1", "APP_ENV=prod"],
              labels: { base: "true", managed: "yes" },
              user: "1000:1000",
              workdir: "/srv/app",
              portBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
              mounts: [
                {
                  Type: "bind",
                  Source: "/srv/data",
                  Destination: "/data",
                  RW: false,
                },
              ],
              restart: "unless-stopped",
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        if (commands.filter((c) => c === cmd).length === 1) {
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "Error response from daemon: No such image: ghcr.io/acme/web:1.0.0",
          })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker pull 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({ exitCode: 0, stdout: "Pulled\n", stderr: "" })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-1\n", stderr: "" })
      }
      if (cmd === "docker start 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, {
    ...BASE_INPUT,
    env: { APP_ENV: "prod" },
    ports: [{ hostPort: 8080, containerPort: 80, hostIp: "127.0.0.1" }],
    mounts: [{ source: "/srv/data", target: "/data", readOnly: true }],
    restart: "unless-stopped",
    labels: { managed: "yes" },
    user: "1000:1000",
    workdir: "/srv/app",
  })

  expect(commands).toContain("docker pull 'ghcr.io/acme/web:1.0.0'")
  const createCommand = commands.find((cmd) => cmd.startsWith("'docker' 'create'"))
  expect(createCommand).toContain("'--name' 'web'")
  expect(createCommand).toContain("'-e' 'APP_ENV=prod'")
  expect(createCommand).toContain("'-p' '127.0.0.1:8080:80/tcp'")
  expect(createCommand).toContain("'--mount' 'type=bind,src=/srv/data,dst=/data,readonly'")
  expect(createCommand).toContain("'--restart' 'unless-stopped'")
  expect(createCommand).toContain("'--label' 'managed=yes'")
  expect(createCommand).toContain("'--user' '1000:1000'")
  expect(createCommand).toContain("'--workdir' '/srv/app'")
  expect(output).toEqual({
    name: "web",
    image: "ghcr.io/acme/web:1.0.0",
    imageId: "sha256:image-v1",
    containerId: "container-1",
    state: "running",
    changed: true,
  })
})

test("apply() reports changed false when pull always is already up to date", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker pull 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "Status: Image is up to date for ghcr.io/acme/web:1.0.0\n",
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, { ...BASE_INPUT, pull: "always" })

  expect(commands.filter((cmd) => cmd === "docker inspect --type container 'web'").length).toEqual(
    2,
  )
  expect(commands).toContain("docker pull 'ghcr.io/acme/web:1.0.0'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(false)
  expect(commands).not.toContain("docker rm -f 'web'")
  expect(commands).not.toContain("docker start 'web'")
  expect(commands).not.toContain("docker stop 'web'")
  expect(output.changed).toEqual(false)
})

test("apply() treats unrecognized pull output as unchanged when no drift remains", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker pull 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "Digest: sha256:image-v1\n",
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, { ...BASE_INPUT, pull: "always" })

  expect(commands).toContain("docker pull 'ghcr.io/acme/web:1.0.0'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(false)
  expect(commands).not.toContain("docker rm -f 'web'")
  expect(commands).not.toContain("docker start 'web'")
  expect(output.changed).toEqual(false)
})

test("apply() recreates a container when image ID drifts", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        const seen = commands.filter((value) => value === cmd).length
        if (seen === 1) {
          return Promise.resolve({
            exitCode: 0,
            stdout: inspectStdout(containerInspect({ imageId: "sha256:image-old" })),
            stderr: "",
          })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect({ imageId: "sha256:image-v2" })),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect({ id: "sha256:image-v2" })),
          stderr: "",
        })
      }
      if (cmd === "docker rm -f 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-2\n", stderr: "" })
      }
      if (cmd === "docker start 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, BASE_INPUT)

  expect(commands).toContain("docker rm -f 'web'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(true)
  expect(commands).toContain("docker start 'web'")
  expect(output.imageId).toEqual("sha256:image-v2")
})

test("apply() recreates a container when the image reference drifts", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        const seen = commands.filter((value) => value === cmd).length
        if (seen === 1) {
          return Promise.resolve({
            exitCode: 0,
            stdout: inspectStdout(
              containerInspect({
                image: "ghcr.io/acme/web:1.0.0",
                imageId: "sha256:image-v1",
              }),
            ),
            stderr: "",
          })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              image: "ghcr.io/acme/web:stable",
              imageId: "sha256:image-v1",
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:stable'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect({ id: "sha256:image-v1" })),
          stderr: "",
        })
      }
      if (cmd === "docker rm -f 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-2\n", stderr: "" })
      }
      if (cmd === "docker start 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, {
    ...BASE_INPUT,
    image: "ghcr.io/acme/web:stable",
  })

  expect(commands).toContain("docker rm -f 'web'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(true)
  expect(commands).toContain("docker start 'web'")
  expect(output.image).toEqual("ghcr.io/acme/web:stable")
})

test("apply() creates a present container without starting it and preserves split entrypoint argv", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        if (commands.filter((value) => value === cmd).length === 1) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error: No such object: web" })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              running: false,
              entrypoint: ["/bin/sh"],
              cmd: ["-lc", "echo", "hello"],
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-1\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, {
    ...BASE_INPUT,
    state: "present",
    entrypoint: ["/bin/sh", "-lc"],
    command: ["echo", "hello"],
  })

  const createCommand = commands.find((cmd) => cmd.startsWith("'docker' 'create'"))
  expect(createCommand).toContain("'--entrypoint' '/bin/sh'")
  expect(createCommand).toContain("'ghcr.io/acme/web:1.0.0' '-lc' 'echo' 'hello'")
  expect(commands).not.toContain("docker start 'web'")
  expect(output.state).toEqual("stopped")
  expect(output.changed).toEqual(true)
})

test("apply() preserves running state when recreating a present container", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        const seen = commands.filter((value) => value === cmd).length
        if (seen === 1) {
          return Promise.resolve({
            exitCode: 0,
            stdout: inspectStdout(
              containerInspect({
                running: true,
                env: ["BASE=1", "APP_ENV=dev"],
              }),
            ),
            stderr: "",
          })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              running: true,
              env: ["BASE=1", "APP_ENV=prod"],
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker rm -f 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-2\n", stderr: "" })
      }
      if (cmd === "docker start 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, {
    ...BASE_INPUT,
    state: "present",
    env: { APP_ENV: "prod" },
  })

  expect(commands).toContain("docker rm -f 'web'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(true)
  expect(commands).toContain("docker start 'web'")
  expect(output.state).toEqual("running")
  expect(output.changed).toEqual(true)
})

test("apply() stops a matching running container for state stopped", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        const seen = commands.filter((value) => value === cmd).length
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect({ running: seen === 1 })),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker stop 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, { ...BASE_INPUT, state: "stopped" })

  expect(commands).toContain("docker stop 'web'")
  expect(output.state).toEqual("stopped")
  expect(output.changed).toEqual(true)
})

test("apply() removes a container when state is absent", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker rm -f 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const output = await dockerDefinition.apply(ctx, { name: "web", state: "absent" })

  expect(commands).toContain("docker rm -f 'web'")
  expect(output).toEqual({
    name: "web",
    image: "",
    imageId: "",
    containerId: "",
    state: "absent",
    changed: true,
  })
})

test("createDocker() returns a bound function producing ResourceResult", async () => {
  let inspectCount = 0
  const ctx = makeCtx({
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        inspectCount++
        if (inspectCount <= 2) {
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "Error: No such object: web",
          })
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-1\n", stderr: "" })
      }
      if (cmd === "docker start 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })
  const docker = createDocker(ctx)

  const result = await docker(BASE_INPUT)

  expect(result.type).toEqual("docker")
  expect(result.name).toEqual("web")
  expect(result.status).toEqual("changed")
  expect(result.output?.changed).toEqual(true)
})

test("docker in check mode returns changed without applying", async () => {
  let applyCalled = false
  const ctx = makeCtx({
    mode: "check",
    execFn: (cmd) => {
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Error: No such object: web" })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      applyCalled = true
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, dockerDefinition, BASE_INPUT)

  expect(result.status).toEqual("changed")
  expect(applyCalled).toEqual(false)
})

test("docker in apply mode reports ok when pull always makes no changes", async () => {
  const commands: string[] = []
  const ctx = makeCtx({
    mode: "apply",
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(containerInspect()),
          stderr: "",
        })
      }
      if (cmd === "docker pull 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "Digest: sha256:image-v1\n",
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(imageInspect()),
          stderr: "",
        })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(ctx, dockerDefinition, { ...BASE_INPUT, pull: "always" })

  expect(result.status).toEqual("ok")
  expect(result.output).toEqual({
    name: "web",
    image: "ghcr.io/acme/web:1.0.0",
    imageId: "sha256:image-v1",
    containerId: "container-1",
    state: "running",
    changed: false,
  })
  expect(commands).toContain("docker pull 'ghcr.io/acme/web:1.0.0'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(false)
  expect(commands).not.toContain("docker rm -f 'web'")
  expect(commands).not.toContain("docker start 'web'")
})

test("docker with pull always passes post-check after apply refreshes the image", async () => {
  const commands: string[] = []
  let containerInspectCount = 0
  let imageInspectCount = 0
  const ctx = makeCtx({
    mode: "apply",
    execFn: (cmd) => {
      commands.push(cmd)
      if (cmd === "command -v docker >/dev/null 2>&1" || cmd === "docker info >/dev/null 2>&1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      if (cmd === "docker inspect --type container 'web'") {
        containerInspectCount++
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            containerInspect({
              imageId: containerInspectCount <= 2 ? "sha256:image-old" : "sha256:image-v2",
            }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker image inspect 'ghcr.io/acme/web:1.0.0'") {
        imageInspectCount++
        return Promise.resolve({
          exitCode: 0,
          stdout: inspectStdout(
            imageInspect({ id: imageInspectCount === 1 ? "sha256:image-old" : "sha256:image-v2" }),
          ),
          stderr: "",
        })
      }
      if (cmd === "docker pull 'ghcr.io/acme/web:1.0.0'") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "Status: Downloaded newer image for ghcr.io/acme/web:1.0.0\n",
          stderr: "",
        })
      }
      if (cmd === "docker rm -f 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      if (cmd.startsWith("'docker' 'create'")) {
        return Promise.resolve({ exitCode: 0, stdout: "container-2\n", stderr: "" })
      }
      if (cmd === "docker start 'web'") {
        return Promise.resolve({ exitCode: 0, stdout: "web\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const result = await executeResource(
    ctx,
    dockerDefinition,
    { ...BASE_INPUT, pull: "always" },
    { postCheck: true, retries: 0, timeoutMs: 0 },
  )

  expect(result.status).toEqual("changed")
  expect(result.output).toEqual({
    name: "web",
    image: "ghcr.io/acme/web:1.0.0",
    imageId: "sha256:image-v2",
    containerId: "container-1",
    state: "running",
    changed: true,
  })
  expect(commands).toContain("docker pull 'ghcr.io/acme/web:1.0.0'")
  expect(commands).toContain("docker rm -f 'web'")
  expect(commands.some((cmd) => cmd.startsWith("'docker' 'create'"))).toEqual(true)
  expect(commands).toContain("docker start 'web'")
})
