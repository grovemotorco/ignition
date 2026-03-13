/**
 * Example recipe: Manage Docker containers.
 *
 * Demonstrates the docker resource by deploying a whoami web server
 * and a Redis cache container. Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   ignition run --check examples/docker.ts user@host   # dry-run
 *   ignition run   examples/docker.ts user@host          # apply
 */

import type { ExecutionContext } from "../src/core/types.ts"
import { createResources } from "../src/resources/index.ts"

export const meta = {
  description: "Deploy Docker containers with a reverse-proxy and backend",
  tags: ["docker", "containers"],
}

export default async function (ctx: ExecutionContext): Promise<void> {
  const { docker, exec, directory } = createResources(ctx)

  // 1. Verify Docker is reachable
  await exec({ command: "docker info --format '{{.ServerVersion}}'" })

  // 2. Run a simple whoami backend container
  await docker({
    name: "whoami",
    image: "traefik/whoami:latest",
    state: "started",
    pull: "if-missing",
    ports: [{ hostPort: 8080, containerPort: 80 }],
    labels: { "ignition.example": "docker" },
    restart: "unless-stopped",
  })

  // 3. Verify the backend is responding
  await exec({ command: "curl -sf http://localhost:8080 || echo 'waiting for container...'" })

  // 4. Ensure bind-mount source exists before creating the container
  await directory({ path: "/tmp/ignition-redis-data", mode: "755" })

  // 5. Run a Redis container (no published ports — internal only)
  await docker({
    name: "redis-cache",
    image: "redis:7-alpine",
    state: "started",
    pull: "if-missing",
    mounts: [{ source: "/tmp/ignition-redis-data", target: "/data" }],
    env: { REDIS_ARGS: "--maxmemory 64mb --maxmemory-policy allkeys-lru" },
    labels: { "ignition.example": "docker" },
    restart: "unless-stopped",
  })

  // 6. Show running containers from this example
  await exec({
    command:
      'docker ps --filter "label=ignition.example=docker" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"',
  })
}
