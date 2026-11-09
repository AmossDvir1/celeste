import { describe, expect, it } from 'vitest'
import { validateWorkflow, type WorkflowDefinition, type WorkflowNode } from './workflow'
import { makeStep } from './workflow-edit'
import { fromFile, toFile } from './workflow-file'

const start: WorkflowNode = { id: 'start', type: 'start', name: 'Start', inputs: [] }
const end: WorkflowNode = { id: 'end', type: 'end', name: 'End' }
const chain = (...nodes: WorkflowNode[]): WorkflowDefinition => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id })) })
const step = (computer: unknown): WorkflowNode => ({ id: 'open', type: 'agent', name: 'Open it', prompt: 'Open the friends list', computer } as WorkflowNode)

describe('a step that uses the computer', () => {
  it('is valid with the whole screen, one program or one window', () => {
    for (const c of [{}, { app: 'chrome' }, { window: 'Inbox - Mail' }]) expect(validateWorkflow(chain(start, step(c), end))).toEqual([])
  })

  it('is not valid with both a program and a window, with an empty one, or with something that is not text', () => {
    const problem = (c: unknown) => validateWorkflow(chain(start, step(c), end))[0]
    expect(problem({ app: 'chrome', window: 'Inbox' })).toContain('either a program or a window')
    expect(problem({ app: '  ' })).toContain('say which program or window')
    expect(problem({ window: '' })).toContain('say which program or window')
    expect(problem({ app: 5 })).toContain('must be text')
    expect(problem('yes')).toContain('not valid')
  })

  it('is made by “Use the computer”, which is an assistant step that may use the computer, with nothing filled in', () => {
    const made = makeStep({ type: 'agent', computer: true }, ['start', 'end'])
    expect(made).toMatchObject({ type: 'agent', name: 'Use the computer', prompt: '', computer: {} })
    expect(makeStep({ type: 'agent' }, [])).not.toHaveProperty('computer')
  })

  it('goes into a shared file and comes back, with only what is known and no empty text', () => {
    const def = chain(start, step({ app: ' chrome ', window: '' } as never), end)
    const { text } = toFile('W', '', def)
    expect(JSON.parse(text).definition.nodes[1].computer).toEqual({ app: 'chrome' })
    const back = fromFile(text)
    expect((back.definition.nodes[1] as { computer?: unknown }).computer).toEqual({ app: 'chrome' })
    // Whoever opens it is told, because it will ask to use their screen.
    expect(back.notes.join(' ')).toContain('uses the computer')
  })

  it('stays out of a file when the step does not use the computer', () => {
    const { text } = toFile('W', '', chain(start, { id: 'a', type: 'agent', name: 'A', prompt: 'x' }, end))
    expect(text).not.toContain('computer')
  })
})

describe('a step that uses the phone', () => {
  const phoneStep = (phone: unknown): WorkflowNode => ({ id: 'check', type: 'agent', name: 'Check it', prompt: 'Read my texts', phone } as WorkflowNode)

  it('is valid with an empty phone setting, and not with anything else', () => {
    expect(validateWorkflow(chain(start, phoneStep({}), end))).toEqual([])
    expect(validateWorkflow(chain(start, phoneStep('yes'), end))[0]).toContain('phone setting is not valid')
    expect(validateWorkflow(chain(start, phoneStep({ id: 'p1' }), end))[0]).toContain('phone setting is not valid')
  })

  it('is made by “Use the phone”, which is an assistant step that may use the phone, with nothing filled in', () => {
    expect(makeStep({ type: 'agent', phone: true }, ['start', 'end'])).toEqual({ id: 'use_the_phone', type: 'agent', name: 'Use the phone', prompt: '', phone: {} })
    expect(makeStep({ type: 'agent' }, [])).not.toHaveProperty('phone')
  })

  it('goes into a shared file and comes back, and whoever opens it is told it uses their phone', () => {
    const { text } = toFile('W', '', chain(start, phoneStep({}), end))
    expect(JSON.parse(text).definition.nodes[1].phone).toEqual({})
    const back = fromFile(text)
    expect((back.definition.nodes[1] as { phone?: unknown }).phone).toEqual({})
    expect(back.notes.join(' ')).toContain('uses your phone')
    expect(toFile('W', '', chain(start, { id: 'a', type: 'agent', name: 'A', prompt: 'x' }, end)).text).not.toContain('phone')
  })
})
