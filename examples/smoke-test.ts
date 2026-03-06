/**
 * Smoke test recipe: verify Ignition works against a live server.
 *
 * Safe to run — creates only temporary files and cleans up after itself.
 * No packages installed, no services modified, no permanent changes.
 *
 * Usage:
 *   ignition run --check examples/smoke-test.ts admin@10.0.1.5
 *   ignition run   examples/smoke-test.ts admin@10.0.1.5
 *
 *   # With inventory:
 *   ignition run --check examples/smoke-test.ts @web -i examples/inventory.ts
 *   ignition run   examples/smoke-test.ts @web -i examples/inventory.ts
 */

import type { ExecutionContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Non-destructive smoke test for live servers",
  tags: ["test", "smoke"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { exec, file, directory } = createResources(ctx)

  // 1. Read /etc/hostname — proves SSH connectivity and command execution
  await exec({ command: "cat /etc/hostname" })

  // 2. Read /etc/hosts — verify we can read system files
  await exec({ command: "cat /etc/hosts" })

  // 3. Gather basic system info
  await exec({ command: "uname -a" })
  await exec({ command: "uptime" })
  await exec({ command: "df -h / | tail -1" })

  // 4. Create a temp directory (idempotent)
  await directory({ path: "/tmp/ignition-smoke-test", mode: "755" })

  // 5. Write a temp file (check mode will show "would change", run mode writes it)
  await file({
    path: "/tmp/ignition-smoke-test/hello.txt",
    content: `Hello from Ignition!\nHost: ${ctx.host.name}\nTimestamp: ${new Date().toISOString()}\n`,
    mode: "644",
  })

  // 6. Verify the file was written
  await exec({ command: "cat /tmp/ignition-smoke-test/hello.txt" })

  // 7. Clean up — remove the temp file and directory
  await file({ path: "/tmp/ignition-smoke-test/hello.txt", state: "absent" })
  await directory({ path: "/tmp/ignition-smoke-test", state: "absent" })
}
