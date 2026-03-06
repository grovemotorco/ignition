import { test, expect } from "bun:test"
import { parseDashboardAddress } from "../../src/lib/parsers.ts"

test("parseDashboardAddress parses host:port", () => {
  const [hostname, port] = parseDashboardAddress("0.0.0.0:9090")

  expect(hostname).toEqual("0.0.0.0")
  expect(port).toEqual(9090)
})

test("parseDashboardAddress parses :port with default hostname", () => {
  const [hostname, port] = parseDashboardAddress(":8080")

  expect(hostname).toEqual("127.0.0.1")
  expect(port).toEqual(8080)
})

test("parseDashboardAddress parses bare port with default hostname", () => {
  const [hostname, port] = parseDashboardAddress("3000")

  expect(hostname).toEqual("127.0.0.1")
  expect(port).toEqual(3000)
})

test("parseDashboardAddress rejects port 0", () => {
  expect(() => parseDashboardAddress("0")).toThrow("Invalid dashboard port")
})

test("parseDashboardAddress rejects out-of-range port", () => {
  expect(() => parseDashboardAddress("70000")).toThrow("Invalid dashboard port")
})

test("parseDashboardAddress rejects non-numeric port", () => {
  expect(() => parseDashboardAddress("abc")).toThrow("Invalid dashboard port")
})
