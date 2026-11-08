import { describe, expect, it } from 'vitest'
import { validateWorkflow, type WorkflowDefinition } from './workflow'
import { FILE_EXTENSION, fromFile, toFile } from './workflow-file'

const def = (): WorkflowDefinition => ({
  nodes: [
    { id: 'start', type: 'start', name: 'Start', inputs: [{ name: 'days', label: 'Days', type: 'number', default: 30, required: true }], position: { x: 5, y: 9 } },
    { id: 'ask', type: 'tool', name: 'Ask the API', tool: { kind: 'http', method: 'GET', url: 'https://api.test/x', headers: { Authorization: 'Bearer abc123', 'X-Api-Key': 'k-999', Accept: 'application/json', 'X-Token': '{{inputs.days}}' } }, onError: 'retry', retries: 2 },
    { id: 'remote', type: 'tool', name: 'Check the VM', tool: { kind: 'shell', command: 'uptime', deviceId: 'device-123' }, timeoutSec: 30 },
    { id: 'tools', type: 'tool', name: 'Call it', tool: { kind: 'mcp', server: 'KB tools', tool: 'find', args: { days: '{{inputs.days}}' } } },
    { id: 'think', type: 'agent', name: 'Think', prompt: 'Summarize {{nodes.ask.output}}', approval: 'ask', outputFormat: 'json' },
    { id: 'end', type: 'end', name: 'End', output: '{{nodes.think.output}}' }
  ],
  edges: [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'remote' }, { from: 'remote', to: 'tools' }, { from: 'tools', to: 'think' }, { from: 'think', to: 'end' }]
})

describe('sharing a workflow as a file', () => {
  it('names the file after the workflow, in the format, in running order, without positions', () => {
    const { text, filename } = toFile('Update old KBs', 'Does it.', def())
    expect(filename).toBe(`update-old-kbs${FILE_EXTENSION}`)
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({ format: 'celeste-workflow', version: 1, name: 'Update old KBs', description: 'Does it.' })
    expect(JSON.stringify(parsed.definition)).not.toContain('position')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('leaves out the value of a header that looks like a secret, and says so, but keeps the others and references', () => {
    const { text, notes } = toFile('W', '', def())
    const headers = JSON.parse(text).definition.nodes[1].tool.headers
    expect(headers).toEqual({ Authorization: '', 'X-Api-Key': '', Accept: 'application/json', 'X-Token': '{{inputs.days}}' })
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('k-999')
    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining('“Authorization” header'), expect.stringContaining('“X-Api-Key” header')]))
  })

  it('leaves out a device, which exists only on this computer, and says so', () => {
    const { text, notes } = toFile('W', '', def())
    expect(text).not.toContain('device-123')
    expect(notes.some((n) => n.includes('Check the VM') && n.includes('device'))).toBe(true)
  })

  it('does not change the workflow it was given', () => {
    const d = def()
    toFile('W', '', d)
    expect(JSON.stringify(d)).toContain('abc123')
    expect(JSON.stringify(d)).toContain('device-123')
  })
})

describe('opening a shared file', () => {
  const shared = () => toFile('Update old KBs', 'Does it.', def()).text

  it('gives back a valid workflow laid out in a row, ready to open as a draft', () => {
    const r = fromFile(shared())
    expect(r.name).toBe('Update old KBs')
    expect(validateWorkflow(r.definition)).toEqual([])
    expect(r.definition.nodes.map((n) => n.position?.x)).toEqual([0, 270, 540, 810, 1080, 1350])
  })

  it('says what will not work here: a header that needs its value, and tools that are not in the person’s list', () => {
    const r = fromFile(shared(), { mcpServers: ['other tools'] })
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining('needs a value for its “Authorization” header'), expect.stringContaining('“KB tools”, which are not in your tools')]))
    expect(fromFile(shared(), { mcpServers: ['kb TOOLS'] }).notes.some((n) => n.includes('not in your tools'))).toBe(false)
    expect(fromFile(shared()).notes.some((n) => n.includes('not in your tools'))).toBe(false)
  })

  it('takes a device out of a file that names one', () => {
    const hand = JSON.parse(shared())
    hand.definition.nodes[2].tool.deviceId = 'someone-elses-device'
    const r = fromFile(JSON.stringify(hand))
    expect(JSON.stringify(r.definition)).not.toContain('someone-elses-device')
    expect(r.notes.some((n) => n.includes('named a device'))).toBe(true)
  })

  it('keeps only the fields it knows, so a hand-edited file cannot carry anything else in', () => {
    const hand = JSON.parse(shared())
    hand.definition.nodes[1].evil = 'x'
    hand.definition.nodes[1].tool.extra = 'y'
    hand.extra = 'z'
    const r = fromFile(JSON.stringify(hand))
    expect(JSON.stringify(r)).not.toMatch(/evil|extra/)
  })

  it('refuses what is not a workflow file, in words', () => {
    expect(() => fromFile('not json')).toThrow('not JSON')
    expect(() => fromFile('[]')).toThrow('not a Celeste workflow file')
    expect(() => fromFile('{"format":"something-else"}')).toThrow('not a Celeste workflow file')
    expect(() => fromFile(JSON.stringify({ format: 'celeste-workflow', version: 99, name: 'x', definition: {} }))).toThrow('newer Celeste')
    expect(() => fromFile(JSON.stringify({ format: 'celeste-workflow', version: 1, name: ' ', definition: def() }))).toThrow('no name')
    expect(() => fromFile('x'.repeat(1_100_000))).toThrow('too large')
  })

  it('refuses steps that are not valid, with the reasons', () => {
    const hand = JSON.parse(shared())
    hand.definition.nodes[2].tool.command = ''
    hand.definition.nodes[4].prompt = 'Use {{nodes.nope.output}}'
    expect(() => fromFile(JSON.stringify(hand))).toThrow(/cannot be used: .*command is empty/)
  })

  it('round-trips: what is shared is what is opened, apart from what was left out', () => {
    const r = fromFile(shared())
    const again = fromFile(toFile(r.name, r.description, r.definition).text)
    expect(JSON.stringify(again.definition)).toBe(JSON.stringify(r.definition))
  })
})
