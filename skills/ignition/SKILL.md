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

Orchestrate the full Ignition workflow: discover resources, generate a recipe,
validate with check mode, get human confirmation, then execute.
All commands below assume the installed `ignition` CLI is on PATH.

## 1. Discover (dynamic schema)

Load the full contract in one call (machine-parseable):

```bash
ignition schema all --format json
```

This returns a complete JSON contract with top-level sections:

- `resources` (all 5 resource schemas with steering metadata)
- `recipe` (recipe file contract)
- `inventory` (inventory file contract + target syntax)
- `cli` (machine-readable CLI grammar and flags)
- `output` (run/check JSON output contract)

Use this as the canonical source for agent capability discovery. `ignition --help`
is human-oriented text and not the full machine contract.

Optional human/LLM narrative format:

```bash
ignition schema all --format agent
```

For focused discovery:

- Single resource: `ignition schema resource <name> --format agent`
- CLI-only contract: `ignition schema cli --format json`

## 2. Generate recipe

Recipes are TypeScript files. Follow this exact pattern:

```typescript
import type { ExecutionContext } from "@grovemotorco/ignition"
import { createResources } from "@grovemotorco/ignition"

export const meta = {
  description: "What this recipe does",
  tags: ["relevant", "tags"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, file, service, directory, exec } = createResources(ctx)

  // Destructure only the resources you need
  // Call resources with await in sequence
  await apt({ name: "nginx", state: "present" })
  await service({ name: "nginx", state: "started", enabled: true })
}
```

**Rules:**

- All imports from `@grovemotorco/ignition` (type import for `ExecutionContext`)
- Destructure only needed resources from `createResources(ctx)`
- Each resource call must be `await`ed
- Access variables via `ctx.vars.keyName` (cast as needed)
- Templates are functions: `(vars: TemplateContext) => string` (import with `import type { TemplateContext } from "@grovemotorco/ignition"` when explicitly typed)
- `content`, `source`, and `template` on `file` are mutually exclusive

Save recipes wherever you want (for example `recipe.ts` or `recipes/<name>.ts`)
and pass that path to `ignition check` / `ignition run`.

## 3. Validate (check mode)

Dry-run without mutations:

```bash
ignition check <recipe.ts> <target> --format json [-i inventory.ts]
```

Parse the JSON output:

- `hasFailures === false` means all resources passed
- Each resource result has `status`: `"ok"` | `"changed"` | `"failed"`
- Review `current` vs `desired` state diffs
- Present a clear pass/fail summary to the user

## 4. Confirm (human-in-the-loop)

**Never skip this step.** Before applying, present the user with:

- Resources and their expected changes
- Target host(s)
- Any warnings (destructive ops, non-idempotent resources like `exec`)

Wait for explicit user confirmation.

## 5. Execute (apply mode)

```bash
ignition run <recipe.ts> <target> --format json [-i inventory.ts]
```

Parse the JSON output — same structure as check. Report per-resource status and
surface any errors (`error.message`, `error.name`).

## 6. Audit

Log to the user: recipe path, timestamp, run summary (hosts, ok/changed/failed
counts per host).

## Target syntax

- Named host: `web-1`
- Group: `@web`
- Multiple: `web-1,web-2`
- Ad-hoc (no inventory): `user@host:port`

When using named hosts or groups, pass `-i <inventory.ts>` unless inventory is
already configured (for example in `ignition.config.ts`).

## Output contract

Canonical contract source:

```bash
ignition schema all --format json
```

Read:

- `.output` for run/check JSON envelope + `resourceResult` contract
- `.cli` for command/flag grammar

RunSummary envelope from `--format json` (illustrative subset):

```json
{
  "recipe": { "path": "...", "checksum": "sha256:..." },
  "timestamp": "ISO-8601",
  "mode": "apply|check",
  "hasFailures": false,
  "durationMs": 1234,
  "hosts": [
    {
      "host": { "name": "web-1", "hostname": "10.0.1.10" },
      "results": [{ "type": "apt", "name": "nginx", "status": "changed", "durationMs": 3200 }],
      "ok": 0,
      "changed": 1,
      "failed": 0,
      "durationMs": 3200
    }
  ]
}
```

Errors: `{ "message": string, "name": string }` — check `hasFailures` and
per-resource `status: "failed"` entries.

## Safety

- Always `check` before `run`
- Never skip human confirmation
- `destructive: true` resources can remove state (`file`/`apt`/`directory` with
  `state: "absent"`, and `exec` which runs arbitrary commands)
- `idempotent: false` resources always execute (`exec`, `service` with
  `restarted`/`reloaded`)
- Use `--error-mode fail-fast` (default) for safety
