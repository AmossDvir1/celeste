/** An async stream that something else pushes into: how an adapter hands its events to Core. */
export class EventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiting: ((r: IteratorResult<T>) => void) | null = null
  private closed = false

  push(value: T): void {
    if (this.closed) return
    if (this.waiting) {
      this.waiting({ value, done: false })
      this.waiting = null
    } else {
      this.buffer.push(value)
    }
  }
  close(): void {
    this.closed = true
    this.waiting?.({ value: undefined as never, done: true })
    this.waiting = null
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      }
    }
  }
}
