/**
 * Example inventory: Multi-tier application infrastructure.
 *
 * Demonstrates a realistic production setup with web, app, and database tiers,
 * each with tier-specific variables and host-level overrides.
 *
 * Usage:
 *   ignition run examples/nginx.ts @web -i examples/multi-tier-inventory.ts
 *   ignition run examples/postgres.ts @db -i examples/multi-tier-inventory.ts
 *   ignition inventory examples/multi-tier-inventory.ts
 */

import type { Inventory } from "../src/inventory/types.ts"

export default {
  defaults: {
    user: "deploy",
    port: 22,
  },
  vars: {
    env: "production",
    domain: "myapp.example.com",
    ssh_port: 22,
  },
  groups: {
    web: {
      vars: {
        role: "webserver",
        http_port: 80,
        https_port: 443,
      },
      hosts: {
        "web-1": { hostname: "10.0.1.10", vars: { server_id: 1, primary: true } },
        "web-2": { hostname: "10.0.1.11", vars: { server_id: 2, primary: false } },
        "web-3": { hostname: "10.0.1.12", vars: { server_id: 3, primary: false } },
      },
    },
    app: {
      vars: {
        role: "application",
        app_name: "myapp",
        app_port: 3000,
        app_user: "myapp",
        node_env: "production",
      },
      hosts: {
        "app-1": { hostname: "10.0.2.10", vars: { app_port: 3000 } },
        "app-2": { hostname: "10.0.2.11", vars: { app_port: 3001 } },
      },
    },
    db: {
      vars: {
        role: "database",
        db_port: 5432,
        db_name: "myapp",
        db_user: "myapp",
        pg_listen: "10.0.3.0/24",
      },
      hosts: {
        "db-primary": {
          hostname: "10.0.3.10",
          vars: { db_role: "primary", db_password: "changeme" },
        },
        "db-replica": {
          hostname: "10.0.3.11",
          vars: { db_role: "replica", db_password: "changeme" },
        },
      },
    },
  },
  hosts: {
    bastion: { hostname: "203.0.113.1", user: "admin", vars: { role: "bastion" } },
    monitor: { hostname: "10.0.4.10", vars: { role: "monitoring", grafana_port: 3000 } },
  },
} satisfies Inventory
