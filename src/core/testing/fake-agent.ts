import type { AgentEvent, AgentSession, ApprovalAnswer, AskAnswers, UserInput } from '@shared/agent'

/** A scripted agent that a test drives by hand: it says nothing until the test emits its events. */
export class FakeAgent implements AgentSession {
  readonly vendorSessionId = 'fake'
  readonly sent: UserInput[] = []
  readonly responses: [string, unknown][] = []
  interrupted = 0
  closed = false
  private buffer: AgentEvent[] = []
  private waiting: ((r: IteratorResult<AgentEvent>) => void) | null = null

  readonly events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift() as AgentEvent, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      }
    })
  }

  emit(e: AgentEvent): void {
    if (this.waiting) {
      this.waiting({ value: e, done: false })
      this.waiting = null
    } else this.buffer.push(e)
  }
  send(input: UserInput): void {
    this.sent.push(input)
  }
  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void {
    this.responses.push([requestId, answer])
  }
  async setModel(): Promise<void> {}
  async setApprovalMode(): Promise<void> {}
  async interrupt(): Promise<void> {
    this.interrupted++
  }
  async close(): Promise<void> {
    this.closed = true
    this.waiting?.({ value: undefined as never, done: true })
  }
}
