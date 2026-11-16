import { describe, expect, it } from 'vitest'
import { parseChart, parseSteps, prepareMermaid } from '../../renderer/features/visuals/spec'
import { CHART_EXAMPLE, MERMAID_EXAMPLE, STEPS_EXAMPLE, VISUALS_INSTRUCTION, visualsFor } from './visuals'

/** The text of each fenced block in the instruction, by language. */
function blocks(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/```(\w+)\n([\s\S]*?)\n```/g)) out[m[1] as string] = m[2] as string
  return out
}

describe('what the assistants are told about pictures', () => {
  it('teaches three formats, and the window draws every example it gives', () => {
    const b = blocks(VISUALS_INSTRUCTION)
    expect(Object.keys(b).sort()).toEqual(['chart', 'mermaid', 'steps'])
    const mermaid = prepareMermaid(b['mermaid'] as string)
    expect(mermaid).toMatchObject({ ok: true })
    expect(mermaid.ok && mermaid.value.summary).toMatch(/browser to the server/)
    const chart = parseChart(b['chart'] as string)
    expect(chart.ok && chart.value).toMatchObject({ type: 'bar', labels: ['Q1', 'Q2', 'Q3'], summary: expect.stringContaining('Sales grew') })
    const steps = parseSteps(b['steps'] as string)
    expect(steps.ok && steps.value.steps).toHaveLength(3)
    // The example link survives the window's own check, so it teaches one that works.
    expect(steps.ok && steps.value.steps[0]?.link?.url).toBe('https://example.com/settings')
  })

  it('has the examples as the exported objects, so a change to one is a change to the text', () => {
    expect(JSON.parse(blocks(VISUALS_INSTRUCTION)['chart'] as string)).toEqual(CHART_EXAMPLE)
    expect(JSON.parse(blocks(VISUALS_INSTRUCTION)['steps'] as string)).toEqual(STEPS_EXAMPLE)
    expect(blocks(VISUALS_INSTRUCTION)['mermaid']).toBe(MERMAID_EXAMPLE)
  })

  it('says when to draw and when not to, the limits the window enforces, and to write the answer in words as well', () => {
    for (const phrase of ['only when it clearly makes the answer easier', 'never needs one', 'at most 50 labels and 6 series', 'a pie has one series', 'at most 20 steps', 'https link', 'in words as well', 'could not be drawn']) {
      expect(VISUALS_INSTRUCTION.toLowerCase()).toContain(phrase.toLowerCase())
    }
  })

  it('is short enough to send with every new conversation', () => {
    expect(VISUALS_INSTRUCTION.length).toBeLessThan(3500)
  })

  it('is given to a chat and a Develop session, and to no step of a workflow', () => {
    expect(visualsFor({ sessionId: 'a1b2c3' })).toBe(VISUALS_INSTRUCTION)
    expect(visualsFor({ sessionId: 'wf-123' })).toBeUndefined()
  })
})
