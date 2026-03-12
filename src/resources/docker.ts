/**
 * docker() resource — manage Docker containers on target hosts.
 *
 * `check()` inspects the local image cache and container configuration.
 * `apply()` pulls images, creates/recreates containers, and starts/stops them.
 */

import type {
  CheckResult,
  ExecutionContext,
  ResourceCallMeta,
  ResourceDefinition,
  ResourceSchema,
} from "../core/types.ts"
import { ResourceError } from "../core/errors.ts"
import { executeResource, requireCapability, skipApply } from "../core/resource.ts"
import type { ExecResult } from "../ssh/types.ts"

/** Published host port mapping for a managed container. */
export type DockerPortInput = {
  hostPort: number
  containerPort: number
  protocol?: "tcp" | "udp" | undefined
  hostIp?: string | undefined
}

/** Bind mount configuration for a managed container. */
export type DockerMountInput = {
  source: string
  target: string
  readOnly?: boolean | undefined
}

/** Input options for the docker resource. */
export type DockerInput = {
  /** Container name. */
  name: string
  /** Image reference to create or refresh from. */
  image?: string | undefined
  /** Desired lifecycle state. Default: "started". */
  state?: "started" | "present" | "stopped" | "absent" | undefined
  /** Image pull strategy. Default: "if-missing". */
  pull?: "if-missing" | "always" | "never" | undefined
  /** Environment variables. */
  env?: Record<string, string> | undefined
  /** Published ports. */
  ports?: DockerPortInput[] | undefined
  /** Bind mounts. */
  mounts?: DockerMountInput[] | undefined
  /** Restart policy. */
  restart?: "no" | "on-failure" | "unless-stopped" | "always" | undefined
  /** Command argv override. */
  command?: string[] | undefined
  /** Entrypoint argv override. */
  entrypoint?: string[] | undefined
  /** Labels to set on the container. */
  labels?: Record<string, string> | undefined
  /** User override. */
  user?: string | undefined
  /** Working directory override. */
  workdir?: string | undefined
}

/** Output of a successful docker resource. */
export type DockerOutput = {
  name: string
  image: string
  imageId: string
  containerId: string
  state: "running" | "stopped" | "absent"
  changed: boolean
}

type DockerState = NonNullable<DockerInput["state"]>
type DockerPullPolicy = NonNullable<DockerInput["pull"]>

const DOCKER_CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

type DockerImageInspect = {
  Id?: string | undefined
  Config?: {
    Env?: string[] | null | undefined
    Cmd?: string[] | null | undefined
    Entrypoint?: string[] | null | undefined
    Labels?: Record<string, string> | null | undefined
    User?: string | undefined
    WorkingDir?: string | undefined
  } | null
}

type DockerContainerInspect = {
  Id?: string | undefined
  Image?: string | undefined
  Config?: {
    Image?: string | undefined
    Env?: string[] | null | undefined
    Cmd?: string[] | null | undefined
    Entrypoint?: string[] | null | undefined
    Labels?: Record<string, string> | null | undefined
    User?: string | undefined
    WorkingDir?: string | undefined
  } | null
  HostConfig?: {
    PortBindings?:
      | Record<string, Array<{ HostIp?: string | undefined; HostPort?: string | undefined }> | null>
      | null
      | undefined
    RestartPolicy?: { Name?: string | undefined } | null | undefined
  } | null
  Mounts?:
    | Array<{
        Type?: string | undefined
        Source?: string | undefined
        Destination?: string | undefined
        RW?: boolean | undefined
      }>
    | null
    | undefined
  State?: {
    Running?: boolean | undefined
  } | null
}

type NormalizedPort = {
  hostIp: string
  hostPort: number
  containerPort: number
  protocol: "tcp" | "udp"
}

type NormalizedMount = {
  source: string
  target: string
  readOnly: boolean
}

type NormalizedDockerSpec = {
  image: string
  imageId: string
  env: Record<string, string>
  ports: NormalizedPort[]
  mounts: NormalizedMount[]
  restart: string
  command: string[]
  entrypoint: string[]
  labels: Record<string, string>
  user: string
  workdir: string
}

type DockerImageSnapshot = {
  ref: string
  present: boolean
  id: string
}

type ResolvedCommandSpec = {
  desiredEntrypoint: string[]
  desiredCommand: string[]
  createEntrypoint?: string | undefined
  createCommand: string[]
}

const DOCKER_STATES = ["started", "present", "stopped", "absent"] as const
const DOCKER_PULL_POLICIES = ["if-missing", "always", "never"] as const
const DOCKER_RESTART_POLICIES = ["no", "on-failure", "unless-stopped", "always"] as const
const DOCKER_PORT_PROTOCOLS = ["tcp", "udp"] as const

/** Quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Join shell args into a single safely quoted command string. */
function joinShellArgs(args: string[]): string {
  return args.map(shellQuote).join(" ")
}

/** Normalize a string array from Docker inspect. */
function normalizeStringList(values?: string[] | null): string[] {
  return Array.isArray(values) ? [...values] : []
}

/** Normalize an optional command override, ignoring empty arrays. */
function normalizeCommandOverride(values?: string[]): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined
  return [...values]
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

/** Return a copy of a record with stable key ordering. */
function sortRecord(record?: Record<string, string> | null): Record<string, string> {
  const sorted: Record<string, string> = {}
  for (const [key, value] of Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    sorted[key] = value
  }
  return sorted
}

/** Parse an env array like ["KEY=value"] into a record. */
function envArrayToRecord(values?: string[] | null): Record<string, string> {
  const record: Record<string, string> = {}
  for (const value of values ?? []) {
    const eqIndex = value.indexOf("=")
    if (eqIndex === -1) {
      record[value] = ""
      continue
    }
    record[value.slice(0, eqIndex)] = value.slice(eqIndex + 1)
  }
  return sortRecord(record)
}

/** Normalize and sort port mappings from resource input. */
function normalizePortsFromInput(ports?: DockerPortInput[]): NormalizedPort[] {
  const normalized = (ports ?? []).map((port) => ({
    hostIp: port.hostIp ?? "",
    hostPort: port.hostPort,
    containerPort: port.containerPort,
    protocol: port.protocol ?? "tcp",
  }))
  normalized.sort(comparePorts)
  return normalized
}

/** Normalize and sort published port mappings from docker inspect. */
function normalizePortsFromInspect(
  bindings?: Record<
    string,
    Array<{ HostIp?: string | undefined; HostPort?: string | undefined }> | null
  > | null,
): NormalizedPort[] {
  const normalized: NormalizedPort[] = []

  for (const [containerKey, hostBindings] of Object.entries(bindings ?? {})) {
    const [containerPortRaw, protocolRaw] = containerKey.split("/")
    const containerPort = Number.parseInt(containerPortRaw ?? "", 10)
    if (!Number.isFinite(containerPort)) continue
    const protocol = protocolRaw === "udp" ? "udp" : "tcp"

    for (const binding of hostBindings ?? []) {
      const hostPort = Number.parseInt(binding?.HostPort ?? "", 10)
      if (!Number.isFinite(hostPort)) continue
      normalized.push({
        hostIp: binding?.HostIp ?? "",
        hostPort,
        containerPort,
        protocol,
      })
    }
  }

  normalized.sort(comparePorts)
  return normalized
}

function comparePorts(a: NormalizedPort, b: NormalizedPort): number {
  return (
    a.hostIp.localeCompare(b.hostIp) ||
    a.hostPort - b.hostPort ||
    a.containerPort - b.containerPort ||
    a.protocol.localeCompare(b.protocol)
  )
}

/** Normalize and sort bind mounts from resource input. */
function normalizeMountsFromInput(mounts?: DockerMountInput[]): NormalizedMount[] {
  const normalized = (mounts ?? []).map((mount) => ({
    source: mount.source,
    target: mount.target,
    readOnly: mount.readOnly ?? false,
  }))
  normalized.sort(compareMounts)
  return normalized
}

/** Normalize and sort bind mounts from docker inspect. */
function normalizeMountsFromInspect(mounts?: DockerContainerInspect["Mounts"]): NormalizedMount[] {
  const normalized = (mounts ?? [])
    .filter((mount) => mount.Type === "bind")
    .map((mount) => ({
      source: mount.Source ?? "",
      target: mount.Destination ?? "",
      readOnly: mount.RW === false,
    }))
  normalized.sort(compareMounts)
  return normalized
}

function compareMounts(a: NormalizedMount, b: NormalizedMount): number {
  return a.target.localeCompare(b.target) || a.source.localeCompare(b.source)
}

/** Return the desired docker state with defaults applied. */
function normalizeState(input: DockerInput): DockerState {
  const state = input.state ?? "started"
  if (isOneOf(state, DOCKER_STATES)) return state
  throw new ResourceError(
    "docker",
    typeof input.name === "string" ? input.name : "<unknown>",
    `docker resource received invalid state '${String(state)}'`,
  )
}

/** Return the desired pull policy with defaults applied. */
function normalizePullPolicy(input: DockerInput): DockerPullPolicy {
  const pull = input.pull ?? "if-missing"
  if (isOneOf(pull, DOCKER_PULL_POLICIES)) return pull
  throw new ResourceError(
    "docker",
    typeof input.name === "string" ? input.name : "<unknown>",
    `docker resource received invalid pull policy '${String(pull)}'`,
  )
}

