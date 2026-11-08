import { describe, expect, it } from 'vitest'
import { emptyDefinition, validateWorkflow, type WorkflowNode } from './workflow'
import { insertStep, makeStep, moveStep, orderedNodes, referencesAvailable, removeStep, renameStep, updateStep } from './workflow-edit'

const ids = (def: ReturnType<typeof emptyDefinition>) => orderedNodes(def).map((n) => n.id)
const shell = (id: string, command = 'echo'): WorkflowNode => ({ id, type: 'tool', name: id, tool: { kind: 'shell', command } })

describe('editing the line of steps', () => {
  it('starts with Start and End joined', () => {
    expect(ids(emptyDefinition())).toEqual(['start', 'end'])
    expect(validateWorkflow(emptyDefinition())).toEqual([])
  })

  it('puts a new step before End by default, or after the step named, joining the connections and laying them in a row', () => {
    let def = insertStep(emptyDefinition(), shell('a'))
    def = insertStep(def, shell('b'))
    def = insertStep(def, shell('c'), 'a')
    expect(ids(def)).toEqual(['start', 'a', 'c', 'b', 'end'])
    expect(def.edges).toEqual([
      { from: 'start', to: 'a' },
      { from: 'a', to: 'c' },
      { from: 'c', to: 'b' },
      { from: 'b', to: 'end' }
    ])
    expect(def.nodes.map((n) => n.position?.x)).toEqual([0, 270, 540, 810, 1080])
    expect(validateWorkflow(def)).toEqual([])
  })

  it('does not put anything after End or before Start', () => {
    expect(ids(insertStep(emptyDefinition(), shell('a'), 'end'))).toEqual(['start', 'a', 'end'])
  })

  it('removes a step and joins the ones either side, but never Start or End', () => {
    const def = insertStep(insertStep(emptyDefinition(), shell('a')), shell('b'))
    expect(ids(removeStep(def, 'a'))).toEqual(['start', 'b', 'end'])
    expect(removeStep(def, 'start')).toBe(def)
    expect(removeStep(def, 'end')).toBe(def)
    expect(removeStep(def, 'nope')).toBe(def)
  })

  it('moves a step earlier or later, but not out of the space between Start and End', () => {
    const def = insertStep(insertStep(insertStep(emptyDefinition(), shell('a')), shell('b')), shell('c'))
    expect(ids(moveStep(def, 'c', -1))).toEqual(['start', 'a', 'c', 'b', 'end'])
    expect(ids(moveStep(def, 'a', 1))).toEqual(['start', 'b', 'a', 'c', 'end'])
    expect(moveStep(def, 'a', -1)).toBe(def)
    expect(moveStep(def, 'c', 1)).toBe(def)
    expect(moveStep(def, 'start', 1)).toBe(def)
  })

  it('changes one step and leaves the others and the old definition alone', () => {
    const def = insertStep(emptyDefinition(), shell('a'))
    const next = updateStep(def, 'a', (n) => ({ ...n, name: 'Renamed' }))
    expect(orderedNodes(next)[1]?.name).toBe('Renamed')
    expect(orderedNodes(def)[1]?.name).toBe('a')
  })

  it('makes new steps with names and ids that do not clash', () => {
    const a = makeStep({ type: 'tool', kind: 'shell' }, ['start', 'end'])
    const b = makeStep({ type: 'tool', kind: 'shell' }, ['start', 'end', a.id])
    expect([a.id, b.id]).toEqual(['run_a_command', 'run_a_command_2'])
    expect(makeStep({ type: 'agent' }, []).type).toBe('agent')
    expect(makeStep({ type: 'tool', kind: 'mcp' }, []).name).toBe('Use a tool')
    // A step that has just been added is not ready to run: it still has to be filled in, and the checks say so.
    expect(validateWorkflow(insertStep(emptyDefinition(), a))[0]).toContain('the command is empty')
  })

  it('lists what a step can use: the inputs and the steps before it', () => {
    let def = emptyDefinition()
    def = updateStep(def, 'start', (n) => (n.type === 'start' ? { ...n, inputs: [{ name: 'days', type: 'number' }] } : n))
    def = insertStep(insertStep(def, shell('a')), shell('b'))
    expect(referencesAvailable(def, 'b')).toEqual(['{{inputs.days}}', '{{nodes.a.output}}', '{{run.folder}}'])
    expect(referencesAvailable(def, 'a')).toEqual(['{{inputs.days}}', '{{run.folder}}'])
  })

  it('renames a step, and the id follows along with every reference to it, so nothing breaks', () => {
    let def = insertStep(emptyDefinition(), { id: 'run_a_command', type: 'tool', name: 'Run a command', tool: { kind: 'shell', command: 'find' } })
    def = insertStep(def, { id: 'ask', type: 'agent', name: 'Ask', prompt: 'See {{nodes.run_a_command.output}} and {{ nodes.run_a_command.output.count }} but not {{nodes.run_a_command_2.output}}' })
    def = insertStep(def, { id: 'save', type: 'tool', name: 'Save', tool: { kind: 'file', op: 'write', path: 'a.txt', content: '{{nodes.run_a_command.output}}' } })
    def = updateStep(def, 'end', (n) => (n.type === 'end' ? { ...n, output: '{{nodes.run_a_command.output}}' } : n))
    const next = renameStep(def, 'run_a_command', 'Find old KBs')
    expect(orderedNodes(next).map((n) => n.id)).toEqual(['start', 'find_old_kbs', 'ask', 'save', 'end'])
    expect(orderedNodes(next)[1]?.name).toBe('Find old KBs')
    const text = JSON.stringify(next)
    expect(text).toContain('{{nodes.find_old_kbs.output}}')
    expect(text).toContain('{{ nodes.find_old_kbs.output.count }}')
    expect(text).toContain('{{nodes.run_a_command_2.output}}')
    expect(text).not.toContain('nodes.run_a_command.output')
    expect(next.edges).toContainEqual({ from: 'find_old_kbs', to: 'ask' })
    // The old definition is untouched, and the new one is as valid as it was.
    expect(JSON.stringify(def)).toContain('nodes.run_a_command.output')
    expect(validateWorkflow(next)).toEqual(validateWorkflow(def))
  })

  it('keeps an id that would not change, never renames Start or End, and does not clash with another step', () => {
    let def = insertStep(insertStep(emptyDefinition(), shell('a')), shell('find_old_kbs'))
    expect(renameStep(def, 'a', 'A')).not.toBe(def)
    expect(orderedNodes(renameStep(def, 'a', 'A'))[1]?.id).toBe('a')
    expect(orderedNodes(renameStep(def, 'start', 'Begin'))[0]).toMatchObject({ id: 'start', name: 'Begin' })
    expect(orderedNodes(renameStep(def, 'a', 'Find old KBs')).map((n) => n.id)).toEqual(['start', 'find_old_kbs_2', 'find_old_kbs', 'end'])
    expect(renameStep(def, 'nope', 'X')).toBe(def)
    def = renameStep(def, 'a', '')
    expect(orderedNodes(def)[1]?.id).toBe('step')
  })
})
