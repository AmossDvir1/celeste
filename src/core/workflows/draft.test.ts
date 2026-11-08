import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '@shared/workflow'
import { definitionFromSpec, draftWorkflow, jsonIn } from './draft'

const good = {
  name: 'Update old KBs',
  description: 'Finds old KBs and installs the newest.',
  inputs: [{ name: 'days', label: 'Older than (days)', type: 'number', default: 365 }],
  steps: [
    { id: 'find', name: 'Find old KBs', do: 'command', command: 'find-kbs --days {{inputs.days}}' },
    { id: 'summary', name: 'Summarize', do: 'assistant', prompt: 'Summarize: {{nodes.find.output}}', json: true },
    { id: 'save', name: 'Save it', do: 'file', op: 'write', path: 'summary.txt', content: '{{nodes.summary.output}}', onError: 'retry' }
  ],
  result: '{{nodes.summary.output}}'
}

describe('reading an assistant’s description of a workflow', () => {
  it('finds the JSON in an answer that has a fence or a sentence around it', () => {
    expect(jsonIn('{"a":1}')).toEqual({ a: 1 })
    expect(jsonIn('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(jsonIn('Here you go:\n{"a":{"b":2}}\nHope that helps.')).toEqual({ a: { b: 2 } })
    expect(() => jsonIn('no json here')).toThrow('no JSON')
    expect(() => jsonIn('{"a": }')).toThrow('not valid JSON')
  })

  it('makes a valid workflow from steps of every kind, in order, with Start and End added', () => {
    const made = definitionFromSpec({
      ...good,
      steps: [
        ...good.steps,
        { name: 'Call the API', do: 'web', method: 'post', url: 'https://api.test/x', headers: { Accept: 'application/json' }, body: '{}' },
        { name: 'Use a tool', do: 'tool', server: 'KB tools', tool: 'find', args: { days: '{{inputs.days}}', n: 3, bad: { nested: 1 } } }
      ]
    })
    expect(made.name).toBe('Update old KBs')
    expect(made.definition.nodes.map((n) => n.id)).toEqual(['start', 'find', 'summary', 'save', 'call_the_api', 'use_a_tool', 'end'])
    expect(validateWorkflow(made.definition)).toEqual([])
    const save = made.definition.nodes[3]
    expect(save).toMatchObject({ onError: 'retry', retries: 2 })
    expect(made.definition.nodes[4]).toMatchObject({ tool: { kind: 'http', method: 'POST' } })
    expect(made.definition.nodes[5]).toMatchObject({ tool: { kind: 'mcp', args: { days: '{{inputs.days}}', n: 3 } } })
    expect(made.definition.nodes[2]).toMatchObject({ type: 'agent', outputFormat: 'json' })
    expect(made.definition.nodes[6]).toMatchObject({ output: '{{nodes.summary.output}}' })
  })

  it('gives a step an id of its own when the one it came with is missing, used already or not valid', () => {
    const made = definitionFromSpec({ steps: [{ id: 'a', name: 'First', do: 'command', command: 'x' }, { id: 'a', name: 'Second', do: 'command', command: 'y' }, { id: 'Bad Id', name: 'Third', do: 'command', command: 'z' }, { name: 'Fourth', do: 'command', command: 'w' }] })
    expect(made.definition.nodes.map((n) => n.id)).toEqual(['start', 'a', 'second', 'third', 'fourth', 'end'])
  })

  it('says what is wrong with an answer that cannot be used', () => {
    expect(() => definitionFromSpec('x')).toThrow('not a JSON object')
    expect(() => definitionFromSpec({ steps: [] })).toThrow('no steps')
    expect(() => definitionFromSpec({ steps: [{ name: 'Odd', do: 'telepathy' }] })).toThrow('“Odd” says to do “telepathy”')
  })
})

describe('building a workflow with an assistant', () => {
  const tools = async () => ['KB tools']

  it('asks with the guide and what the person wants, and returns a draft that is valid', async () => {
    const asked: string[] = []
    const out = await draftWorkflow({ kind: 'text', text: 'Update the old KBs on the canary hosts' }, { tools, ask: async (p) => (asked.push(p), JSON.stringify(good)) })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Make a workflow for this:\n\nUpdate the old KBs on the canary hosts')
    expect(asked[0]).toContain('{{nodes.step_id.output}}')
    expect(asked[0]).toContain('KB tools')
    expect(out.name).toBe('Update old KBs')
    expect(validateWorkflow(out.definition)).toEqual([])
    expect(out.definition.nodes.map((n) => n.position?.x)).toEqual([0, 270, 540, 810, 1080])
  })

  it('shows the conversation when the workflow is made from one', async () => {
    const asked: string[] = []
    await draftWorkflow({ kind: 'conversation', transcript: 'User: free some disk\n\nAssistant: Done.' }, { tools, ask: async (p) => (asked.push(p), JSON.stringify(good)) })
    expect(asked[0]).toContain('--- conversation ---\nUser: free some disk')
  })

  it('sends an answer back once, with what is wrong, and uses the corrected one', async () => {
    const asked: string[] = []
    const bad = { ...good, steps: [{ id: 'a', name: 'Uses a ghost', do: 'command', command: 'echo {{nodes.ghost.output}}' }] }
    const out = await draftWorkflow({ kind: 'text', text: 'x' }, { tools, ask: async (p) => (asked.push(p), asked.length === 1 ? JSON.stringify(bad) : JSON.stringify(good)) })
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('Your last answer could not be used:')
    expect(asked[1]).toContain('does not run before it')
    expect(out.name).toBe('Update old KBs')
  })

  it('gives up after two tries, and says why', async () => {
    let asks = 0
    await expect(draftWorkflow({ kind: 'text', text: 'x' }, { tools, ask: async () => (asks++, 'Sorry, I cannot do that.') })).rejects.toThrow('could not make a workflow that works. The answer had no JSON')
    expect(asks).toBe(2)
  })

  it('says which of its tools the person does not have yet', async () => {
    const withTool = { ...good, result: '', steps: [{ id: 't', name: 'Tool', do: 'tool', server: 'Missing tools', tool: 'x', args: {} }] }
    const out = await draftWorkflow({ kind: 'text', text: 'x' }, { tools, ask: async () => JSON.stringify(withTool) })
    expect(out.notes.some((n) => n.includes('“Missing tools”, which are not in your tools'))).toBe(true)
  })

  it('does not fail just because the tools could not be listed', async () => {
    const out = await draftWorkflow({ kind: 'text', text: 'x' }, { tools: async () => Promise.reject(new Error('no')), ask: async () => JSON.stringify(good) })
    expect(out.name).toBe('Update old KBs')
  })
})
