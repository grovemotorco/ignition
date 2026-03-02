/**
 * Example inventory file for Ignition.
 *
 * An inventory maps logical host names to SSH connection details and variables.
 * Usage:
 *   ignition run examples/nginx.ts @web -i examples/inventory.ts
 */

import type { Inventory } from "../src/inventory/types.ts"

export default {
  defaults: {
    user: "deploy",
    port: 22,
  },
  vars: {
    env: "production",
    domain: "example.com",
  },
  groups: {
    web: {
      vars: { role: "webserver", http_port: 80 },
      hosts: {
        "web-1": { hostname: "10.0.1.10", vars: { server_id: 1 } },
        "web-2": { hostname: "10.0.1.11", vars: { server_id: 2 } },
      },
    },
    db: {
      vars: { role: "database", db_port: 5432 },
      hosts: {
        "db-1": { hostname: "10.0.2.10" },
      },
    },
  },
  hosts: {
    bastion: { hostname: "203.0.113.1", user: "admin" },
  },
} satisfies Inventory
