/**
 * Example recipe: Install and configure Nginx.
 *
 * Usage:
 *   ignition run   examples/nginx.ts @web -i examples/inventory.ts
 *   ignition run --check examples/nginx.ts @web -i examples/inventory.ts
 */

import type { ExecutionContext, TemplateContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"
import siteTemplate from "./templates/nginx-site.conf.ts"

export const meta = {
  description: "Install and configure Nginx with a site template",
  tags: ["web", "nginx"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { apt, file, directory, service } = createResources(ctx)

  // Install nginx
  await apt({ name: "nginx", state: "present" })

  // Ensure site root exists
  const domain = (ctx.vars.domain as string) ?? "localhost"
  await directory({ path: `/var/www/${domain}`, mode: "755", owner: "www-data", group: "www-data" })

  // Deploy site configuration from template
  await file({
    path: `/etc/nginx/sites-available/${domain}.conf`,
    template: siteTemplate as (vars: TemplateContext) => string,
    mode: "644",
  })

  // Deploy a default index page
  await file({
    path: `/var/www/${domain}/index.html`,
    content: `<!DOCTYPE html>\n<html>\n<head><title>${domain}</title></head>\n<body><h1>Welcome to ${domain}</h1></body>\n</html>\n`,
    mode: "644",
    owner: "www-data",
    group: "www-data",
  })

  // Enable and start nginx
  await service({ name: "nginx", state: "started", enabled: true })
}
