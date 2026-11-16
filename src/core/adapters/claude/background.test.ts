import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import { Translator } from './translate'

/*
 * Commands that go on after the turn. The messages below are what Claude Code's program really sent in the spike of 15 November 2026
 * (scripts/spikes/background-sdk.mjs): the tool call, the task starting in the background, the immediate tool result, the end of the
 * turn, and later the task's notification, with a turn of Claude's own after it.
 */

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage
const feed = (t: Translator, ...messages: Record<string, unknown>[]) => messages.flatMap((m) => t.handle(msg(m)))

const bashCall = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test', run_in_background: true, description: 'Run the tests' } }] } }
const started = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_1', description: 'Run the tests', task_type: 'local_bash', is_backgrounded: true }
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Command running in background with ID: b1.' }] } }
const result = { type: 'result', subtype: 'success', result: 'Started it.' }
const notified = (status: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_notification', task_id: 'b1', status, summary: 'Background command "Run the tests" completed (exit code 0)', output_file: 'x', ...extra })

function firstTurn(t: Translator): AgentEvent[] {
  return [t.begin('t1'), ...feed(t, bashCall, started, toolResult, result)]
}

describe('commands that go on after the turn', () => {
  it('shows a command started in the background, with what it runs', () => {
    const t = new Translator('/p')
    const events = firstTurn(t)
    expect(events.find((e) => e.type === 'background.started')).toEqual({ type: 'background.started', taskId: 'b1', title: 'Run the tests', command: 'npm test' })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed', turnId: 't1' })
  })

  it('begins a turn of its own when the command ends after the turn has ended, so what Claude says next is shown', () => {
    const t = new Translator('/p')
    firstTurn(t)
    const events = feed(t, notified('completed'))
    expect(events[0]).toMatchObject({ type: 'turn.started' })
    expect((events[0] as { turnId: string }).turnId).toMatch(/^bg-/)
    expect(events[1]).toEqual({ type: 'background.finished', taskId: 'b1', status: 'completed', summary: 'Background command "Run the tests" completed (exit code 0)' })
    // The follow-up that used to be dropped.
    const next = feed(t, { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'The tests passed.' }] } }, { type: 'result', subtype: 'success', result: 'The tests passed.' })
    expect(next.find((e) => e.type === 'message.delta')).toEqual({ type: 'message.delta', text: 'The tests passed.' })
    expect(next[next.length - 1]).toMatchObject({ type: 'turn.completed' })
  })

  it('does not begin a second turn when the command ends while a turn is running', () => {
    const t = new Translator('/p')
    firstTurn(t)
    t.begin('t2')
    const events = feed(t, notified('completed'))
    expect(events.map((e) => e.type)).toEqual(['background.finished'])
  })

  it('shows a command that failed or was stopped', () => {
    const t = new Translator('/p')
    firstTurn(t)
    expect(feed(t, notified('failed', { summary: 'Background command "Run the tests" failed with exit code 1' }))[1]).toMatchObject({ status: 'failed', summary: expect.stringContaining('exit code 1') })
    const u = new Translator('/p')
    firstTurn(u)
    // A stopped command is not followed by a turn of Claude's own: none is begun, so the chat is not left working.
    expect(feed(u, notified('stopped')).map((e) => e.type)).toEqual(['background.finished'])
  })

  it('shows nothing for a command that ran in the foreground, unless it is moved to the background', () => {
    const t = new Translator('/p')
    t.begin('t1')
    expect(feed(t, bashCall, { ...started, is_backgrounded: false })).toEqual([{ type: 'tool.started', id: 'toolu_1', kind: 'shell', title: 'Run the tests', input: expect.anything() }])
    // Moved with Ctrl+B or by the SDK's backgroundTasks().
    expect(feed(t, { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true } })).toEqual([{ type: 'background.started', taskId: 'b1', title: 'Run the tests', command: 'npm test' }])
    const quiet = new Translator('/p')
    quiet.begin('t1')
    feed(quiet, bashCall, { ...started, is_backgrounded: false })
    expect(feed(quiet, notified('completed'))).toEqual([])
  })

  it('ignores housekeeping tasks and helpers (a subagent is already its own tool call)', () => {
    const t = new Translator('/p')
    firstTurn(t)
    expect(feed(t, { type: 'system', subtype: 'task_started', task_id: 'w', description: 'watch', task_type: 'monitor', is_backgrounded: true, ambient: true })).toEqual([])
    expect(feed(t, { type: 'system', subtype: 'task_started', task_id: 'a', description: 'helper', task_type: 'local_agent', is_backgrounded: true })).toEqual([])
    expect(feed(t, { type: 'system', subtype: 'task_notification', task_id: 'w', status: 'completed', summary: 'x', ambient: true })).toEqual([])
  })

  it('makes a card from the end alone when the start was not seen, and does not wake the agent for it', () => {
    const t = new Translator('/p')
    firstTurn(t)
    const events = feed(t, { type: 'system', subtype: 'task_notification', task_id: 'z', status: 'completed', summary: 'Background command "old" completed (exit code 0)' })
    expect(events.map((e) => e.type)).toEqual(['background.finished'])
  })

  it('ends a turn that began on its own if Claude said nothing, and leaves one that went on', () => {
    const t = new Translator('/p')
    firstTurn(t)
    const turnId = (feed(t, notified('completed'))[0] as { turnId: string }).turnId
    expect(t.quietTurn(turnId)).toEqual([{ type: 'turn.completed', turnId }])
    expect(t.running).toBe(false)

    const u = new Translator('/p')
    firstTurn(u)
    const id = (feed(u, notified('completed'))[0] as { turnId: string }).turnId
    feed(u, { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'Done.' }] } })
    expect(u.quietTurn(id)).toEqual([])
    expect(u.running).toBe(true)
  })

  it('ends the cards of the commands when Claude\'s program ends', () => {
    const t = new Translator('/p')
    firstTurn(t)
    expect(t.endTasks()).toEqual([{ type: 'background.finished', taskId: 'b1', status: 'stopped', summary: 'The command stopped when Claude did.' }])
    expect(t.endTasks()).toEqual([])
  })

  it('leaves a turn that Celeste began alone', () => {
    const t = new Translator('/p')
    t.begin('t9')
    expect(t.quietTurn('t8')).toEqual([])
    expect(t.running).toBe(true)
  })
})