/** Validate required fields once defaults are known. */
function validateDockerInput(input: DockerInput): { state: DockerState; pull: DockerPullPolicy } {
  const state = normalizeState(input)
  const pull = normalizePullPolicy(input)

  if (typeof input.name !== "string" || !DOCKER_CONTAINER_NAME_RE.test(input.name)) {
    throw new ResourceError(
      "docker",
      typeof input.name === "string" ? input.name : "<unknown>",
      "docker resource requires a valid container name matching [a-zA-Z0-9][a-zA-Z0-9_.-]*",
    )
  }

  if (state !== "absent" && (typeof input.image !== "string" || input.image.length === 0)) {
    throw new ResourceError(
      "docker",
      input.name,
      "docker resource requires image unless state is 'absent'",
    )
  }

  if (input.restart !== undefined && !isOneOf(input.restart, DOCKER_RESTART_POLICIES)) {
    throw new ResourceError(
      "docker",
      input.name,
      `docker resource received invalid restart policy '${String(input.restart)}'`,
    )
  }

  if (input.user !== undefined && input.user.length === 0) {
    throw new ResourceError(
      "docker",
      input.name,
      "docker resource does not accept an empty user override",
    )
  }

  if (input.workdir !== undefined && input.workdir.length === 0) {
    throw new ResourceError(
      "docker",
      input.name,
      "docker resource does not accept an empty workdir override",
    )
  }

  if (input.command !== undefined) {
    if (!Array.isArray(input.command)) {
      throw new ResourceError(
        "docker",
        input.name,
        "docker resource command must be an array of strings",
      )
    }
    for (const [index, arg] of input.command.entries()) {
      if (typeof arg !== "string") {
        throw new ResourceError(
          "docker",
          input.name,
          `docker resource command[${index}] must be a string`,
        )
      }
    }
  }

  if (input.entrypoint !== undefined) {
    if (!Array.isArray(input.entrypoint)) {
      throw new ResourceError(
        "docker",
        input.name,
        "docker resource entrypoint must be an array of strings",
      )
    }
    for (const [index, arg] of input.entrypoint.entries()) {
      if (typeof arg !== "string") {
        throw new ResourceError(
          "docker",
          input.name,
          `docker resource entrypoint[${index}] must be a string`,
        )
      }
    }
  }

  const hostBindings = new Set<string>()
  for (const [index, port] of (input.ports ?? []).entries()) {
    if (!Number.isInteger(port.hostPort) || port.hostPort < 1 || port.hostPort > 65535) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource port[${index}].hostPort must be an integer between 1 and 65535`,
      )
    }

    if (
      !Number.isInteger(port.containerPort) ||
      port.containerPort < 1 ||
      port.containerPort > 65535
    ) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource port[${index}].containerPort must be an integer between 1 and 65535`,
      )
    }

    const protocol = port.protocol ?? "tcp"
    if (!isOneOf(protocol, DOCKER_PORT_PROTOCOLS)) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource port[${index}] received invalid protocol '${String(protocol)}'`,
      )
    }

    if (port.hostIp !== undefined && typeof port.hostIp !== "string") {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource port[${index}].hostIp must be a string`,
      )
    }

    const hostBindingKey = `${port.hostIp ?? ""}:${port.hostPort}/${protocol}`
    if (hostBindings.has(hostBindingKey)) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource declares duplicate published host binding '${hostBindingKey}'`,
      )
    }
    hostBindings.add(hostBindingKey)
  }

  for (const [index, mount] of (input.mounts ?? []).entries()) {
    if (typeof mount.source !== "string" || mount.source.trim().length === 0) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource mount[${index}].source must be a non-empty string`,
      )
    }

    if (typeof mount.target !== "string" || mount.target.trim().length === 0) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource mount[${index}].target must be a non-empty string`,
      )
    }

    if (mount.source.includes(",") || mount.target.includes(",")) {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource mount[${index}] paths cannot contain commas when using --mount bind syntax`,
      )
    }
  }

  return { state, pull }
}

/** Parse docker inspect JSON output and return the first object. */
function parseInspectObject<T>(stdout: string, resourceName: string, subject: string): T {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object") {
      throw new Error("inspect output was not a non-empty JSON array")
    }
    return parsed[0] as T
  } catch (error) {
    throw new ResourceError(
      "docker",
      resourceName,
      `failed to parse docker inspect output for ${subject}`,
      error instanceof Error ? error : undefined,
    )
  }
}

/** Throw a ResourceError when a docker CLI command returns non-zero. */
async function execDocker(
  ctx: ExecutionContext,
  resourceName: string,
  command: string,
  failureMessage: string,
): Promise<ExecResult> {
  const result = await ctx.connection.exec(command)
  if (result.exitCode === 0) return result

  const detail = result.stderr.trim() || result.stdout.trim() || `command exited ${result.exitCode}`
  throw new ResourceError("docker", resourceName, `${failureMessage}: ${detail}`)
}

