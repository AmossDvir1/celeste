import { describe, expect, it } from 'vitest'
import { checkInputs, nodeIdFrom, referencesIn, renderTemplate, runOrder, slugify, validateWorkflow, type WorkflowDefinition, type WorkflowNode } from './workflow'

const start: WorkflowNode = { id: 'start', type: 'start', name: 'Start', inputs: [{ name: 'days', type: 'number', default: 30 }] }
const end: WorkflowNode = { id: 'end', type: 'end', name: 'End' }
const shell = (id: string, command = 'echo hi'): WorkflowNode => ({ id, type: 'tool', name: id, tool: { kind: 'shell', command } })
const chain = (...nodes: WorkflowNode[]): WorkflowDefinition => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id })) })

describe('which workflows are valid', () => {
  it('accepts a line of steps from Start to End', () => {
    expect(validateWorkflow(chain(start, shell('find', 'find --days {{inputs.days}}'), shell('clean', 'rm {{nodes.find.output}}'), end))).toEqual([])
    expect(validateWorkflow(chain({ ...start, inputs: [] }, end))).toEqual([])
  })

  it('says what is wrong in words, for the things people actually get wrong', () => {
    const problem = (v: unknown) => validateWorkflow(v)[0]
    expect(problem(null)).toContain('not a workflow')
    expect(problem({ nodes: [], edges: [] })).toBe('A workflow needs exactly one Start step.')
    expect(problem(chain(start, shell('a'), shell('a'), end))).toBe('Two steps have the id “a”.')
    expect(problem(chain(start, { ...shell('Bad id!'), id: 'Bad id!' }, end))).toContain('lowercase letters')
    expect(problem(chain(start, { id: 'x', type: 'tool', name: 'x', tool: { kind: 'shell', command: ' ' } }, end))).toContain('the command is empty')
    expect(problem(chain(start, { id: 'x', type: 'agent', name: 'x', prompt: '' }, end))).toContain('the prompt is empty')
    expect(problem(chain(start, { id: 'x', type: 'tool', name: 'x', tool: { kind: 'telepathy' } } as never, end))).toContain('not a kind of tool step')
    expect(problem(chain(start, { ...shell('x'), onError: 'panic' } as never, end))).toContain('not a way to handle errors')
    expect(problem(chain(start, { ...shell('x'), onError: 'retry', retries: 9 } as never, end))).toContain('retries must be')
    expect(problem(chain(start, { ...shell('x'), timeoutSec: 0 } as never, end))).toContain('time limit')
  })

  it('needs the steps to be one connected line that finishes at End', () => {
    const a = shell('a')
    const b = shell('b')
    expect(validateWorkflow({ nodes: [start, a, b, end], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }] })[0]).toContain('“b” is not connected')
    expect(validateWorkflow({ nodes: [start, a, b, end], edges: [{ from: 'start', to: 'a' }, { from: 'start', to: 'b' }, { from: 'a', to: 'end' }] })[0]).toContain('more than one step after')
    expect(validateWorkflow({ nodes: [start, a, b, end], edges: [{ from: 'start', to: 'a' }, { from: 'b', to: 'a' }, { from: 'a', to: 'end' }] })[0]).toContain('more than one step before')
    expect(validateWorkflow({ nodes: [start, a, end], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'ghost' }] })[0]).toContain('does not exist')
    expect(validateWorkflow({ nodes: [start, a, end], edges: [{ from: 'start', to: 'end' }, { from: 'end', to: 'a' }, { from: 'a', to: 'start' }] })[0]).toBeDefined()
    expect(validateWorkflow({ nodes: [start, a, end], edges: [{ from: 'start', to: 'end' }, { from: 'end', to: 'a' }] })[0]).toContain('must finish at the End')
  })

  it('only lets a step use the inputs, steps that run before it, and the run’s folder', () => {
    const uses = (text: string, order: WorkflowNode[] = [shell('a', text)]) => validateWorkflow(chain(start, ...order, end))[0]
    expect(uses('{{inputs.nope}}')).toContain('no input called “nope”')
    expect(uses('{{nodes.later.output}}', [shell('a', '{{nodes.later.output}}'), shell('later')])).toContain('does not run before it')
    expect(uses('{{nodes.a.output}}')).toContain('does not run before it')
    expect(uses('{{secrets.token}}')).toContain('not something a step can use')
    expect(uses('{{run.folder}} {{ inputs.days }}')).toBeUndefined()
  })

  it('has a limit on how many steps there can be', () => {
    const many = Array.from({ length: 70 }, (_, i) => shell(`s${i}`))
    expect(validateWorkflow(chain(start, ...many, end))[0]).toContain('at most 60')
  })
})

