/**
 * Example recipe: Basic security hardening for Debian/Ubuntu.
 *
 * Disables root SSH login, configures firewall basics via ufw,
 * enables automatic security updates, and hardens sshd_config.
 *
 * Usage:
 *   ignition run   examples/security-hardening.ts @all -i examples/inventory.ts
 *   ignition run --check examples/security-hardening.ts @all -i examples/inventory.ts
 */

import type { ExecutionContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Basic security hardening for Debian/Ubuntu servers",
  tags: ["security", "hardening", "ssh", "firewall"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, exec, file, service } = createResources(ctx)
  const sshPort = (ctx.vars.ssh_port as number) ?? 22

  // Install security packages
  await apt({ name: ["ufw", "fail2ban", "unattended-upgrades"], state: "present", update: true })

  // Harden sshd_config
  await file({
    path: "/etc/ssh/sshd_config.d/99-hardening.conf",
    content: [
      `Port ${sshPort}`,
      "PermitRootLogin no",
      "PasswordAuthentication no",
      "PubkeyAuthentication yes",
      "X11Forwarding no",
      "MaxAuthTries 3",
      "ClientAliveInterval 300",
      "ClientAliveCountMax 2",
      "",
    ].join("\n"),
    mode: "644",
  })

  // Restart sshd to pick up new config
  await service({ name: "sshd", state: "reloaded" })

  // Configure UFW firewall
  await exec({ command: `ufw default deny incoming`, sudo: true })
  await exec({ command: `ufw default allow outgoing`, sudo: true })
  await exec({ command: `ufw allow ${sshPort}/tcp`, sudo: true })
  await exec({ command: `ufw --force enable`, sudo: true })

  // Allow additional ports if specified
  const extraPorts = ctx.vars.allowed_ports as string[] | undefined
  if (extraPorts) {
    for (const port of extraPorts) {
      await exec({ command: `ufw allow ${port}`, sudo: true })
    }
  }

  // Configure automatic security updates
  await file({
    path: "/etc/apt/apt.conf.d/20auto-upgrades",
    content: [
      'APT::Periodic::Update-Package-Lists "1";',
      'APT::Periodic::Unattended-Upgrade "1";',
      'APT::Periodic::AutocleanInterval "7";',
      "",
    ].join("\n"),
    mode: "644",
  })

  // Enable fail2ban
  await service({ name: "fail2ban", state: "started", enabled: true })
}
