/**
 * Resource factory — createResources(ctx).
 *
 * Returns all built-in resource functions bound to an ExecutionContext.
 * Recipes destructure these and chain with `await`. See ISSUE-0008.
 *
 * Optionally accepts a custom `ResourceRegistry` to support plugin
 * resources alongside built-ins. See ISSUE-0034.
 */

import type { ExecutionContext, ResourceCallMeta, ResourceResult } from "../core/types.ts"
import type { ExecInput, ExecOutput } from "./exec.ts"
import type { FileInput, FileOutput } from "./file.ts"
import type { AptInput, AptOutput } from "./apt.ts"
import type { ServiceInput, ServiceOutput } from "./service.ts"
import type { DirectoryInput, DirectoryOutput } from "./directory.ts"
import { createExec } from "./exec.ts"
import { createFile } from "./file.ts"
import { createApt } from "./apt.ts"
import { createService } from "./service.ts"
import { createDirectory } from "./directory.ts"
import { defaultRegistry, type ResourceRegistry } from "../core/registry.ts"

/** Return type of `createResources()`. */
export interface BoundResources {
  exec: (input: ExecInput, meta?: ResourceCallMeta) => Promise<ResourceResult<ExecOutput>>
  file: (input: FileInput, meta?: ResourceCallMeta) => Promise<ResourceResult<FileOutput>>
  apt: (input: AptInput, meta?: ResourceCallMeta) => Promise<ResourceResult<AptOutput>>
  service: (input: ServiceInput, meta?: ResourceCallMeta) => Promise<ResourceResult<ServiceOutput>>
  directory: (
    input: DirectoryInput,
    meta?: ResourceCallMeta,
  ) => Promise<ResourceResult<DirectoryOutput>>
}

/**
 * Create all built-in resource functions bound to a given execution context.
 *
 * When a custom `registry` is provided, additional resources from that
 * registry are merged into the returned object alongside the built-in
 * typed resources. Built-in resources always use their strongly-typed
 * factory functions regardless of the registry. See ISSUE-0034.
 *
 * Usage in recipes:
 * ```ts
 * export default async function(ctx: ExecutionContext) {
 *   const { exec, file, apt, service, directory } = createResources(ctx)
 *   await apt({ name: 'nginx', state: 'present' })
 *   await file({ path: '/etc/nginx/nginx.conf', content: '...' })
 *   await service({ name: 'nginx', state: 'started', enabled: true })
 * }
 * ```
 */
export function createResources(
  ctx: ExecutionContext,
  registry?: ResourceRegistry,
): BoundResources {
  const builtins: BoundResources = {
    exec: createExec(ctx),
    file: createFile(ctx),
    apt: createApt(ctx),
    service: createService(ctx),
    directory: createDirectory(ctx),
  }

  // Delegate base resource discovery/binding to the default registry so
  // createResources() automatically tracks registered built-ins.
  const base = defaultRegistry.createBoundResources(ctx)
  if (!registry) return Object.assign(base, builtins) as BoundResources

  // Merge default + custom registry resources, with built-in typed functions
  // taking precedence to preserve backward-compatible call signatures.
  const extra = registry.createBoundResources(ctx)
  return Object.assign(base, extra, builtins) as BoundResources
}

// Re-export all resource definitions, inputs, and outputs
export { createExec, execDefinition, execSchema } from "./exec.ts"
export type { ExecInput, ExecOutput } from "./exec.ts"

export { createFile, fileDefinition, fileSchema } from "./file.ts"
export type { FileInput, FileOutput } from "./file.ts"

export { aptDefinition, aptSchema, createApt } from "./apt.ts"
export type { AptInput, AptOutput } from "./apt.ts"

export { createService, serviceDefinition, serviceSchema } from "./service.ts"
export type { ServiceInput, ServiceOutput } from "./service.ts"

export { createDirectory, directoryDefinition, directorySchema } from "./directory.ts"
export type { DirectoryInput, DirectoryOutput } from "./directory.ts"
