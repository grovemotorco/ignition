/**
 * System info recipe: read-only server inspection.
 *
 * Purely read-only — only runs commands, never writes or modifies anything.
 * Ideal for verifying SSH access and inspecting remote hosts.
 * Identical behavior in both check and run modes.
 *
 * Usage:
 *   ignition run   examples/system-info.ts admin@10.0.1.5
 *   ignition run --check examples/system-info.ts admin@10.0.1.5
 *
 *   # With inventory:
 *   ignition run examples/system-info.ts @web -i examples/inventory.ts
 */

import type { ExecutionContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Read-only system information gathering",
  tags: ["test", "info", "readonly"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { exec } = createResources(ctx)

  // Identity
  await exec({ command: "hostname -f", check: false })
  await exec({ command: "whoami" })
  await exec({ command: "id" })

  // OS release
  await exec({ command: "cat /etc/os-release", check: false })

  // Kernel and architecture
  await exec({ command: "uname -a" })

  // Uptime and load
  await exec({ command: "uptime" })

  // Memory
  await exec({ command: "free -h" })

  // Disk usage
  await exec({ command: "df -h" })

  // Network interfaces
  await exec({ command: "ip -brief addr show", check: false })

  // Listening ports
  await exec({ command: "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null", check: false })

  // Running services (systemd)
  await exec({
    command:
      "systemctl list-units --type=service --state=running --no-pager 2>/dev/null | head -20",
    check: false,
  })
}
