import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@shared/workflow'
import { MemoryStore } from '../testing/memory-store'
import { WorkflowRunner } from './runner'
import { WorkflowTools } from './tools'

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'celeste-wft-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const start = (inputs: { name: string; type?: 'text' | 'number' | 'choice'; required?: boolean; default?: string | number; options?: string[] }[] = []): WorkflowNode => ({ id: 'start', type: 'start', name: 'Start', inputs: inputs.map((i) => ({ type: 'text' as const, ...i })) })
const def = (inputs: Parameters<typeof start>[0], output: string): WorkflowDefinition => ({
  nodes: [start(inputs), { id: 'write', type: 'tool', name: 'Write', tool: { kind: 'file', op: 'write', path: 'x.txt', content: output } }, { id: 'end', type: 'end', name: 'End', output }],
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }]
})

function setup() {
  const store = new MemoryStore()
  const runner = new WorkflowRunner({ store, push: () => undefined, pause: async () => undefined, agent: { run: async () => 'x' }, mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) } })
  const tools = new WorkflowTools(store, runner, () => folder, 3000)
  const save = (id: string, name: string, allow: boolean, definition = def([], 'hello')) =>
    store.saveWorkflow({ id, name, description: `${name} does a thing`, version: 1, allowAssistant: allow, definition, createdAt: 1, updatedAt: 1 })
  /** Answers the card every run shows first, the way the person would. */
  const answer = async (allow: boolean) => {
    for (let i = 0; i < 300; i++) {
      for (const run of store.listRuns(undefined, 10)) {
        const card = store.runEvents(run.id).find((e) => e.event.type === 'approval.requested')
        if (card?.event.type === 'approval.requested' && run.status === 'waiting') return runner.respondApproval(run.id, card.event.requestId, allow)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('No card was shown')
  }
  return { store, runner, tools, save, answer }
}

describe('the workflows an assistant may run', () => {
  it('are two tools, one that only looks', () => {
    const { tools } = setup()
    expect(tools.list().map((t) => [t.name, t.readOnly])).toEqual([['workflows_list', true], ['workflow_run', false]])
  })

  it('lists only the workflows the person allowed, with their inputs', async () => {
    const { tools, save } = setup()
    expect((await tools.call('s1', 'workflows_list', {})).text).toContain('There is no workflow you may run')
    save('w1', 'Test the app', true, def([{ name: 'env', type: 'choice', options: ['staging', 'prod'], required: true }, { name: 'days', type: 'number', default: 30 }], 'x'))
    save('w2', 'Secret', false)
    const text = (await tools.call('s1', 'workflows_list', {})).text
    expect(text).toContain('Test the app (/test-the-app): Test the app does a thing. Inputs: env (one of staging, prod, required); days (number, default 30).')
    expect(text).not.toContain('Secret')
  })

  it('runs one after the person allows the card, and gives back what it produced', async () => {
    const { tools, save, answer } = setup()
    save('w1', 'Greet', true, def([{ name: 'who', default: 'world' }], 'Hello {{inputs.who}}'))
    const pending = tools.call('s1', 'workflow_run', { name: 'greet', inputs: { who: 'Dana' } })
    await answer(true)
    expect(await pending).toEqual({ text: 'Hello Dana', isError: false })
  })

  it('shows the card first even for a run that only reads, and starts nothing when it is refused', async () => {
    const { tools, store, save, answer } = setup()
    save('w1', 'Reader', true, { nodes: [start(), { id: 'end', type: 'end', name: 'End', output: 'nothing to do' }], edges: [{ from: 'start', to: 'end' }] })
    const pending = tools.call('s1', 'workflow_run', { name: 'Reader' })
    await answer(false)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('did not allow')
    const run = store.listRuns(undefined, 1)[0]
    expect(run).toMatchObject({ startedBy: 'assistant', sessionId: 's1', folder, status: 'cancelled' })
    expect(store.runEvents(run?.id as string)[1]?.event).toMatchObject({ type: 'approval.requested', actions: [] })
  })

  it('refuses a workflow that is not allowed, one that does not exist, and wrong inputs, with the reason', async () => {
    const { tools, save } = setup()
    save('w1', 'Closed', false)
    save('w2', 'Open', true, def([{ name: 'n', type: 'number', required: true }], 'x'))
    expect(await tools.call('s1', 'workflow_run', { name: 'Closed' })).toMatchObject({ isError: true, text: expect.stringContaining('not one you may run') })
    expect(await tools.call('s1', 'workflow_run', { name: 'Nothing' })).toMatchObject({ isError: true, text: expect.stringContaining('no workflow called') })
    expect(await tools.call('s1', 'workflow_run', { name: 'Open' })).toMatchObject({ isError: true, text: expect.stringContaining('“n” is needed') })
    expect(await tools.call('s1', 'workflow_run', {})).toMatchObject({ isError: true, text: expect.stringContaining('Invalid arguments') })
    expect(await tools.call('s1', 'nope', {})).toMatchObject({ isError: true })
  })

  it('reports a failed run, and says when it is still going after a long wait', async () => {
    const { tools, save, answer } = setup()
    save('w1', 'Breaks', true, { nodes: [start(), { id: 'bad', type: 'tool', name: 'Bad', tool: { kind: 'file', op: 'read', path: 'missing.txt' } }, { id: 'end', type: 'end', name: 'End' }], edges: [{ from: 'start', to: 'bad' }, { from: 'bad', to: 'end' }] })
    const failing = tools.call('s1', 'workflow_run', { name: 'Breaks' })
    await answer(true)
    expect(await failing).toMatchObject({ isError: true, text: expect.stringContaining('The workflow failed') })

    save('w2', 'Slow', true)
    const waiting = new WorkflowTools(tools['store'] as MemoryStore, tools['runner'] as WorkflowRunner, () => folder, 50)
    const slow = await waiting.call('s2', 'workflow_run', { name: 'Slow' })
    expect(slow).toMatchObject({ isError: false, text: expect.stringContaining('still running') })
  })
})
