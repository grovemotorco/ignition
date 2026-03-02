/**
 * Host facts probe — gathers platform information from a remote host.
 *
 * Runs a small number of SSH commands after connectivity is verified to
 * detect OS family, package manager, init system, and architecture.
 * Results are cached on ExecutionContext for use by all resources.
 * See ISSUE-0032.
 */

import type { Transport } from "../ssh/types.ts"
import type { DistroFamily, HostFacts, InitSystem, PackageManager } from "./types.ts"
import { UNKNOWN_HOST_FACTS } from "./types.ts"

/**
 * Parse key=value pairs from /etc/os-release content.
 *
 * Handles both quoted and unquoted values. Returns a map of key → value.
 */
export function parseOsRelease(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    let value = trimmed.slice(eq + 1)
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result.set(key, value)
  }
  return result
}

/**
 * Derive the OS family from os-release ID and ID_LIKE fields.
 *
 * ID_LIKE is checked first (space-separated list of parent distros),
 * then ID is used as a fallback.
 */
export function classifyDistro(id: string, idLike: string): DistroFamily {
  // Check ID_LIKE first — it lists parent distros
  const candidates = idLike ? idLike.split(/\s+/).concat(id) : [id]
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    if (lower === "debian" || lower === "ubuntu") return "debian"
    if (lower === "rhel" || lower === "fedora" || lower === "centos") return "rhel"
    if (lower === "alpine") return "alpine"
  }
  return "unknown"
}

/**
 * Detect the first available package manager from command probe output.
 */
export function detectPkgManager(probeOutput: string): PackageManager {
  // The probe runs: command -v apt-get dnf yum apk
  // Each found binary prints its path on a separate line.
  const lines = probeOutput
    .trim()
    .split("\n")
    .filter((l) => l.trim())
  for (const line of lines) {
    const bin = line.trim().split("/").pop() ?? ""
    if (bin === "apt-get") return "apt"
    if (bin === "dnf") return "dnf"
    if (bin === "yum") return "yum"
    if (bin === "apk") return "apk"
  }
  return null
}

/**
 * Detect the init system from command probe output.
 */
export function detectInitSystem(probeOutput: string): InitSystem {
  const lines = probeOutput
    .trim()
    .split("\n")
    .filter((l) => l.trim())
  for (const line of lines) {
    const bin = line.trim().split("/").pop() ?? ""
    if (bin === "systemctl") return "systemd"
    if (bin === "openrc-init") return "openrc"
  }
  return null
}

/**
 * Probe a remote host for platform facts.
 *
 * Runs 3 SSH commands:
 * 1. `cat /etc/os-release` — parse ID, ID_LIKE, VERSION_ID
 * 2. `command -v apt-get dnf yum apk 2>/dev/null; uname -m` — package manager + arch
 * 3. `command -v systemctl openrc-init 2>/dev/null` — init system
 *
 * On any failure, returns graceful defaults (distro: 'unknown', etc.).
 */
export async function probeHostFacts(connection: Transport): Promise<HostFacts> {
  try {
    // Run all three probes concurrently
    const [osReleaseResult, toolchainResult, initResult] = await Promise.all([
      connection.exec("cat /etc/os-release 2>/dev/null || true"),
      connection.exec(
        "command -v apt-get 2>/dev/null; command -v dnf 2>/dev/null; command -v yum 2>/dev/null; command -v apk 2>/dev/null; uname -m",
      ),
      connection.exec(
        "command -v systemctl 2>/dev/null; command -v openrc-init 2>/dev/null || true",
      ),
    ])

    // Parse os-release
    const osRelease = parseOsRelease(osReleaseResult.stdout)
    const id = osRelease.get("ID") ?? ""
    const idLike = osRelease.get("ID_LIKE") ?? ""
    const versionId = osRelease.get("VERSION_ID") ?? ""

    // Classify distro family
    const distro = classifyDistro(id, idLike)

    // Parse toolchain output: last line is uname -m, preceding lines are command -v results
    const toolchainLines = toolchainResult.stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim())
    const arch = toolchainLines.length > 0 ? toolchainLines[toolchainLines.length - 1].trim() : ""

    // Package manager detection uses all lines except the last (arch)
    const pkgManagerOutput = toolchainLines.slice(0, -1).join("\n")
    const pkgManager = detectPkgManager(pkgManagerOutput)

    // Init system detection
    const initSystem = detectInitSystem(initResult.stdout)

    return {
      distro,
      distroId: id,
      distroVersion: versionId,
      pkgManager,
      initSystem,
      arch,
    }
  } catch {
    // Probe failure → graceful defaults
    return { ...UNKNOWN_HOST_FACTS }
  }
}