/** Best-effort change detection for docker pull output. */
function pullChanged(result: ExecResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
  if (output.includes("image is up to date") || output.includes("status: image is up to date")) {
    return false
  }
  if (
    output.includes("downloaded newer image") ||
    output.includes("pull complete") ||
    output.includes("status: downloaded newer image")
  ) {
    return true
  }
  return false
}

/** Ensure docker is installed and reachable for the current remote user. */
async function assertDockerAvailable(ctx: ExecutionContext, resourceName: string): Promise<void> {
  const cliResult = await ctx.connection.exec("command -v docker >/dev/null 2>&1")
  if (cliResult.exitCode !== 0) {
    throw new ResourceError(
      "docker",
      resourceName,
      "docker resource requires Docker CLI on the remote host",
    )
  }

  const daemonResult = await ctx.connection.exec("docker info >/dev/null 2>&1")
  if (daemonResult.exitCode !== 0) {
    throw new ResourceError(
      "docker",
      resourceName,
      "docker resource requires a reachable Docker daemon for the current remote user",
    )
  }
}

/** Inspect a local image reference, returning absent on normal not-found errors. */
async function inspectImage(
  ctx: ExecutionContext,
  resourceName: string,
  image: string,
): Promise<{ present: boolean; inspect?: DockerImageInspect | undefined }> {
  const result = await ctx.connection.exec(`docker image inspect ${shellQuote(image)}`)
  if (result.exitCode !== 0) {
    const message = `${result.stderr} ${result.stdout}`.toLowerCase()
    if (message.includes("no such image") || message.includes("no such object")) {
      return { present: false }
    }
    const detail =
      result.stderr.trim() || result.stdout.trim() || `command exited ${result.exitCode}`
    throw new ResourceError("docker", resourceName, `failed to inspect image '${image}': ${detail}`)
  }

  return {
    present: true,
    inspect: parseInspectObject<DockerImageInspect>(
      result.stdout,
      resourceName,
      `image '${image}'`,
    ),
  }
}

/** Inspect a container by name, returning absent on normal not-found errors. */
async function inspectContainer(
  ctx: ExecutionContext,
  resourceName: string,
  containerName: string,
): Promise<{ present: boolean; inspect?: DockerContainerInspect | undefined }> {
  const result = await ctx.connection.exec(
    `docker inspect --type container ${shellQuote(containerName)}`,
  )
  if (result.exitCode !== 0) {
    const message = `${result.stderr} ${result.stdout}`.toLowerCase()
    if (message.includes("no such object") || message.includes("no such container")) {
      return { present: false }
    }
    const detail =
      result.stderr.trim() || result.stdout.trim() || `command exited ${result.exitCode}`
    throw new ResourceError(
      "docker",
      resourceName,
      `failed to inspect container '${containerName}': ${detail}`,
    )
  }

  return {
    present: true,
    inspect: parseInspectObject<DockerContainerInspect>(
      result.stdout,
      resourceName,
      `container '${containerName}'`,
    ),
  }
}

/** Return the current lifecycle state from docker inspect. */
function containerState(inspect: DockerContainerInspect): DockerOutput["state"] {
  return inspect.State?.Running ? "running" : "stopped"
}

/** Resolve the effective entrypoint/cmd inspect state and docker create argv. */
function resolveCommandSpec(
  input: DockerInput,
  imageInspect: DockerImageInspect,
): ResolvedCommandSpec {
  const imageConfig = imageInspect.Config ?? undefined
  const imageCommand = normalizeStringList(imageConfig?.Cmd)
  const imageEntrypoint = normalizeStringList(imageConfig?.Entrypoint)
  const commandOverride = normalizeCommandOverride(input.command)

  let desiredEntrypoint = imageEntrypoint
  let desiredCommand = commandOverride ?? imageCommand
  let createEntrypoint: string | undefined
  const createCommand: string[] = []

  // Docker CLI only accepts one token for --entrypoint. When callers pass
  // multiple argv segments, preserve the final argv by shifting the tail
  // into the command list that follows the image reference.
  if (input.entrypoint !== undefined) {
    if (input.entrypoint.length === 0) {
      desiredEntrypoint = []
      createEntrypoint = ""
    } else if (input.entrypoint.length === 1) {
      desiredEntrypoint = [input.entrypoint[0]]
      createEntrypoint = input.entrypoint[0]
    } else {
      desiredEntrypoint = [input.entrypoint[0]]
      desiredCommand = [...input.entrypoint.slice(1), ...(commandOverride ?? imageCommand)]
      createEntrypoint = input.entrypoint[0]
      createCommand.push(...input.entrypoint.slice(1))
    }
  }

  if (commandOverride) {
    createCommand.push(...commandOverride)
  } else if (input.entrypoint !== undefined && input.entrypoint.length > 1) {
    createCommand.push(...imageCommand)
  }

  return {
    desiredEntrypoint,
    desiredCommand,
    createEntrypoint,
    createCommand,
  }
}

