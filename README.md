<p align="center">
  <img src="docs/public/logo.png" alt="Ignition" width="100" height="100">
</p>

<h3 align="center">Server provisioning in TypeScript.</h3>

<p align="center">
  <strong>Experimental</strong> &mdash; Ignition is under active development and not yet production-ready.
</p>

<p align="center">
  <a href="https://ignition.sh/docs/getting-started/installation">Installation</a> &middot;
  <a href="https://ignition.sh/docs/getting-started/first-recipe">Quick Start</a> &middot;
  <a href="https://ignition.sh/docs">Documentation</a>
</p>

---

Write provisioning recipes as async functions, push them over SSH, get idempotent results. No YAML. No agents. No state files.

```typescript
export default async function (ctx: ExecutionContext) {
  const { apt, file, service } = createResources(ctx)

  await apt({ name: "nginx", state: "present" })
  await file({ path: "/etc/nginx/app.conf", template: nginxConfig, mode: "0644" })
  await service({ name: "nginx", state: "started", enabled: true })
}
```

```bash
ignition run --check deploy.ts root@203.0.113.10    # dry-run
ignition run deploy.ts root@203.0.113.10            # apply
```

## Install

```bash
bun install -g @grovemotorco/ignition
```

Or run from source:

```bash
git clone https://github.com/grovemotorco/ignition.git
cd ignition && bun install
bun run src/cli.ts run <recipe.ts> <target>
```

## Commands

| Command                                   | Description                       |
| ----------------------------------------- | --------------------------------- |
| `ignition run <recipe> <targets>`         | Apply a recipe to target hosts    |
| `ignition run --check <recipe> <targets>` | Dry-run (no changes applied)      |
| `ignition init`                           | Scaffold a new project            |
| `ignition inventory [file]`               | List hosts from inventory         |
| `ignition dashboard`                      | Start the web dashboard           |
| `ignition schema resources`               | Machine-readable resource schemas |

See the [CLI reference](https://ignition.sh/docs/reference/cli) for full option documentation.

## Resources

Five built-in resources cover the vast majority of provisioning tasks:

| Resource                                                              | Description                                      |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| [`apt`](https://ignition.sh/docs/reference/resources/apt)             | Install, remove, and update system packages      |
| [`file`](https://ignition.sh/docs/reference/resources/file)           | Manage file contents, permissions, and ownership |
| [`directory`](https://ignition.sh/docs/reference/resources/directory) | Ensure directories exist with correct attributes |
| [`exec`](https://ignition.sh/docs/reference/resources/exec)           | Run arbitrary commands on the remote host        |
| [`service`](https://ignition.sh/docs/reference/resources/service)     | Manage systemd services                          |

## Development

```bash
bun install
bun run verify          # type-check + lint + format-check + test (run before every commit)
bun run src/cli.ts      # run CLI from source
```

See the [contributing guide](https://ignition.sh/docs/contributing/development) for architecture details and dashboard development.

## License

MIT
