export type FieldChange = {
  field: string
  current: string | undefined
  desired: string | undefined
}

export function computeChanges(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = []

  for (const key of Object.keys(desired)) {
    if (key === "state") continue
    const cur = current[key]
    const des = desired[key]
    if (cur === undefined && des === undefined) continue
    if (cur !== undefined && des !== undefined && JSON.stringify(cur) === JSON.stringify(des))
      continue
    changes.push({
      field: key,
      current: cur !== undefined ? formatValue(cur) : undefined,
      desired: des !== undefined ? formatValue(des) : undefined,
    })
  }

  return changes
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  return JSON.stringify(value)
}

export function formatContentDiff(current: string, desired: string): string[] {
  const currentLines = current.split("\n")
  const desiredLines = desired.split("\n")
  const lines: string[] = []

  let ci = 0
  let di = 0

  while (ci < currentLines.length || di < desiredLines.length) {
    if (ci < currentLines.length && di < desiredLines.length) {
      if (currentLines[ci] === desiredLines[di]) {
        ci++
        di++
        continue
      }
      const desIdx = desiredLines.indexOf(currentLines[ci], di)
      const curIdx = currentLines.indexOf(desiredLines[di], ci)

      if (desIdx !== -1 && (curIdx === -1 || desIdx - di <= curIdx - ci)) {
        while (di < desIdx) {
          lines.push(`+ ${desiredLines[di]}`)
          di++
        }
      } else if (curIdx !== -1) {
        while (ci < curIdx) {
          lines.push(`- ${currentLines[ci]}`)
          ci++
        }
      } else {
        lines.push(`- ${currentLines[ci]}`)
        lines.push(`+ ${desiredLines[di]}`)
        ci++
        di++
      }
    } else if (ci < currentLines.length) {
      lines.push(`- ${currentLines[ci]}`)
      ci++
    } else {
      lines.push(`+ ${desiredLines[di]}`)
      di++
    }
  }

  return lines
}

export function formatDiffLines(
  changes: FieldChange[],
  currentRecord?: Record<string, unknown>,
  desiredRecord?: Record<string, unknown>,
): string[] {
  const lines: string[] = []

  for (const change of changes) {
    if (
      change.field === "content" &&
      currentRecord &&
      desiredRecord &&
      typeof currentRecord.content === "string" &&
      typeof desiredRecord.content === "string"
    ) {
      lines.push(
        ...formatContentDiff(currentRecord.content as string, desiredRecord.content as string),
      )
      continue
    }

    if (change.current !== undefined) {
      lines.push(`- ${change.field}: ${change.current}`)
    }
    if (change.desired !== undefined) {
      lines.push(`+ ${change.field}: ${change.desired}`)
    }
  }

  return lines
}