/** Build the effective spec the created container should expose via docker inspect. */
function buildDesiredSpec(
  input: DockerInput,
  imageInspect: DockerImageInspect,
): NormalizedDockerSpec {
  const imageConfig = imageInspect.Config ?? undefined
  const resolvedCommand = resolveCommandSpec(input, imageInspect)

  return {
    image: input.image!,
    imageId: imageInspect.Id ?? "",
    env: sortRecord({
      ...envArrayToRecord(imageConfig?.Env),
      ...input.env,
    }),
    ports: normalizePortsFromInput(input.ports),
    mounts: normalizeMountsFromInput(input.mounts),
    restart: input.restart ?? "no",
    command: resolvedCommand.desiredCommand,
    entrypoint: resolvedCommand.desiredEntrypoint,
    labels: sortRecord({
      ...sortRecord(imageConfig?.Labels),
      ...input.labels,
    }),
    user: input.user ?? imageConfig?.User ?? "",
    workdir: input.workdir ?? imageConfig?.WorkingDir ?? "",
  }
}

/** Build the normalized current spec from docker inspect. */
function buildCurrentSpec(inspect: DockerContainerInspect): NormalizedDockerSpec {
  return {
    image: inspect.Config?.Image ?? "",
    imageId: inspect.Image ?? "",
    env: envArrayToRecord(inspect.Config?.Env),
    ports: normalizePortsFromInspect(inspect.HostConfig?.PortBindings),
    mounts: normalizeMountsFromInspect(inspect.Mounts),
    restart: inspect.HostConfig?.RestartPolicy?.Name ?? "no",
    command: normalizeStringList(inspect.Config?.Cmd),
    entrypoint: normalizeStringList(inspect.Config?.Entrypoint),
    labels: sortRecord(inspect.Config?.Labels),
    user: inspect.Config?.User ?? "",
    workdir: inspect.Config?.WorkingDir ?? "",
  }
}

const diffKeys: readonly (keyof NormalizedDockerSpec)[] = [
  "image",
  "imageId",
  "env",
  "ports",
  "mounts",
  "restart",
  "command",
  "entrypoint",
  "labels",
  "user",
  "workdir",
]

/** Produce a desired spec subset for fields that differ. */
function diffDesiredSpec(
  current: NormalizedDockerSpec,
  desired: NormalizedDockerSpec,
): Record<string, unknown> {
  const desiredDiff: Record<string, unknown> = {}
  for (const key of diffKeys) {
    const c = current[key]
    const d = desired[key]
    if (typeof c === "string" ? c !== d : JSON.stringify(c) !== JSON.stringify(d)) {
      desiredDiff[key] = d
    }
  }
  return desiredDiff
}

/** Build the observed image snapshot for the inspected image reference. */
function buildObservedImageSnapshot(
  imageRef: string,
  image: { present: boolean; inspect?: DockerImageInspect | undefined },
): DockerImageSnapshot {
  return {
    ref: imageRef,
    present: image.present,
    id: image.inspect?.Id ?? "",
  }
}

/** Build a stable snapshot of the observed current state for diffs. */
function buildCurrentSnapshot(
  image: DockerImageSnapshot | undefined,
  containerInspect?: DockerContainerInspect,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    container: containerInspect
      ? {
          id: containerInspect.Id ?? "",
          state: containerState(containerInspect),
          spec: buildCurrentSpec(containerInspect),
        }
      : null,
  }

  if (image) {
    snapshot.image = image
  }

  return snapshot
}

/** Build the desired-state snapshot for diff output. */
function buildDesiredSnapshot(
  state: DockerState,
  pull: DockerPullPolicy,
  input: DockerInput,
  desiredSpec?: NormalizedDockerSpec,
  desiredDiff?: Record<string, unknown>,
): Record<string, unknown> {
  if (state === "absent") return { state: "absent" }

  return {
    state,
    pull,
    image: {
      ref: input.image ?? "",
      id: desiredSpec?.imageId ?? "",
    },
    spec: desiredDiff && Object.keys(desiredDiff).length > 0 ? desiredDiff : (desiredSpec ?? {}),
  }
}

/** Return true when the container lifecycle already satisfies the requested state. */
function lifecycleMatches(state: DockerState, currentState: DockerOutput["state"]): boolean {
  if (state === "present") return currentState === "running" || currentState === "stopped"
  if (state === "started") return currentState === "running"
  if (state === "stopped") return currentState === "stopped"
  return currentState === "absent"
}

