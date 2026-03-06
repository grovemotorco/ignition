/**
 * Example recipe: Deploy a Node.js application.
 *
 * Installs Node.js, creates an app user, deploys app files,
 * installs dependencies, and manages the systemd service.
 *
 * Usage:
 *   ignition run   examples/node-app.ts @web -i examples/inventory.ts --var app_name=myapp --var app_port=3000
 *   ignition run --check examples/node-app.ts @web -i examples/inventory.ts
 */

import type { ExecutionContext, TemplateContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Deploy a Node.js application with systemd service",
  tags: ["node", "app", "deploy"],
}

const systemdUnit = (vars: TemplateContext): string => {
  const name = (vars.app_name as string) ?? "app"
  const port = (vars.app_port as number) ?? 3000
  const user = (vars.app_user as string) ?? name
  return `[Unit]
Description=${name} service
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=/opt/${name}
ExecStart=/usr/bin/node /opt/${name}/server.js
Restart=on-failure
RestartSec=5
Environment=PORT=${port}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, exec, file, directory, service } = createResources(ctx)
  const appName = (ctx.vars.app_name as string) ?? "myapp"
  const appPort = (ctx.vars.app_port as number) ?? 3000

  // Install Node.js runtime
  await apt({ name: ["nodejs", "npm"], state: "present", update: true })

  // Create application user
  await exec({
    command: `useradd --system --home /opt/${appName} --shell /usr/sbin/nologin ${appName}`,
    unless: `id -u ${appName}`,
    sudo: true,
  })

  // Create app directories
  await directory({ path: `/opt/${appName}`, owner: appName, group: appName, mode: "755" })
  await directory({ path: `/var/log/${appName}`, owner: appName, group: appName, mode: "755" })

  // Deploy a minimal server.js
  await file({
    path: `/opt/${appName}/server.js`,
    content: `const http = require('http');\nconst server = http.createServer((req, res) => {\n  res.writeHead(200);\n  res.end('${appName} running on port ${appPort}');\n});\nserver.listen(process.env.PORT || ${appPort});\n`,
    owner: appName,
    group: appName,
    mode: "644",
  })

  // Deploy systemd service unit
  await file({
    path: `/etc/systemd/system/${appName}.service`,
    template: systemdUnit as (vars: TemplateContext) => string,
    mode: "644",
  })

  // Reload systemd and start the service
  await exec({ command: "systemctl daemon-reload", sudo: true })
  await service({ name: appName, state: "started", enabled: true })
}
