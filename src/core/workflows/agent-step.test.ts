import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import type { AdapterFactory } from '../adapters/types'
import { createAgentStepRunner } from './agent-step'

/** A session that says its answer and finishes, or fails, or stops. */
function fakeAdapter(events: AgentEvent[], seen: { sessionId?: string; closed: boolean } = { closed: false }): AdapterFactory {
  return ((ctx: { sessionId: string }) => {
    seen.sessionId = ctx.sessionId
    return {
      vendorSessionId: 'v1',
      events: (async function* () {
        for (const e of events) yield e
      })(),
      send: () => undefined,
      respond: () => undefined,
      setModel: async () => undefined,
      setApprovalMode: async () => undefined,
      interrupt: async () => undefined,
      close: async () => {
        seen.closed = true
      }
    }
  }) as unknown as AdapterFactory
}

const request = () => ({ prompt: 'go', approval: 'ask' as const, cwd: '.', signal: new AbortController().signal, askApproval: async () => true, askQuestions: async () => ({}), vendor: 'claude' as const, model: 'claude:default' })
const done: AgentEvent[] = [{ type: 'message.delta', text: 'It is open.' } as AgentEvent, { type: 'turn.completed' } as AgentEvent]

describe('a step’s session and desktop control', () => {
  it('is registered with the way to ask the person in the run while it works, and let go of after', async () => {
    const calls: string[] = []
    const seen = { sessionId: undefined as string | undefined, closed: false }
    const runner = createAgentStepRunner({
      adapter: fakeAdapter(done, seen),
      defaults: async () => ({ vendor: 'claude', model: 'claude:default' }),
      desktop: {
        register: (id, ask, label) => {
          calls.push(`register ${id.startsWith('wf-')} ${label}`)
          expect(typeof ask).toBe('function')
        },
        unregister: (id) => calls.push(`unregister ${id === seen.sessionId}`)
      }
    })
    expect(await runner.run({ ...request(), label: 'Morning: Check the phone' })).toBe('It is open.')
    expect(calls).toEqual(['register true Morning: Check the phone', 'unregister true'])
    expect(seen.closed).toBe(true)
  })

  it('is let go of when the step fails too, so control ends with it', async () => {
    const calls: string[] = []
    const runner = createAgentStepRunner({
      adapter: fakeAdapter([{ type: 'turn.failed', error: { message: 'no' } } as AgentEvent]),
      defaults: async () => ({ vendor: 'claude', model: 'claude:default' }),
      desktop: { register: () => calls.push('register'), unregister: () => calls.push('unregister') }
    })
    await expect(runner.run(request())).rejects.toThrow('no')
    expect(calls).toEqual(['register', 'unregister'])
  })

  it('works as before when there is no desktop control to tell', async () => {
    const runner = createAgentStepRunner({ adapter: fakeAdapter(done), defaults: async () => ({ vendor: 'claude', model: 'claude:default' }) })
    expect(await runner.run(request())).toBe('It is open.')
  })
})
