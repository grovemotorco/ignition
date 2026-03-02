/**
 * Redaction and stable serialization utilities.
 *
 * Provides deterministic JSON serialization (sorted keys) and deep-clone
 * redaction for preventing sensitive data leaks through event pipelines,
 * reporters, cache keys, and JSON output. See ISSUE-0033.
 */

// ---------------------------------------------------------------------------
// RedactionPolicy
// ---------------------------------------------------------------------------

/**
 * Policy specifying which fields to redact from serialized output.
 *
 * The `patterns` array contains glob-style field paths that identify
 * sensitive values (e.g. `'*.password'`, `'vars.db_*'`). When secrets
 * management lands, the inventory loader populates this from config
 * and threads it through the execution context.
 */
export interface RedactionPolicy {
  /** Glob-style field paths to redact (e.g. '*.password', 'vars.db_*'). */
  readonly patterns: readonly string[]
  /** Marker to replace redacted values with. Default: '[REDACTED]'. */
  readonly marker?: string
}

/** Default redaction marker. */
const DEFAULT_MARKER = "[REDACTED]"

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization with sorted keys.
 *
 * Replaces `JSON.stringify()` where key order matters (cache keys, event
 * payloads, comparison). Handles nested objects, arrays, nulls, and
 * undefined values. Includes a circular reference guard.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(sortKeys(value, seen))
}

/**
 * Recursively sort object keys for deterministic serialization.
 * Arrays preserve element order; only plain-object keys are sorted.
 */
function sortKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value !== "object") {
    return value
  }

  // Circular reference guard
  if (seen.has(value as object)) {
    return "[Circular]"
  }
  seen.add(value as object)

  if (Array.isArray(value)) {
    const result = value.map((item) => sortKeys(item, seen))
    seen.delete(value as object)
    return result
  }

  // Date → ISO string (matches JSON.stringify behavior)
  if (value instanceof Date) {
    seen.delete(value as object)
    return value
  }

  const sorted: Record<string, unknown> = {}
  const keys = Object.keys(value as Record<string, unknown>).sort()
  for (const key of keys) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key], seen)
  }
  seen.delete(value as object)
  return sorted
}

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

/**
 * Deep-clone a value, replacing fields matching the redaction policy
 * with the configured marker string (default: `'[REDACTED]'`).
 *
 * When no policy is provided or the policy has no patterns, the value
 * is returned as-is (no clone, backward compatible no-op).
 */
export function redact(value: unknown, policy?: RedactionPolicy): unknown {
  if (!policy || policy.patterns.length === 0) {
    return value
  }
  const marker = policy.marker ?? DEFAULT_MARKER
  const matchers = policy.patterns.map(compilePattern)
  return redactValue(value, "", matchers, marker)
}

/**
 * Recursively walk a value, redacting fields whose full path matches
 * any compiled pattern.
 */
function redactValue(
  value: unknown,
  path: string,
  matchers: PatternMatcher[],
  marker: string,
): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value !== "object") {
    return value
  }
  // Preserve Date so JSON serialization still emits ISO strings.
  if (value instanceof Date) {
    return value
  }
  // Preserve Error shape used by JSON serializers while still allowing
  // path-based redaction (for example: "**.error.message").
  if (value instanceof Error) {
    return redactValue({ message: value.message, name: value.name }, path, matchers, marker)
  }

  if (Array.isArray(value)) {
    return value.map((item, i) =>
      redactValue(item, path ? `${path}.${i}` : String(i), matchers, marker),
    )
  }

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const fieldPath = path ? `${path}.${key}` : key
    if (matchers.some((m) => m(fieldPath))) {
      result[key] = marker
    } else {
      result[key] = redactValue(
        (value as Record<string, unknown>)[key],
        fieldPath,
        matchers,
        marker,
      )
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/** A compiled pattern matcher: returns true if the full field path matches. */
type PatternMatcher = (fieldPath: string) => boolean

/**
 * Compile a glob-style pattern into a matcher function.
 *
 * Supported syntax:
 * - `*` matches exactly one path segment (field name)
 * - `**` matches zero or more path segments
 * - Literal segments match by exact field name
 * - `db_*` within a segment matches field names starting with `db_`
 *
 * Examples:
 * - `'password'` matches top-level `password` field
 * - `'*.password'` matches `password` at any depth of exactly one level
 * - `'vars.db_*'` matches `vars.db_host`, `vars.db_pass`, etc.
 */
function compilePattern(pattern: string): PatternMatcher {
  const segments = pattern.split(".")

  return (fieldPath: string): boolean => {
    const pathSegments = fieldPath.split(".")
    return matchSegments(segments, 0, pathSegments, 0)
  }
}

/**
 * Recursive segment matcher supporting `*`, `**`, and intra-segment wildcards.
 */
function matchSegments(
  pattern: readonly string[],
  pi: number,
  path: readonly string[],
  fi: number,
): boolean {
  // Both exhausted — match
  if (pi === pattern.length && fi === path.length) {
    return true
  }
  // Pattern exhausted but path remains — no match
  if (pi === pattern.length) {
    return false
  }

  const seg = pattern[pi]

  // ** (globstar) — match zero or more path segments
  if (seg === "**") {
    // Try consuming 0..N path segments
    for (let skip = fi; skip <= path.length; skip++) {
      if (matchSegments(pattern, pi + 1, path, skip)) {
        return true
      }
    }
    return false
  }

  // Path exhausted but pattern remains — no match (unless remaining is all **)
  if (fi === path.length) {
    return false
  }

  // * matches exactly one segment
  if (seg === "*") {
    return matchSegments(pattern, pi + 1, path, fi + 1)
  }

  // Intra-segment wildcard (e.g. 'db_*')
  if (seg.includes("*")) {
    const regex = new RegExp("^" + seg.replace(/\*/g, ".*") + "$")
    if (!regex.test(path[fi])) {
      return false
    }
    return matchSegments(pattern, pi + 1, path, fi + 1)
  }

  // Literal match
  if (seg !== path[fi]) {
    return false
  }
  return matchSegments(pattern, pi + 1, path, fi + 1)
}
