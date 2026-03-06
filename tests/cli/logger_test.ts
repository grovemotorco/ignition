import { afterEach, expect, test } from "bun:test"
import { Cli, z } from "incur"
import { loggerMiddleware, loggerVarsSchema } from "../../src/cli/logger.ts"

const originalStdoutIsTTY = process.stdout.isTTY
const originalStderrIsTTY = process.stderr.isTTY
const originalStderrWrite = process.stderr.write.bind(process.stderr)

afterEach(() => {
  ;(process.stdout as { isTTY?: boolean }).isTTY = originalStdoutIsTTY
  ;(process.stderr as { isTTY?: boolean }).isTTY = originalStderrIsTTY
  ;(process.stderr as { write: typeof process.stderr.write }).write = originalStderrWrite
})

async function serve(
  cli: ReturnType<typeof Cli.create>,
  argv: string[],
): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> {
  let stdout = ""
  let stderr = ""
  let exitCode: number | undefined

  ;(process.stderr as { write: typeof process.stderr.write }).write = ((
    chunk: string | Uint8Array,
  ) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write

  await cli.serve(argv, {
    exit(code: number) {
      exitCode = code
    },
    stdout(text: string) {
      stdout += text
    },
  })

  return { exitCode, stderr, stdout }
}

test("logger middleware keeps human output on stderr while stdout stays machine-readable", async () => {
  ;(process.stdout as { isTTY?: boolean }).isTTY = false
  ;(process.stderr as { isTTY?: boolean }).isTTY = true

  const cli = Cli.create("test", {
    vars: loggerVarsSchema,
  })
    .use(loggerMiddleware)
    .use(async (c, next) => {
      c.var.logger.writeln(`Running ${c.command}...`)
      await next()
    })
    .command("status", {
      output: z.object({
        agent: z.boolean(),
        loggerEnabled: z.boolean(),
      }),
      run(c) {
        return {
          agent: c.agent,
          loggerEnabled: c.var.logger.enabled,
        }
      },
    })

  const { exitCode, stderr, stdout } = await serve(cli, ["status", "--format", "json"])

  expect(exitCode).toBeUndefined()
  expect(JSON.parse(stdout)).toEqual({ agent: true, loggerEnabled: true })
  expect(stderr).toEndWith("Running status...\n")
})

test("logger middleware noops when stderr is not a tty", async () => {
  ;(process.stdout as { isTTY?: boolean }).isTTY = false
  ;(process.stderr as { isTTY?: boolean }).isTTY = false

  const cli = Cli.create("test", {
    vars: loggerVarsSchema,
  })
    .use(loggerMiddleware)
    .command("status", {
      output: z.object({
        loggerEnabled: z.boolean(),
      }),
      run(c) {
        c.var.logger.writeln("hidden")
        return { loggerEnabled: c.var.logger.enabled }
      },
    })

  const { stderr, stdout } = await serve(cli, ["status", "--format", "json"])

  expect(JSON.parse(stdout)).toEqual({ loggerEnabled: false })
  expect(stderr).not.toContain("hidden")
})
