import { setSystemTime } from "bun:test"

export class FakeTime {
  #now: number

  constructor(nowMs: number = Date.now()) {
    this.#now = nowMs
    setSystemTime(this.#now)
  }

  tick(ms: number): void {
    this.#now += ms
    setSystemTime(this.#now)
  }

  [Symbol.dispose](): void {
    setSystemTime()
  }
}
