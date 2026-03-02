import { test, expect } from "bun:test"
import {
  classifyDistro,
  detectInitSystem,
  detectPkgManager,
  parseOsRelease,
  probeHostFacts,
} from "../../src/core/facts.ts"
import { createMockSSH } from "../fixtures/mock_ssh.ts"
import type { ExecResult } from "../../src/ssh/types.ts"

// ---------------------------------------------------------------------------
// parseOsRelease
// ---------------------------------------------------------------------------

test("parseOsRelease() parses double-quoted values", () => {
  const input = `ID="ubuntu"\nVERSION_ID="22.04"\nID_LIKE="debian"\n`
  const result = parseOsRelease(input)
  expect(result.get("ID")).toEqual("ubuntu")
  expect(result.get("VERSION_ID")).toEqual("22.04")
  expect(result.get("ID_LIKE")).toEqual("debian")
})

test("parseOsRelease() parses single-quoted values", () => {
  const input = `ID='alpine'\nVERSION_ID='3.18'\n`
  const result = parseOsRelease(input)
  expect(result.get("ID")).toEqual("alpine")
  expect(result.get("VERSION_ID")).toEqual("3.18")
})

test("parseOsRelease() parses unquoted values", () => {
  const input = `ID=alpine\nVERSION_ID=3.18\n`
  const result = parseOsRelease(input)
  expect(result.get("ID")).toEqual("alpine")
  expect(result.get("VERSION_ID")).toEqual("3.18")
})

test("parseOsRelease() skips comments and blank lines", () => {
  const input = `# This is a comment\n\nID=ubuntu\n`
  const result = parseOsRelease(input)
  expect(result.size).toEqual(1)
  expect(result.get("ID")).toEqual("ubuntu")
})

test("parseOsRelease() returns empty map for empty input", () => {
  const result = parseOsRelease("")
  expect(result.size).toEqual(0)
})

// ---------------------------------------------------------------------------
// classifyDistro
// ---------------------------------------------------------------------------

test("classifyDistro() detects debian from ID", () => {
  expect(classifyDistro("debian", "")).toEqual("debian")
})

test("classifyDistro() detects debian from ubuntu ID", () => {
  expect(classifyDistro("ubuntu", "")).toEqual("debian")
})

test("classifyDistro() detects debian from ID_LIKE", () => {
  expect(classifyDistro("ubuntu", "debian")).toEqual("debian")
})

test("classifyDistro() detects rhel from ID_LIKE", () => {
  expect(classifyDistro("rocky", "rhel centos fedora")).toEqual("rhel")
})

test("classifyDistro() detects rhel from fedora ID", () => {
  expect(classifyDistro("fedora", "")).toEqual("rhel")
})

test("classifyDistro() detects rhel from centos ID", () => {
  expect(classifyDistro("centos", "")).toEqual("rhel")
})

test("classifyDistro() detects alpine from ID", () => {
  expect(classifyDistro("alpine", "")).toEqual("alpine")
})

test("classifyDistro() returns unknown for unrecognized distro", () => {
  expect(classifyDistro("nixos", "")).toEqual("unknown")
})

test("classifyDistro() prefers ID_LIKE over ID", () => {
  // A distro with unknown ID but known ID_LIKE should classify correctly
  expect(classifyDistro("linuxmint", "ubuntu debian")).toEqual("debian")
})

// ---------------------------------------------------------------------------
// detectPkgManager
// ---------------------------------------------------------------------------

test("detectPkgManager() detects apt-get", () => {
  expect(detectPkgManager("/usr/bin/apt-get\n")).toEqual("apt")
})

test("detectPkgManager() detects dnf", () => {
  expect(detectPkgManager("/usr/bin/dnf\n")).toEqual("dnf")
})

test("detectPkgManager() detects yum", () => {
  expect(detectPkgManager("/usr/bin/yum\n")).toEqual("yum")
})

test("detectPkgManager() detects apk", () => {
  expect(detectPkgManager("/sbin/apk\n")).toEqual("apk")
})

test("detectPkgManager() returns null for no matches", () => {
  expect(detectPkgManager("")).toEqual(null)
})

test("detectPkgManager() returns first match when multiple present", () => {
  expect(detectPkgManager("/usr/bin/apt-get\n/usr/bin/dnf\n")).toEqual("apt")
})

// ---------------------------------------------------------------------------
// detectInitSystem
// ---------------------------------------------------------------------------

test("detectInitSystem() detects systemd", () => {
  expect(detectInitSystem("/usr/bin/systemctl\n")).toEqual("systemd")
})

test("detectInitSystem() detects openrc", () => {
  expect(detectInitSystem("/sbin/openrc-init\n")).toEqual("openrc")
})

test("detectInitSystem() returns null for no matches", () => {
  expect(detectInitSystem("")).toEqual(null)
})

// ---------------------------------------------------------------------------
// probeHostFacts — Debian/Ubuntu
// ---------------------------------------------------------------------------

const UBUNTU_OS_RELEASE = `NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
VERSION_ID="22.04"
PRETTY_NAME="Ubuntu 22.04.3 LTS"
`