describe('the order steps run in', () => {
  it('follows the connections from Start, whatever order the steps are listed in', () => {
    const a = shell('a')
    const b = shell('b')
    const def: WorkflowDefinition = { nodes: [end, b, start, a], edges: [{ from: 'b', to: 'end' }, { from: 'a', to: 'b' }, { from: 'start', to: 'a' }] }
    const r = runOrder(def)
    expect('order' in r && r.order.map((n) => n.id)).toEqual(['start', 'a', 'b', 'end'])
  })
})

describe('templates', () => {
  const ctx = { inputs: { days: 30, who: 'Dana' }, nodes: { find: { output: '{"count":3,"names":["a","b"]}' }, plain: { output: 'text' } }, run: { folder: 'D:\\Work' } }

  it('fills in inputs, results and the folder', () => {
    expect(renderTemplate('{{inputs.who}} {{ inputs.days }} {{nodes.plain.output}} {{run.folder}}', ctx)).toBe('Dana 30 text D:\\Work')
  })
  it('reads fields of a result that is JSON', () => {
    expect(renderTemplate('{{nodes.find.output.count}} {{nodes.find.output.names}}', ctx)).toBe('3 ["a","b"]')
  })
  it('says what is missing instead of leaving a hole', () => {
    expect(() => renderTemplate('{{inputs.nope}}', ctx)).toThrow('no input called “nope”')
    expect(() => renderTemplate('{{nodes.ghost.output}}', ctx)).toThrow('has not produced anything')
    expect(() => renderTemplate('{{nodes.plain.output.x}}', ctx)).toThrow('did not produce JSON')
    expect(() => renderTemplate('{{nodes.find.output.missing}}', ctx)).toThrow('no field “missing”')
    expect(() => renderTemplate('{{nodes.find}}', ctx)).toThrow('Say {{nodes.find.output}}')
    expect(() => renderTemplate('{{whatever}}', ctx)).toThrow('not something a step can use')
  })
  it('can leave results of steps that have not run as they are written', () => {
    expect(renderTemplate('{{inputs.who}} {{nodes.find.output}}', { ...ctx, nodes: {} }, { partial: true })).toBe('Dana {{nodes.find.output}}')
  })
  it('lists the references in a text', () => {
    expect(referencesIn('a {{ inputs.x }} b {{nodes.y.output}} {not}')).toEqual(['inputs.x', 'nodes.y.output'])
  })
})

describe('the answers to the start questions', () => {
  const defs = [
    { name: 'env', type: 'choice' as const, options: ['staging', 'prod'], required: true },
    { name: 'days', type: 'number' as const, default: 7 },
    { name: 'dry', type: 'boolean' as const },
    { name: 'note', type: 'text' as const }
  ]
  it('uses defaults, makes the right types, and fills the rest with nothing', () => {
    expect(checkInputs(defs, { env: 'prod', days: '12', dry: 'yes' })).toEqual({ env: 'prod', days: 12, dry: true, note: '' })
    expect(checkInputs(defs, { env: 'staging' })).toEqual({ env: 'staging', days: 7, dry: false, note: '' })
  })
  it('refuses what cannot be right', () => {
    expect(() => checkInputs(defs, {})).toThrow('“env” is needed')
    expect(() => checkInputs(defs, { env: 'moon' })).toThrow('must be one of')
    expect(() => checkInputs(defs, { env: 'prod', days: 'x' })).toThrow('must be a number')
  })
})

describe('names', () => {
  it('makes ids and slugs from names', () => {
    expect(nodeIdFrom('Find old KBs')).toBe('find_old_kbs')
    expect(nodeIdFrom('Find old KBs', ['find_old_kbs'])).toBe('find_old_kbs_2')
    expect(nodeIdFrom('123 go')).toBe('go')
    expect(nodeIdFrom('???')).toBe('step')
    expect(slugify('Test the app!')).toBe('test-the-app')
  })
})
