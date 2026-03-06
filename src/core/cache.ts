/**
 * Optional check result cache — non-authoritative, TTL-based.
 *
 * Stores previous `check()` outputs to reduce repeated SSH work on stable hosts
 * in check mode. Apply mode always performs a live check; cache is advisory for
 * check mode only.
 */

import type { CacheLookup, CheckResult, CheckResultCache } from "./types.ts"
import { dirname, join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

/** Default TTL for cache entries: 10 minutes. */
export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000
/** Default on-disk cache file path (workspace-local). */
export const DEFAULT_CACHE_FILE = join(process.cwd(), ".ignition", "check-cache.json")

/** Tool version included in cache keys to invalidate on upgrade. */
const CACHE_VERSION = "0.1.0"

// ---------------------------------------------------------------------------
// Cache Key
// ---------------------------------------------------------------------------

/** Components used to build a cache key. */
export type CacheKeyParts = {
  /** SSH hostname or IP. */
  hostname: string
  /** SSH port. */
  port: number
  /** SSH user. */
  user: string
  /** Resource type identifier. */
  resourceType: string
  /** Resource display name. */
  resourceName: string
  /** Normalized resource input (JSON-serialized). */
  inputJson: string
}

/**
 * Build a deterministic cache key string from the component parts.
 *
 * Key includes tool version so that cache entries are automatically
 * invalidated when the tool is upgraded.
 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return [
    CACHE_VERSION,
    parts.hostname,
    String(parts.port),
    parts.user,
    parts.resourceType,
    parts.resourceName,
    parts.inputJson,
  ].join("\0")
}

// ---------------------------------------------------------------------------
// Cache Entry
// ---------------------------------------------------------------------------

/** A stored cache entry with metadata. */
export type CacheEntry = {
  /** The cached check result. */
  result: CheckResult<unknown>
  /** Timestamp when the entry was stored (ms since epoch). */
  storedAt: number
  /** Cache key for this entry. */
  key: string
}

/** Configuration for the cache. */
export type CacheOptions = {
  /** TTL in milliseconds. Entries older than this are considered expired. */
  ttlMs: number
}

// ---------------------------------------------------------------------------
// In-memory cache backend
// ---------------------------------------------------------------------------

/**
 * In-memory check result cache with TTL-based expiration.
 *
 * Entries are stored in a Map keyed by the cache key string. Expired entries
 * are lazily evicted on access. This is the primary cache backend — filesystem
 * persistence can be layered on top if needed.
 */
export class MemoryCheckResultCache implements CheckResultCache {
  #entries = new Map<string, CacheEntry>()
  #ttlMs: number

  constructor(opts: Partial<CacheOptions> = {}) {
    this.#ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS
  }

  get(key: string): CacheLookup {
    const entry = this.#entries.get(key)
    if (!entry) {
      return { hit: false }
    }

    const ageMs = Date.now() - entry.storedAt
    if (ageMs > this.#ttlMs) {
      this.#entries.delete(key)
      return { hit: false }
    }

    return { hit: true, result: entry.result, ageMs }
  }

  set(key: string, result: CheckResult<unknown>): void {
    this.#entries.set(key, {
      result,
      storedAt: Date.now(),
      key,
    })
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    // Count only non-expired entries
    const now = Date.now()
    let count = 0
    for (const entry of this.#entries.values()) {
      if (now - entry.storedAt <= this.#ttlMs) {
        count++
      }
    }
    return count
  }
}

// ---------------------------------------------------------------------------
// Filesystem cache backend
// ---------------------------------------------------------------------------

/** Configuration for file-backed cache. */
export type FileCacheOptions = CacheOptions & {
  /** Absolute or relative path to the JSON cache file. */
  path: string
}

type SerializedCacheFile = {
  version: string
  entries: CacheEntry[]
}

/**
 * File-backed check result cache with in-memory working set + JSON persistence.
 *
 * The cache file is loaded at construction and rewritten on every mutation.
 * Entries are non-authoritative and TTL-validated exactly like memory cache.
 */
export class FileCheckResultCache implements CheckResultCache {
  #entries = new Map<string, CacheEntry>()
  #ttlMs: number
  #path: string

  constructor(opts: Partial<FileCacheOptions> = {}) {
    this.#ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS
    this.#path = opts.path ?? DEFAULT_CACHE_FILE
    this.#load()
  }

  get(key: string): CacheLookup {
    const entry = this.#entries.get(key)
    if (!entry) {
      return { hit: false }
    }

    const ageMs = Date.now() - entry.storedAt
    if (ageMs > this.#ttlMs) {
      this.#entries.delete(key)
      this.#persist()
      return { hit: false }
    }

    return { hit: true, result: entry.result, ageMs }
  }

  set(key: string, result: CheckResult<unknown>): void {
    this.#entries.set(key, {
      result,
      storedAt: Date.now(),
      key,
    })
    this.#persist()
  }

  clear(): void {
    this.#entries.clear()
    this.#persist()
  }

  get size(): number {
    const now = Date.now()
    let count = 0
    for (const entry of this.#entries.values()) {
      if (now - entry.storedAt <= this.#ttlMs) {
        count++
      }
    }
    return count
  }

  #load(): void {
    try {
      const raw = readFileSync(this.#path, "utf-8")
      const parsed = JSON.parse(raw) as SerializedCacheFile
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
        return
      }
      const now = Date.now()
      for (const entry of parsed.entries) {
        // Drop expired entries during load.
        if (now - entry.storedAt <= this.#ttlMs) {
          this.#entries.set(entry.key, entry)
        }
      }
    } catch {
      // Cache file is optional: ignore missing/corrupt content.
    }
  }

  #persist(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const payload: SerializedCacheFile = {
        version: CACHE_VERSION,
        entries: [...this.#entries.values()],
      }
      writeFileSync(this.#path, JSON.stringify(payload))
    } catch {
      // Persistence is best-effort; cache remains non-authoritative.
    }
  }
}
