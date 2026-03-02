/** A valid recipe with default export and meta. */
export const meta = {
  description: "Install and configure nginx",
  tags: ["web", "nginx"] as const,
}

export default async function (_ctx: unknown): Promise<void> {
  // no-op recipe for testing
}