/** Build docker create arguments for a new container. */
function buildCreateArgs(input: DockerInput, imageInspect: DockerImageInspect): string[] {
  const args = ["docker", "create", "--name", input.name]
  const resolvedCommand = resolveCommandSpec(input, imageInspect)

  if (input.restart !== undefined) {
    args.push("--restart", input.restart)
  }

  for (const [key, value] of Object.entries(sortRecord(input.env))) {
    args.push("-e", `${key}=${value}`)
  }

  for (const port of normalizePortsFromInput(input.ports)) {
    const binding = `${port.hostIp ? `${port.hostIp}:` : ""}${port.hostPort}:${port.containerPort}/${port.protocol}`
    args.push("-p", binding)
  }

  for (const mount of normalizeMountsFromInput(input.mounts)) {
    let spec = `type=bind,src=${mount.source},dst=${mount.target}`
    if (mount.readOnly) spec += ",readonly"
    args.push("--mount", spec)
  }

  for (const [key, value] of Object.entries(sortRecord(input.labels))) {
    args.push("--label", `${key}=${value}`)
  }

  if (input.user !== undefined) {
    args.push("--user", input.user)
  }

  if (input.workdir !== undefined) {
    args.push("--workdir", input.workdir)
  }

  if (resolvedCommand.createEntrypoint !== undefined) {
    args.push("--entrypoint", resolvedCommand.createEntrypoint)
  }

  args.push(input.image!)

  if (resolvedCommand.createCommand.length > 0) {
    args.push(...resolvedCommand.createCommand)
  }

  return args
}

/** Inspect the named container and fail if it is unexpectedly absent. */
async function inspectExistingContainer(
  ctx: ExecutionContext,
  resourceName: string,
): Promise<DockerContainerInspect> {
  const container = await inspectContainer(ctx, resourceName, resourceName)
  if (!container.present || !container.inspect) {
    throw new ResourceError("docker", resourceName, "container was not present after apply")
  }
  return container.inspect
}

/** Return the current resource output from a container inspect object. */
function outputFromContainer(
  input: DockerInput,
  inspect: DockerContainerInspect,
  changed: boolean,
): DockerOutput {
  return {
    name: input.name,
    image: inspect.Config?.Image ?? input.image ?? "",
    imageId: inspect.Image ?? "",
    containerId: inspect.Id ?? "",
    state: containerState(inspect),
    changed,
  }
}

/** Schema for the docker resource. */
export const dockerSchema: ResourceSchema = {
  description: "Manage Docker containers on hosts that already have Docker installed.",
  whenToUse: [
    "Running a container from a known Docker image",
    "Ensuring a container is started, stopped, present, or absent",
    "Recreating a container when image reference, image ID, or runtime configuration drifts",
    "Publishing ports, bind mounts, env vars, and restart policy for a container",
  ],
  doNotUseFor: [
    "Installing Docker Engine (use apt and service in the recipe)",
    "Managing Docker Compose applications",
    "Building images, networks, or named volumes",
    "Running arbitrary one-off container commands",
  ],
  triggerPatterns: [
    "run docker container",
    "start container",
    "ensure container is running",
    "publish docker port",
    "pull image and recreate container",
    "remove container",
  ],
  hints: [
    'state defaults to "started" — omit it when the container should exist and be running',
    'pull defaults to "if-missing" — use "always" only when you want apply mode to refresh tags every run',
    'Not idempotent overall because pull: "always" intentionally refreshes tags on every apply',
    'state: "absent" removes the container only; it does not remove images or mounted data',
    "Container config drift recreates the container instead of mutating it in place",
    "The declared image reference is part of the managed container spec, even when it resolves to the same image ID",
    "The remote user must be able to run docker commands against the daemon",
    "Uses docker create plus explicit start/stop so stopped and present states remain representable",
    "Container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]* for predictable docker create behavior",
    "Docker CLI only accepts one --entrypoint token — when entrypoint has multiple elements, the first becomes --entrypoint and the remaining elements are prepended to the command argv",
  ],
  input: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Container name" },
      image: { type: "string", description: "Image reference (required unless state is absent)" },
      state: {
        type: "string",
        enum: ["started", "present", "stopped", "absent"],
        default: "started",
        description: "Desired container lifecycle state",
      },
      pull: {
        type: "string",
        enum: ["if-missing", "always", "never"],
        default: "if-missing",
        description: "Image pull strategy",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Environment variables",
      },
      ports: {
        type: "array",
        description: "Published port mappings",
        items: {
          type: "object",
          required: ["hostPort", "containerPort"],
          properties: {
            hostPort: { type: "number" },
            containerPort: { type: "number" },
            protocol: { type: "string", enum: ["tcp", "udp"], default: "tcp" },
            hostIp: { type: "string" },
          },
        },
      },
      mounts: {
        type: "array",
        description: "Bind mounts",
        items: {
          type: "object",
          required: ["source", "target"],
          properties: {
            source: { type: "string" },
            target: { type: "string" },
            readOnly: { type: "boolean", default: false },
          },
        },
      },
      restart: {
        type: "string",
        enum: ["no", "on-failure", "unless-stopped", "always"],
        description: "Restart policy",
      },
      command: {
        type: "array",
        items: { type: "string" },
        description: "Command argv override",
      },
      entrypoint: {
        type: "array",
        items: { type: "string" },
        description:
          "Entrypoint argv override. When more than one element is provided, the first becomes --entrypoint and the rest are prepended to the command argv",
      },
      labels: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Container labels",
      },
      user: { type: "string", description: "User override" },
      workdir: { type: "string", description: "Working directory override" },
    },
  },
  output: {
    type: "object",
    properties: {
      name: { type: "string", description: "Container name" },
      image: { type: "string", description: "Image reference used by the container" },
      imageId: { type: "string", description: "Resolved image ID" },
      containerId: { type: "string", description: "Container ID" },
      state: {
        type: "string",
        enum: ["running", "stopped", "absent"],
        description: "Observed container state after execution",
      },
      changed: { type: "boolean", description: "Whether apply mode made or would make changes" },
    },
  },
  examples: [
    {
      title: "Run nginx container",
      description: "Ensure nginx is present and running on port 8080",
      input: {
        name: "nginx",
        image: "nginx:1.27",
        ports: [{ hostPort: 8080, containerPort: 80 }],
      },
      naturalLanguage: "Run nginx in Docker and publish port 8080 to port 80",
    },
    {
      title: "Create but keep stopped",
      description: "Ensure a container exists without starting it",
      input: {
        name: "job-runner",
        image: "ghcr.io/example/job-runner:1.2.3",
        state: "stopped",
      },
    },
    {
      title: "Remove a container",
      description: "Delete an existing container without touching the image",
      input: {
        name: "old-app",
        state: "absent",
      },
      naturalLanguage: "Remove the old-app container",
    },
  ],
  nature: "imperative",
  annotations: {
    readOnly: false,
    destructive: true,
    idempotent: false,
  },
  requiredCapabilities: ["exec"],
}

