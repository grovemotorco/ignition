/**
 * Example Nginx site configuration template for Ignition.
 *
 * Template functions receive the merged variables from the execution context
 * (inventory defaults → group vars → host vars → CLI overrides) and return
 * a string to write to the remote host.
 */

import type { TemplateContext } from "../../src/core/types.ts"

function scalar(vars: TemplateContext, key: string, fallback: string): string {
  const value = vars[key]
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return fallback
}

export default (vars: TemplateContext): string => {
  const listenPort = scalar(vars, "http_port", "80")
  const serverName = scalar(vars, "domain", "localhost")
  const domainForPaths = scalar(vars, "domain", "default")

  return `server {
    listen ${listenPort};
    server_name ${serverName};

    root /var/www/${domainForPaths};
    index index.html;

    access_log /var/log/nginx/${domainForPaths}.access.log;
    error_log  /var/log/nginx/${domainForPaths}.error.log;

    location / {
        try_files $uri $uri/ =404;
    }
}
`
}
