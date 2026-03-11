import { spawn } from "node:child_process"

export type SpawnResult = {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
}

export function spawnBuffered(
  bin: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts?.signal,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
        stderr: new Uint8Array(Buffer.concat(stderrChunks)),
      })
    })
  })
}
