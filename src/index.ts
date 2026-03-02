// Ignition — public API barrel export
export type {
  AttemptRecord,
  CacheLookup,
  CheckResult,
  CheckResultCache,
  ConcurrencyOptions,
  DistroFamily,
  ErrorMode,
  ExecOptions,
  ExecResult,
  ExecutionContext,
  HostContext,
  HostFacts,
  HostRunSummary,
  InitSystem,
  JSONSchema,
  PackageManager,
  Reporter,
  ResourceAnnotations,
  ResourceDefinition,
  ResourceDiff,
  ResourceExample,
  ResourcePolicy,
  ResourceResult,
  ResourceSchema,
  ResourceStatus,
  RunMode,
  RunOptions,
  RunSummary,
  SSHConnection,
  SSHConnectionConfig,
  TemplateContext,
  Transport,
  TransportCapability,
} from "./core/types.ts"

export { redact, stableStringify } from "./core/serialize.ts"
export type { RedactionPolicy } from "./core/serialize.ts"

export {
  ALL_TRANSPORT_CAPABILITIES,
  DEFAULT_CONCURRENCY,
  DEFAULT_RESOURCE_POLICY,
  hasCapability,
  toResourceDiff,
  UNKNOWN_HOST_FACTS,
} from "./core/types.ts"

export {
  CapabilityError,
  IgnitionError,
  InventoryError,
  isRetryable,
  RecipeLoadError,
  ResourceError,
  SSHCommandError,
  SSHConnectionError,
  TransferError,
} from "./core/errors.ts"

export type { IgnitionErrorTag } from "./core/errors.ts"
export type { HostKeyPolicy } from "./ssh/types.ts"
export { controlPath, createSystemSSHConnection, SystemSSHConnection } from "./ssh/connection.ts"
export { ExecutionContextImpl } from "./core/context.ts"
export type { ExecutionContextOptions } from "./core/context.ts"
export { executeResource, requireCapability, resolvePolicy } from "./core/resource.ts"
export {
  buildCacheKey,
  DEFAULT_CACHE_FILE,
  DEFAULT_CACHE_TTL_MS,
  FileCheckResultCache,
  MemoryCheckResultCache,
} from "./core/cache.ts"
export type { CacheEntry, CacheKeyParts, CacheOptions, FileCacheOptions } from "./core/cache.ts"
export {
  classifyDistro,
  detectInitSystem,
  detectPkgManager,
  parseOsRelease,
  probeHostFacts,
} from "./core/facts.ts"
export { runRecipe } from "./core/runner.ts"
export type { RunRecipeOptions } from "./core/runner.ts"
export { loadRecipe } from "./recipe/loader.ts"
export type { RecipeFunction, RecipeMeta, RecipeModule } from "./recipe/types.ts"
export { createExec, execDefinition, execSchema } from "./resources/exec.ts"
export type { ExecInput, ExecOutput } from "./resources/exec.ts"
export { createFile, fileDefinition, fileSchema } from "./resources/file.ts"
export type { FileInput, FileOutput } from "./resources/file.ts"
export { aptDefinition, aptSchema, createApt } from "./resources/apt.ts"
export type { AptInput, AptOutput } from "./resources/apt.ts"
export { createService, serviceDefinition, serviceSchema } from "./resources/service.ts"
export type { ServiceInput, ServiceOutput } from "./resources/service.ts"
export { createDirectory, directoryDefinition, directorySchema } from "./resources/directory.ts"
export type { DirectoryInput, DirectoryOutput } from "./resources/directory.ts"
export { createResources } from "./resources/index.ts"
export {
  defaultRegistry,
  formatAllForAgent,
  formatResourceForAgent,
  formatResourceListForAgent,
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
} from "./core/registry.ts"
export type { BoundResourceFn } from "./core/registry.ts"
export { schemaCommand } from "./cli/commands/schema.ts"
export type { SchemaArgs, SchemaFormat } from "./cli/commands/schema.ts"
export { loadInventory, resolveTargets } from "./inventory/loader.ts"
export type {
  Host,
  HostGroup,
  Inventory,
  InventoryDefaults,
  InventoryModule,
  ResolvedHost,
} from "./inventory/types.ts"
export { formatDuration, PrettyReporter, QuietReporter } from "./output/reporter.ts"
export type { PrettyReporterOptions } from "./output/reporter.ts"
export { Spinner } from "./output/spinner.ts"
export type { SpinnerOptions } from "./output/spinner.ts"
export { JsonFormatter, MinimalFormatter } from "./output/formats.ts"
export { EventBus, EventReporter, generateId, NdjsonStream } from "./output/events.ts"
export type {
  BaseEvent,
  CorrelationContext,
  CorrelationId,
  EventListener,
  EventType,
  HostFinishedEvent,
  HostStartedEvent,
  LifecycleEvent,
  ResourceFinishedEvent,
  ResourceRetryEvent,
  ResourceStartedEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "./output/events.ts"
export { parseDashboardAddress } from "./cli/parsers.ts"
export type { OutputFormat, ResolvedRunCheckOptions, RunCheckOptions } from "./cli/types.ts"
export { main, VERSION } from "./cli.ts"
export type { IgnitionConfig } from "./lib/config.ts"
export { loadConfig, mergeWithConfig, ConfigValidationError, validateConfig } from "./lib/config.ts"
export {
  success,
  error as errorColor,
  warning,
  info,
  header,
  muted,
  bold,
  statusColor,
  statusSymbol,
  STATUS_SYMBOLS,
} from "./lib/colors.ts"
export { formatError } from "./lib/errors.ts"
export { DashboardServer } from "./dashboard/server.ts"
export type {
  DashboardServerOptions,
  RunRecord,
  RunSummary as DashboardRunSummary,
} from "./dashboard/server.ts"
export { DashboardClient } from "./dashboard/client.ts"
