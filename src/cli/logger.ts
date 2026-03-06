import { middleware, z } from "incur"

/** Minimal human-oriented logger used by CLI commands. */
export type HumanLogger = {
  /** Whether this logger should emit human-readable output. */
  enabled: boolean
  /** Backing stream used for terminal output when available. */
  stream?: NodeJS.WriteStream | undefined
  /** Write raw text without appending a newline. */
  write(text: string): void
  /** Write text and ensure it ends with a trailing newline. */
  writeln(text: string): void
}

const noop = (_text: string): void => {}

/** Disabled logger implementation used when TTY output is off. */
export const disabledLogger: HumanLogger = Object.freeze({
  enabled: false,
  write: noop,
  writeln: noop,
})

/** CLI middleware vars schema that threads a `HumanLogger` through commands. */
export const loggerVarsSchema = z.object({
  logger: z.custom<HumanLogger>().default(disabledLogger),
})

/** Create a human logger backed by a stream or custom write callback. */
export function createHumanLogger(
  options: {
    enabled?: boolean | undefined
    stream?: NodeJS.WriteStream | undefined
    write?: ((text: string) => void) | undefined
  } = {},
): HumanLogger {
  const { enabled = false, stream, write = noop } = options
  if (!enabled) return disabledLogger

  return {
    enabled: true,
    stream,
    write,
    writeln(text: string) {
      write(text.endsWith("\n") ? text : `${text}\n`)
    },
  }
}

/** Attach a stderr-backed human logger to every CLI request context. */
export const loggerMiddleware = middleware<typeof loggerVarsSchema>(async (c, next) => {
  const enabled = process.stderr.isTTY === true
  c.set(
    "logger",
    createHumanLogger({
      enabled,
      stream: enabled ? process.stderr : undefined,
      write(text: string) {
        process.stderr.write(text)
      },
    }),
  )
  await next()
})
