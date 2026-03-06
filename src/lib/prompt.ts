import { createInterface } from "node:readline"

/**
 * Prompt for a single line of input via stderr (keeps stdout clean).
 * Returns `null` if stdin is not a TTY.
 */
export async function stderrPrompt(message: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await new Promise<string>((resolve) => {
      rl.question(message, (answer) => resolve(answer))
    })
  } finally {
    rl.close()
  }
}
