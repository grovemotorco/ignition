/**
 * Example recipe: Provision an Ubuntu server for Node.js applications.
 *
 * Sets up the full stack: Node.js 24 LTS via NodeSource, a deploy user,
 * application directory structure, PM2 process manager, Nginx reverse proxy,
 * and firewall rules.
 *
 * Usage:
 *   ignition run   examples/node-server.ts root@10.0.1.5 --var app_name=myapp --var domain=myapp.example.com
 *   ignition run --check examples/node-server.ts root@10.0.1.5
 *
 *   # With inventory:
 *   ignition run   examples/node-server.ts @web -i examples/inventory.ts
 */

import type { ExecutionContext, TemplateContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Provision an Ubuntu server for Node.js applications",
  tags: ["node", "server", "nginx", "pm2"],
}

const nginxProxyConf = (vars: TemplateContext): string => {
  const domain = (vars.domain as string) ?? "localhost"
  const appPort = (vars.app_port as number) ?? 3000
  return `server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${appPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`
}

const pm2Ecosystem = (vars: TemplateContext): string => {
  const appName = (vars.app_name as string) ?? "app"
  const appPort = (vars.app_port as number) ?? 3000
  return `module.exports = {
  apps: [{
    name: '${appName}',
    script: 'server.js',
    cwd: '/opt/${appName}/current',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: ${appPort},
    },
  }],
};
`
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, exec, file, directory, service } = createResources(ctx)
  const appName = (ctx.vars.app_name as string) ?? "app"
  const deployUser = (ctx.vars.deploy_user as string) ?? "deploy"

  // --- System packages ---
  await apt({
    name: ["curl", "ca-certificates", "gnupg", "build-essential"],
    state: "present",
    update: true,
  })

  // --- Node.js 24 LTS via NodeSource ---
  await exec({
    command: "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
    unless: "test -f /etc/apt/sources.list.d/nodesource.list",
    sudo: true,
  })
  await apt({ name: "nodejs", state: "present" })

  // --- PM2 process manager ---
  await exec({
    command: "npm install -g pm2",
    unless: "command -v pm2",
    sudo: true,
  })

  // --- Deploy user ---
  await exec({
    command: `useradd --create-home --shell /bin/bash ${deployUser}`,
    unless: `id -u ${deployUser}`,
    sudo: true,
  })

  // --- Application directory structure ---
  await directory({ path: `/opt/${appName}`, owner: deployUser, group: deployUser, mode: "755" })
  await directory({
    path: `/opt/${appName}/releases`,
    owner: deployUser,
    group: deployUser,
    mode: "755",
  })
  await directory({
    path: `/opt/${appName}/shared`,
    owner: deployUser,
    group: deployUser,
    mode: "755",
  })
  await directory({
    path: `/opt/${appName}/shared/logs`,
    owner: deployUser,
    group: deployUser,
    mode: "755",
  })

  // --- PM2 ecosystem file ---
  await file({
    path: `/opt/${appName}/ecosystem.config.js`,
    template: pm2Ecosystem as (vars: TemplateContext) => string,
    owner: deployUser,
    group: deployUser,
    mode: "644",
  })

  // --- PM2 startup on boot ---
  await exec({
    command: `pm2 startup systemd -u ${deployUser} --hp /home/${deployUser} 2>/dev/null || true`,
    sudo: true,
    check: false,
  })

  // --- Nginx reverse proxy ---
  await apt({ name: "nginx", state: "present" })

  await file({
    path: `/etc/nginx/sites-available/${appName}.conf`,
    template: nginxProxyConf as (vars: TemplateContext) => string,
    mode: "644",
  })

  // Enable the site
  await exec({
    command: `ln -sf /etc/nginx/sites-available/${appName}.conf /etc/nginx/sites-enabled/${appName}.conf`,
    sudo: true,
  })

  // Remove default site
  await exec({
    command: "rm -f /etc/nginx/sites-enabled/default",
    sudo: true,
  })

  await service({ name: "nginx", state: "started", enabled: true })

  // --- Firewall ---
  await apt({ name: "ufw", state: "present" })
  await exec({ command: "ufw default deny incoming", sudo: true })
  await exec({ command: "ufw default allow outgoing", sudo: true })
  await exec({ command: "ufw allow 22/tcp", sudo: true })
  await exec({ command: "ufw allow 80/tcp", sudo: true })
  await exec({ command: "ufw allow 443/tcp", sudo: true })
  await exec({ command: "ufw --force enable", sudo: true, check: false })
}
