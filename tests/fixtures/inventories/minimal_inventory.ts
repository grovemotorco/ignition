/** A minimal inventory with a single standalone host. */
import type { Inventory } from "../../../src/inventory/types.ts"

export default {
  hosts: {
    "server-1": { hostname: "192.168.1.100" },
  },
} satisfies Inventory
