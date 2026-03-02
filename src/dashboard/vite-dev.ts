/**
 * Vite dev server launcher for dashboard UI development.
 *
 * Spawns a Vite dev server as a child process with proxy config pointing
 * at the DashboardServer. Uses subprocess approach rather than the
 * programmatic API because Bun's http module doesn't support WebSocket
 * upgrade proxying through node-http-proxy (oven-sh/bun#14522).
 *
 * In production builds where source files are absent, canStartViteDev()
 * returns false and the embedded HTML fallback is used instead.
 */

import { resolve } from "node:path"
import { DASHBOARD_HTML } from "./assets.ts"

const UI_ROOT = resolve(import.meta.dir, "ui")
const MAIN_ENTRY = resolve(UI_ROOT, "src/main.tsx")
const VITE_CONFIG = resolve(UI_ROOT, "vite.config.ts")

export interface ViteDevHandle {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

export interface ViteDevOptions {
  readonly apiHostname: string
  readonly apiPort: number
}

/** Returns true when running from source checkout with no production embed. */
export async function canStartViteDev(): Promise<boolean> {
  if (DASHBOARD_HTML) return false

  const file = Bun.file(MAIN_ENTRY)
  return file.exists()
}

/**
 * Spawn a Vite dev server with HMR, proxying API/WS to the DashboardServer.
 *
 * Writes a temporary Vite config that merges the existing config with the
 * correct proxy targets, then spawns `bunx vite` as a child process.
 */
export async function startViteDev(opts: ViteDevOptions): Promise<ViteDevHandle> {
  const port = 5173

  const tmpConfig = resolve(UI_ROOT, ".vite-dev-proxy.config.ts")
  const configContents = `
import { defineConfig, mergeConfig, loadConfigFromFile } from "vite"

const loaded = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  ${JSON.stringify(VITE_CONFIG)},
)

export default mergeConfig(loaded?.config ?? {}, defineConfig({
  server: {
    proxy: {
      "/ws": { target: "ws://${opts.apiHostname}:${opts.apiPort}", ws: true },
      "/api": { target: "http://${opts.apiHostname}:${opts.apiPort}", changeOrigin: true },
    },
  },
}))
`
  await Bun.write(tmpConfig, configContents)

  const proc = Bun.spawn(
    ["bunx", "vite", "--config", tmpConfig, "--port", String(port), "--strictPort", "false"],
    {
      cwd: UI_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const resolvedPort = await waitForViteReady(proc, port)
  const url = `http://localhost:${resolvedPort}`

  return {
    port: resolvedPort,
    url,
    async close() {
      proc.kill()
      await proc.exited
      try {
        const f = Bun.file(tmpConfig)
        if (await f.exists()) {
          const { unlink } = await import("node:fs/promises")
          await unlink(tmpConfig)
        }
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Wait for Vite's stdout to emit the "ready" line and extract the port.
 * Falls back to the default port after a timeout.
 */
async function waitForViteReady(
  proc: { stdout: ReadableStream<Uint8Array>; exited: Promise<number> },
  defaultPort: number,
): Promise<number> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const portRegex = /Local:\s+https?:\/\/[^:]+:(\d+)/

  const timeout = new Promise<number>((_, reject) =>
    setTimeout(() => reject(new Error("Vite dev server did not start within 15s")), 15_000),
  )

  const parse = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const match = buffer.match(portRegex)
      if (match) {
        reader.releaseLock()
        return Number(match[1])
      }
    }
    reader.releaseLock()
    return defaultPort
  })()

  return Promise.race([parse, timeout])
}
