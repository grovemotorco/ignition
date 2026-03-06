import { middleware, z } from "incur"

export interface HumanLogger {
  readonly enabled: boolean
  readonly stream?: NodeJS.WriteStream | undefined
  write(text: string): void
  writeln(text: string): void
}

const noop = (_text: string): void => {}

export const disabledLogger: HumanLogger = Object.freeze({
  enabled: false,
  write: noop,
  writeln: noop,
})

export const loggerVarsSchema = z.object({
  logger: z.custom<HumanLogger>().default(disabledLogger),
})

export function createHumanLogger(
  options: {
    enabled?: boolean
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