/** ResourceDefinition for docker. */
export const dockerDefinition: ResourceDefinition<DockerInput, DockerOutput> = {
  type: "docker",
  schema: dockerSchema,

  formatName(input: DockerInput): string {
    return input.name
  },

  async check(ctx: ExecutionContext, input: DockerInput): Promise<CheckResult<DockerOutput>> {
    requireCapability(ctx, "exec", "docker")
    const { state, pull } = validateDockerInput(input)
    await assertDockerAvailable(ctx, input.name)

    const container = await inspectContainer(ctx, input.name, input.name)

    if (state === "absent") {
      if (!container.present || !container.inspect) {
        return {
          inDesiredState: true,
          current: { container: null },
          desired: { state: "absent" },
          output: {
            name: input.name,
            image: input.image ?? "",
            imageId: "",
            containerId: "",
            state: "absent",
            changed: false,
          },
        }
      }

      return {
        inDesiredState: false,
        current: buildCurrentSnapshot(undefined, container.inspect),
        desired: { state: "absent" },
      }
    }

    const image = await inspectImage(ctx, input.name, input.image!)

    if (!image.present && pull === "never") {
      throw new ResourceError(
        "docker",
        input.name,
        `docker resource requires local image '${input.image}' when pull is 'never'`,
      )
    }

    const current = buildCurrentSnapshot(
      buildObservedImageSnapshot(input.image!, image),
      container.inspect,
    )

    if (pull === "always" && ctx.phase !== "post-check") {
      const desiredSpec = image.inspect ? buildDesiredSpec(input, image.inspect) : undefined
      return {
        inDesiredState: false,
        current,
        desired: buildDesiredSnapshot(state, pull, input, desiredSpec),
      }
    }

    if (!image.present || !image.inspect) {
      return {
        inDesiredState: false,
        current,
        desired: buildDesiredSnapshot(state, pull, input),
      }
    }

    const desiredSpec = buildDesiredSpec(input, image.inspect)

    if (!container.present || !container.inspect) {
      return {
        inDesiredState: false,
        current,
        desired: buildDesiredSnapshot(state, pull, input, desiredSpec),
      }
    }

    const currentSpec = buildCurrentSpec(container.inspect)
    const desiredDiff = diffDesiredSpec(currentSpec, desiredSpec)
    const currentState = containerState(container.inspect)
    const lifecycleInDesiredState = lifecycleMatches(state, currentState)

    if (Object.keys(desiredDiff).length === 0 && lifecycleInDesiredState) {
      return {
        inDesiredState: true,
        current,
        desired: buildDesiredSnapshot(state, pull, input, desiredSpec),
        output: outputFromContainer(input, container.inspect, false),
      }
    }

    const desired = buildDesiredSnapshot(
      state,
      pull,
      input,
      desiredSpec,
      lifecycleInDesiredState ? desiredDiff : { state, ...desiredDiff },
    )

    return {
      inDesiredState: false,
      current,
      desired,
    }
  },

  async apply(ctx: ExecutionContext, input: DockerInput): Promise<DockerOutput> {
    requireCapability(ctx, "exec", "docker")
    const { state, pull } = validateDockerInput(input)
    await assertDockerAvailable(ctx, input.name)

    const existing = await inspectContainer(ctx, input.name, input.name)
    let changed = false

    if (state === "absent") {
      if (existing.present) {
        await execDocker(
          ctx,
          input.name,
          `docker rm -f ${shellQuote(input.name)}`,
          `failed to remove container '${input.name}'`,
        )
        changed = true
      }
      return {
        name: input.name,
        image: input.image ?? "",
        imageId: "",
        containerId: "",
        state: "absent",
        changed,
      }
    }

    if (pull === "always") {
      const pullResult = await execDocker(
        ctx,
        input.name,
        `docker pull ${shellQuote(input.image!)}`,
        `failed to pull image '${input.image}'`,
      )
      changed = pullChanged(pullResult)
    } else {
      const currentImage = await inspectImage(ctx, input.name, input.image!)
      if (!currentImage.present) {
        if (pull === "never") {
          throw new ResourceError(
            "docker",
            input.name,
            `docker resource requires local image '${input.image}' when pull is 'never'`,
          )
        }
        await execDocker(
          ctx,
          input.name,
          `docker pull ${shellQuote(input.image!)}`,
          `failed to pull image '${input.image}'`,
        )
        changed = true
      }
    }

    const image = await inspectImage(ctx, input.name, input.image!)
    if (!image.present || !image.inspect) {
      throw new ResourceError(
        "docker",
        input.name,
        `image '${input.image}' was not present after pull`,
      )
    }

    const desiredSpec = buildDesiredSpec(input, image.inspect)
    const currentContainer = existing
    const currentSpec = currentContainer.inspect
      ? buildCurrentSpec(currentContainer.inspect)
      : undefined
    const currentState = currentContainer.inspect
      ? containerState(currentContainer.inspect)
      : "absent"
    const lifecycleInDesiredState = lifecycleMatches(state, currentState)
    const recreate =
      !currentContainer.present ||
      !currentSpec ||
      Object.keys(diffDesiredSpec(currentSpec, desiredSpec)).length > 0

    if (
      ctx.phase === "apply" &&
      pull === "always" &&
      !changed &&
      !recreate &&
      lifecycleInDesiredState &&
      currentContainer.inspect
    ) {
      skipApply(outputFromContainer(input, currentContainer.inspect, false))
    }

    if (currentContainer.present && recreate) {
      await execDocker(
        ctx,
        input.name,
        `docker rm -f ${shellQuote(input.name)}`,
        `failed to remove container '${input.name}' before recreation`,
      )
      changed = true
    }

    if (recreate) {
      await execDocker(
        ctx,
        input.name,
        joinShellArgs(buildCreateArgs(input, image.inspect)),
        `failed to create container '${input.name}'`,
      )
      changed = true
    }

    if (state === "started") {
      if (recreate || currentState !== "running") {
        await execDocker(
          ctx,
          input.name,
          `docker start ${shellQuote(input.name)}`,
          `failed to start container '${input.name}'`,
        )
        changed = true
      }
    } else if (state === "present") {
      if (recreate && currentState === "running") {
        await execDocker(
          ctx,
          input.name,
          `docker start ${shellQuote(input.name)}`,
          `failed to start container '${input.name}'`,
        )
        changed = true
      }
    } else if (state === "stopped") {
      if (!recreate && currentState === "running") {
        await execDocker(
          ctx,
          input.name,
          `docker stop ${shellQuote(input.name)}`,
          `failed to stop container '${input.name}'`,
        )
        changed = true
      }
    }

    const finalContainer = await inspectExistingContainer(ctx, input.name)
    return outputFromContainer(input, finalContainer, changed)
  },
}

/**
 * Create a bound `docker()` function for a given execution context.
 *
 * Usage in recipes:
 * ```ts
 * const docker = createDocker(ctx)
 * await docker({ name: 'nginx', image: 'nginx:1.27', ports: [{ hostPort: 8080, containerPort: 80 }] })
 * ```
 */
export function createDocker(
  ctx: ExecutionContext,
): (
  input: DockerInput,
  meta?: ResourceCallMeta,
) => Promise<import("../core/types.ts").ResourceResult<DockerOutput>> {
  return (input: DockerInput, meta?: ResourceCallMeta) =>
    executeResource(ctx, dockerDefinition, input, ctx.resourcePolicy, meta)
}
