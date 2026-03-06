---
name: ignition
description: >
  Generate, validate, and execute Ignition server provisioning recipes.
  Ignition is a TypeScript-native SSH provisioning tool with 5 resources:
  exec, file, apt, service, directory. Use this skill when the user wants to:
  (1) Create a new provisioning recipe for servers,
  (2) Provision or configure remote hosts (install packages, deploy files,
  manage services),
  (3) Dry-run or check a recipe against targets,
  (4) Run/apply a recipe to target hosts,
  (5) Understand Ignition's resource API, recipe format, or inventory format.
  Trigger phrases: "provision a server", "install nginx", "deploy to",
  "create a recipe", "set up a host", "configure the server",
  "write a recipe for", "run this recipe", "check this recipe".
---

# Ignition Agent Skill

Use this skill as the workflow and safety layer for Ignition.
Do not use this file as the canonical CLI reference.

For the live CLI surface:

- `ignition --llms` emits the machine-readable command manifest
- `ignition skills add` syncs generated per-command skills to the agent
- Global sync writes command skills under `~/.agents/skills/`

Prefer the generated command skills when you need exact arguments, options, or
output fields:

- `ignition-run`
- `ignition-inventory`
- `ignition-schema`
- `ignition-init`
- `ignition-dashboard`

Use this main skill for orchestration across those commands: discovery, recipe
authoring, dry-run review, confirmation, execution, and audit.

## 1. Discover

Use `ignition-schema` or the underlying schema commands to inspect the current
resource, recipe, and inventory shapes:

```bash
ignition schema resources --format json
ignition schema resource <name> --format json
ignition schema recipe --format json
ignition schema inventory --format json
```

For the current machine-readable `run` output, prefer `ignition-run` or
`ignition run --schema`.
Do not assume `ignition schema output` exactly matches the current
`ignition run --format json` payload.

Available output formats: `toon` (default human), `json`, `yaml`, `md`, `jsonl`.

## 2. Generate recipe

Recipes are TypeScript files. Follow this pattern:

```typescript
import type { ExecutionContext } from "@grovemotorco/ignition"
import { createResources } from "@grovemotorco/ignition"

export const meta = {
  description: "What this recipe does",
  tags: ["relevant", "tags"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, service } = createResources(ctx)

  await apt({ name: "nginx", state: "present" })
  await service({ name: "nginx", state: "started", enabled: true })
}
```

Rules:

- Import from `@grovemotorco/ignition`
- Destructure only the resources you need from `createResources(ctx)`
- `await` every resource call
- Access variables via `ctx.vars.keyName` (cast as needed)
- Templates are functions: `(vars: TemplateContext) => string`
- `content`, `source`, and `template` on `file` are mutually exclusive
- Use `meta.tags` when the user wants `ignition run --tags` filtering

Save recipes wherever you want (for example `recipe.ts` or `recipes/<name>.ts`)
and pass that path to `ignition run`.

## 3. Validate (check mode)

Dry-run without mutations using `--check`:

```bash
ignition run <recipe.ts> <targets> --check --format json [--inventory inventory.ts]
```

Parse the current JSON summary:

- `hasFailures === false` means no host reported failures
- Each host result has `name`, `ok`, `changed`, and `failed`
- The current JSON output is summary-only; do not claim per-resource diffs
  unless you observed them separately
- Present a clear per-host pass/fail summary to the user

If the user wants a detailed explanation of intended changes, inspect the recipe
and relevant resource schemas, or review the default human output instead of
assuming the JSON summary contains diffs.

## 4. Confirm (human-in-the-loop)

Never skip this step. Before applying, present the user with:

- Target host(s)
- Expected changed/failed summary from check mode
- Warnings for destructive or non-idempotent resources such as `exec`

Wait for explicit user confirmation.
`--confirm` is an optional extra CLI prompt, not a substitute for user approval.

## 5. Execute (apply mode)

```bash
ignition run <recipe.ts> <targets> --format json [--inventory inventory.ts]
```

Parse the same summary shape as check mode and report per-host status.

## 6. Audit

Log to the user:

- Recipe path
- Targets
- Inventory path when used
- Per-host `ok` / `changed` / `failed` counts

Capture timestamps in the calling environment when needed; do not assume the
current `run --format json` payload includes them.

## Target syntax

- Named host: `web-1`
- Group: `@web`
- Multiple: `web-1,web-2`
- Ad-hoc (no inventory): `user@host:port`

When using named hosts or groups, pass `--inventory <file>` unless inventory is
already configured in `ignition.config.ts`.

## Safety

- Always run `--check` before apply
- Never skip human confirmation
- Treat `exec` as destructive / non-idempotent unless the recipe proves otherwise
- Treat absent-state resources as destructive (`file`, `apt`, `directory`)
- Use `--error-mode fail-fast` by default unless the user explicitly wants a
  different failure policy
