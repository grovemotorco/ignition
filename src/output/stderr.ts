/** stderr writer compatible with Spinner/Reporter interface. */
export const stderrWriter = {
  isTerminal: () => (process.stderr as { isTTY?: boolean }).isTTY ?? false,
  columns: () => (process.stderr as { columns?: number }).columns,
  writeSync: (p: Uint8Array) => {
    process.stderr.write(p)
    return p.length
  },
}
