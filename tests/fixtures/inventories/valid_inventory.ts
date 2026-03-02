/** A valid inventory with defaults, groups, standalone hosts, and variables. */
import type { Inventory } from "../../../src/inventory/types.ts"

export default {
  defaults: {
    user: "deploy",
    port: 22,
  },
  vars: {
    env: "production",
    region: "us-east-1",
  },
  groups: {
    web: {
      vars: { role: "webserver", pool_size: 4 },
      hosts: {
        "web-1": { hostname: "10.0.1.10", vars: { pool_size: 8 } },
        "web-2": { hostname: "10.0.1.11" },
      },
    },
    db: {
      vars: { role: "database" },
      hosts: {
        "db-1": { hostname: "10.0.2.10", port: 2222 },
      },
    },
  },
  hosts: {
    bastion: { hostname: "203.0.113.1", user: "admin", vars: { role: "bastion" } },
  },
} satisfies Inventory
