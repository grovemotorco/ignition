/**
 * CLI parsing utilities: EnumTypes, validators, and collection helpers.
 */

import { EnumType, ValidationError } from "@cliffy/command"
import type { ErrorMode } from "../core/types.ts"
import type { OutputFormat } from "./types.ts"
import type { HostKeyPolicy } from "../ssh/types.ts"

// ---------------------------------------------------------------------------
// EnumType instances (used by withRunCheckOptions and schema command)
// ---------------------------------------------------------------------------

export const OutputFormatType = new EnumType<OutputFormat>(["pretty", "json", "minimal"])
export const ErrorModeType = new EnumType<ErrorMode>(["fail-fast", "fail-at-end", "ignore"])
export const HostKeyPolicyType = new EnumType<HostKeyPolicy>(["strict", "accept-new", "off"])

export type SchemaFormat = "json" | "pretty" | "agent"
export const SchemaFormatType = new EnumType<SchemaFormat>(["json", "pretty", "agent"])

// ---------------------------------------------------------------------------
// Numeric validators
// ---------------------------------------------------------------------------

export function requirePositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`Invalid ${name} "${value}". Must be a positive integer.`)
  }
  return value
}

export function requireNonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`Invalid ${name} "${value}". Must be a non-negative integer.`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Tag and variable collection
// ---------------------------------------------------------------------------

export function collectTags(raw: string, previous: string[] = []): string[] {
  const parts = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (parts.length === 0) {
    throw new ValidationError("Tag cannot be empty.")
  }

  previous.push(...parts)
  return previous
}

export function parseVar(raw: string): [string, unknown] {
  const eqIdx = raw.indexOf("=")
  if (eqIdx === -1) {
    return [raw, true]
  }

  const key = raw.slice(0, eqIdx)
  const value = raw.slice(eqIdx + 1)

  if (value === "true") return [key, true]
  if (value === "false") return [key, false]

  const num = Number(value)
  if (!isNaN(num) && value.length > 0) return [key, num]

  return [key, value]
}

export function collectVarEntry(raw: string, previous: string[] = []): string[] {
  parseVar(raw)
  previous.push(raw)
  return previous
}

export function buildVarsRecord(entries: readonly string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const raw of entries) {
    const [key, value] = parseVar(raw)
    vars[key] = value
  }
  return vars
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

export function parseDashboardOption(value: string | true): string {
  return value === true ? "127.0.0.1:9090" : value
}

export function parseDashboardAddress(addr: string): [string, number] {
  let hostname = "127.0.0.1"
  let portStr: string

  if (addr.includes(":")) {
    const lastColon = addr.lastIndexOf(":")
    const host = addr.slice(0, lastColon)
    portStr = addr.slice(lastColon + 1)
    if (host.length > 0) hostname = host
  } else {
    portStr = addr
  }

  const port = Number(portStr)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid dashboard port "${portStr}". Must be an integer between 1 and 65535`)
  }

  return [hostname, port]
}

export function parseHistoryVar(varStrings: readonly string[]): number {
  for (const raw of varStrings) {
    const [key, value] = parseVar(raw)
    if (key !== "history") continue
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value
    }
  }
  return 10
}
