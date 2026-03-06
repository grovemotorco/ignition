/**
 * Example recipe: Install and configure PostgreSQL.
 *
 * Installs PostgreSQL, configures listen addresses and authentication,
 * creates an application database and user.
 *
 * Usage:
 *   ignition run   examples/postgres.ts @db -i examples/inventory.ts --var db_name=myapp --var db_user=appuser --var db_password=secret
 *   ignition run --check examples/postgres.ts @db -i examples/inventory.ts
 */

import type { ExecutionContext, TemplateContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Install and configure PostgreSQL with app database",
  tags: ["database", "postgres"],
}

const pgHbaConf = (vars: TemplateContext): string => {
  const dbName = (vars.db_name as string) ?? "app"
  const dbUser = (vars.db_user as string) ?? "app"
  return `# PostgreSQL Client Authentication Configuration
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             postgres                                peer
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
host    ${dbName}       ${dbUser}       0.0.0.0/0               scram-sha-256
`
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, exec, file, directory, service } = createResources(ctx)
  const dbName = (ctx.vars.db_name as string) ?? "app"
  const dbUser = (ctx.vars.db_user as string) ?? "app"
  const dbPassword = (ctx.vars.db_password as string) ?? "changeme"
  const listenAddresses = (ctx.vars.pg_listen as string) ?? "localhost"

  // Install PostgreSQL
  await apt({ name: ["postgresql", "postgresql-client"], state: "present", update: true })

  // Ensure data directory permissions
  await directory({
    path: "/var/lib/postgresql",
    owner: "postgres",
    group: "postgres",
    mode: "700",
  })

  // Configure listen addresses
  await exec({
    command: `sed -i "s/^#\\?listen_addresses.*/listen_addresses = '${listenAddresses}'/" /etc/postgresql/*/main/postgresql.conf`,
    sudo: true,
  })

  // Deploy pg_hba.conf via template
  await exec({
    command: `ls /etc/postgresql/*/main/pg_hba.conf | head -1`,
    sudo: true,
  })

  // Use a well-known path pattern for the pg_hba.conf
  await file({
    path: "/etc/postgresql-hba-ignition.conf",
    template: pgHbaConf as (vars: TemplateContext) => string,
    mode: "640",
    owner: "postgres",
    group: "postgres",
  })

  // Copy the generated config into the versioned PG directory
  await exec({
    command: `cp /etc/postgresql-hba-ignition.conf $(ls -d /etc/postgresql/*/main/)/pg_hba.conf`,
    sudo: true,
  })

  // Create database and user
  await exec({
    command: `sudo -u postgres psql -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}';"`,
    unless: `sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'" | grep -q 1`,
    sudo: true,
    check: false,
  })

  await exec({
    command: `sudo -u postgres psql -c "CREATE DATABASE ${dbName} OWNER ${dbUser};"`,
    unless: `sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1`,
    sudo: true,
    check: false,
  })

  // Restart PostgreSQL to apply config changes
  await service({ name: "postgresql", state: "restarted", enabled: true })
}
