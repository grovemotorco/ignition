/**
 * Parse a dashboard address string ("host:port" or just "port") into
 * a [hostname, port] tuple.
 */
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