test("probeHostFacts() detects Ubuntu as debian family", async () => {
  const { connection } = createMockSSH({
    exec: (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("os-release")) {
        return Promise.resolve({ exitCode: 0, stdout: UBUNTU_OS_RELEASE, stderr: "" })
      }
      if (cmd.includes("command -v apt-get")) {
        return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/apt-get\nx86_64\n", stderr: "" })
      }
      if (cmd.includes("command -v systemctl")) {
        return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/systemctl\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("debian")
  expect(facts.distroId).toEqual("ubuntu")
  expect(facts.distroVersion).toEqual("22.04")
  expect(facts.pkgManager).toEqual("apt")
  expect(facts.initSystem).toEqual("systemd")
  expect(facts.arch).toEqual("x86_64")
})

// ---------------------------------------------------------------------------
// probeHostFacts — RHEL/Rocky
// ---------------------------------------------------------------------------

const ROCKY_OS_RELEASE = `NAME="Rocky Linux"
VERSION="9.2 (Blue Onyx)"
ID="rocky"
ID_LIKE="rhel centos fedora"
VERSION_ID="9.2"
PRETTY_NAME="Rocky Linux 9.2 (Blue Onyx)"
`

test("probeHostFacts() detects Rocky Linux as rhel family", async () => {
  const { connection } = createMockSSH({
    exec: (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("os-release")) {
        return Promise.resolve({ exitCode: 0, stdout: ROCKY_OS_RELEASE, stderr: "" })
      }
      if (cmd.includes("command -v apt-get")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: "/usr/bin/dnf\n/usr/bin/yum\naarch64\n",
          stderr: "",
        })
      }
      if (cmd.includes("command -v systemctl")) {
        return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/systemctl\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("rhel")
  expect(facts.distroId).toEqual("rocky")
  expect(facts.distroVersion).toEqual("9.2")
  expect(facts.pkgManager).toEqual("dnf")
  expect(facts.initSystem).toEqual("systemd")
  expect(facts.arch).toEqual("aarch64")
})

// ---------------------------------------------------------------------------
// probeHostFacts — Alpine
// ---------------------------------------------------------------------------

const ALPINE_OS_RELEASE = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.18.4
PRETTY_NAME="Alpine Linux v3.18"
`

test("probeHostFacts() detects Alpine Linux", async () => {
  const { connection } = createMockSSH({
    exec: (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("os-release")) {
        return Promise.resolve({ exitCode: 0, stdout: ALPINE_OS_RELEASE, stderr: "" })
      }
      if (cmd.includes("command -v apt-get")) {
        return Promise.resolve({ exitCode: 0, stdout: "/sbin/apk\nx86_64\n", stderr: "" })
      }
      if (cmd.includes("command -v systemctl")) {
        return Promise.resolve({ exitCode: 0, stdout: "/sbin/openrc-init\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("alpine")
  expect(facts.distroId).toEqual("alpine")
  expect(facts.distroVersion).toEqual("3.18.4")
  expect(facts.pkgManager).toEqual("apk")
  expect(facts.initSystem).toEqual("openrc")
  expect(facts.arch).toEqual("x86_64")
})

// ---------------------------------------------------------------------------
// probeHostFacts — Unknown OS
// ---------------------------------------------------------------------------

test("probeHostFacts() returns unknown for unrecognized OS", async () => {
  const { connection } = createMockSSH({
    exec: (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("os-release")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: 'ID=nixos\nVERSION_ID="23.11"\n',
          stderr: "",
        })
      }
      if (cmd.includes("command -v apt-get")) {
        return Promise.resolve({ exitCode: 0, stdout: "x86_64\n", stderr: "" })
      }
      if (cmd.includes("command -v systemctl")) {
        return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/systemctl\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("unknown")
  expect(facts.distroId).toEqual("nixos")
  expect(facts.distroVersion).toEqual("23.11")
  expect(facts.pkgManager).toEqual(null)
  expect(facts.initSystem).toEqual("systemd")
  expect(facts.arch).toEqual("x86_64")
})

// ---------------------------------------------------------------------------
// probeHostFacts — Graceful degradation
// ---------------------------------------------------------------------------

test("probeHostFacts() returns defaults when exec throws", async () => {
  const { connection } = createMockSSH({
    exec: (): Promise<ExecResult> => {
      throw new Error("connection refused")
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("unknown")
  expect(facts.distroId).toEqual("")
  expect(facts.distroVersion).toEqual("")
  expect(facts.pkgManager).toEqual(null)
  expect(facts.initSystem).toEqual(null)
  expect(facts.arch).toEqual("")
})

test("probeHostFacts() returns defaults when exec rejects", async () => {
  const { connection } = createMockSSH({
    exec: (): Promise<ExecResult> => {
      return Promise.reject(new Error("timeout"))
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("unknown")
  expect(facts.distroId).toEqual("")
  expect(facts.distroVersion).toEqual("")
  expect(facts.pkgManager).toEqual(null)
  expect(facts.initSystem).toEqual(null)
  expect(facts.arch).toEqual("")
})

test("probeHostFacts() handles empty os-release gracefully", async () => {
  const { connection } = createMockSSH({
    exec: (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("os-release")) {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" })
      }
      if (cmd.includes("command -v apt-get")) {
        return Promise.resolve({ exitCode: 0, stdout: "x86_64\n", stderr: "" })
      }
      if (cmd.includes("command -v systemctl")) {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  const facts = await probeHostFacts(connection)

  expect(facts.distro).toEqual("unknown")
  expect(facts.distroId).toEqual("")
  expect(facts.distroVersion).toEqual("")
  expect(facts.pkgManager).toEqual(null)
  expect(facts.initSystem).toEqual(null)
  expect(facts.arch).toEqual("x86_64")
})

// ---------------------------------------------------------------------------
// probeHostFacts — SSH command count
// ---------------------------------------------------------------------------

test("probeHostFacts() runs exactly 3 SSH commands", async () => {
  const { connection, calls } = createMockSSH({
    exec: (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("os-release")) {
        return Promise.resolve({ exitCode: 0, stdout: UBUNTU_OS_RELEASE, stderr: "" })
      }
      if (cmd.includes("uname")) {
        return Promise.resolve({ exitCode: 0, stdout: "x86_64\n", stderr: "" })
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    },
  })

  await probeHostFacts(connection)

  expect(calls.exec.length).toEqual(3)
})
