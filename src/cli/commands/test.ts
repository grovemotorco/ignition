import { Cli, z } from "incur"
import { loggerVarsSchema } from "../logger.ts"
import { Spinner } from "../../output/spinner.ts"

const formats = ["toon", "json", "yaml", "md", "jsonl"] as const

const fixtureContextSchema = z.object({
  fixture: z.string(),
  agent: z.boolean(),
  format: z.enum(formats),
  formatExplicit: z.boolean(),
})

const outputSchema = fixtureContextSchema.extend({
  message: z.string(),
  summary: z.object({
    status: z.literal("ok"),
    count: z.number().int(),
  }),
  items: z.array(
    z.object({
      name: z.string(),
      value: z.number().int(),
    }),
  ),
})

const logSchema = fixtureContextSchema.extend({
  loggerEnabled: z.boolean(),
  linesWritten: z.literal(2),
})

const agentOnlySchema = fixtureContextSchema.extend({
  loggerEnabled: z.boolean(),
  hiddenForHuman: z.literal(true),
})

const outputItems = [
  { name: "alpha", value: 1 },
  { name: "beta", value: 2 },
] as const

type FixtureContext = {
  agent: boolean
  format: (typeof formats)[number]
  formatExplicit: boolean
}

function fixtureContext(c: FixtureContext, fixture: string) {
  return {
    fixture,
    agent: c.agent,
    format: c.format,
    formatExplicit: c.formatExplicit,
  }
}

function createSpinnerWriter(stream: NodeJS.WriteStream): {
  isTerminal: () => boolean
  columns: () => number | undefined
  writeSync(p: Uint8Array): number
} {
  return {
    isTerminal: () => stream.isTTY ?? false,
    columns: () => stream.columns,
    writeSync(p: Uint8Array) {
      stream.write(p)
      return p.length
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const output = Cli.create("output", {
  description: "Emit a deterministic buffered payload for stdout format checks",
  vars: loggerVarsSchema,
  output: outputSchema,
  examples: [{ description: "Render the buffered fixture with the default human format" }],
  usage: [{}, { suffix: "--format json" }, { suffix: "--format yaml" }, { suffix: "--format md" }],
  run(c) {
    return {
      ...fixtureContext(c, "output"),
      message: "fixture output",
      summary: { status: "ok" as const, count: outputItems.length },
      items: outputItems.map((item) => ({ ...item })),
    }
  },
})

const log = Cli.create("log", {
  description: "Write fixed human log lines to stderr while returning a structured payload",
  vars: loggerVarsSchema,
  output: logSchema,
  examples: [{ description: "Show logger output in an interactive terminal" }],
  usage: [{}, { suffix: "--format json" }, { suffix: "--format json 2>logs.txt" }],
  run(c) {
    c.var.logger.writeln("log: begin")
    c.var.logger.writeln("log: end")

    return {
      ...fixtureContext(c, "log"),
      loggerEnabled: c.var.logger.enabled,
      linesWritten: 2 as const,
    }
  },
})

const stream = Cli.create("stream", {
  description: "Stream deterministic chunks and stderr logs for incremental output checks",
  vars: loggerVarsSchema,
  examples: [{ description: "Watch default incremental chunk rendering in a terminal" }],
  usage: [{}, { suffix: "--format jsonl" }],
  async *run(c) {
    c.var.logger.writeln("stream: begin")
    yield { step: 1, label: "alpha" }
    c.var.logger.writeln("stream: between")
    yield { step: 2, label: "beta" }
    return c.ok(undefined, {
      cta: {
        commands: [
          {
            command: "test output",
            description: "Show the buffered output fixture",
          },
        ],
      },
    })
  },
})

const streamSpinner = Cli.create("stream-spinner", {
  description: "Stream chunks while exercising spinner pause/resume behavior on stderr",
  vars: loggerVarsSchema,
  examples: [{ description: "Watch the spinner in a TTY before each streamed chunk" }],
  usage: [{}, { suffix: "--format jsonl" }],
  async *run(c) {
    const spinner = c.var.logger.stream
      ? new Spinner({
          writer: createSpinnerWriter(c.var.logger.stream),
        })
      : undefined

    spinner?.start("test stream-spinner  alpha")
    await sleep(500)
    spinner?.pause()
    yield { step: 1, label: "alpha", spinner: spinner !== undefined }

    spinner?.start("test stream-spinner  beta")
    await sleep(180)
    spinner?.pause()
    yield { step: 2, label: "beta", spinner: spinner !== undefined }

    spinner?.stop()
    return c.ok(undefined, {
      cta: {
        commands: [
          {
            command: "test stream",
            description: "Compare against the plain streaming fixture",
          },
        ],
      },
    })
  },
})

const agentOnly = Cli.create("agent-only", {
  description: "Return data only to agents while keeping stderr human logs visible",
  vars: loggerVarsSchema,
  output: agentOnlySchema,
  outputPolicy: "agent-only",
  examples: [{ description: "Run in a terminal to confirm stdout is suppressed for humans" }],
  usage: [{}, { suffix: "--format json >agent-only.json" }],
  run(c) {
    c.var.logger.writeln("agent-only: visible on stderr")

    return {
      ...fixtureContext(c, "agent-only"),
      loggerEnabled: c.var.logger.enabled,
      hiddenForHuman: true as const,
    }
  },
})

export const test = Cli.create("test", {
  description: "Developer fixtures for validating CLI output and logging",
})
  .command(output)
  .command(log)
  .command(stream)
  .command(streamSpinner)
  .command(agentOnly)
