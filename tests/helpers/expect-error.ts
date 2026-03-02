import { expect } from "bun:test"

type ErrorClass<T extends Error = Error> = new (...args: any[]) => T

export async function expectRejection<T extends Error>(
  fn: () => Promise<unknown>,
  ErrorType?: ErrorClass<T>,
): Promise<T> {
  try {
    await fn()
  } catch (error) {
    if (ErrorType) expect(error).toBeInstanceOf(ErrorType)
    return error as T
  }
  throw new Error("Expected function to reject")
}
