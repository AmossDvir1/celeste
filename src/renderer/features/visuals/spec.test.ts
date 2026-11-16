import { describe, expect, it, beforeEach } from 'vitest'
import { splitMarkdown } from '@/lib/markdown-chunks'
import {
  CHART_MAX_LABELS,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  MAX_RETRIES,
  MERMAID_MAX_CHARS,
  STEPS_MAX,
  hashOf,
  noteRetry,
  openFenceBody,
  parseChart,
  parseSteps,
  phoneLine,
  prepareMermaid,
  resetRetries,
  retriesOf,
  retryMessage,
  safeLink,
  summaryOf,
  visualKind
} from './spec'

describe('which fenced blocks are pictures', () => {
  it('knows mermaid, chart and steps, in any case, and leaves every other block as code', () => {
    expect(visualKind('mermaid')).toBe('mermaid')
    expect(visualKind('Chart')).toBe('chart')
    expect(visualKind('STEPS')).toBe('steps')
    for (const l of ['ts', 'json', 'excalidraw', 'mermaidx', '', undefined]) expect(visualKind(l)).toBeNull()
  })

  it('tells blocks apart by their text', () => {
    expect(hashOf('a')).toBe(hashOf('a'))
    expect(hashOf('a')).not.toBe(hashOf('b'))
    expect(hashOf('')).toMatch(/^[0-9a-z]+$/)
  })
})

describe('a block that has not been closed yet', () => {
  it('finds the text after an open fence, and nothing once every fence is closed', () => {
    expect(openFenceBody('Here:\n\n```mermaid\nflowchart TD\n  A --> ')).toBe('flowchart TD\n  A --> ')
    expect(openFenceBody('Here:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n')).toBeNull()
    expect(openFenceBody('```ts\nx\n```\n\nand ```mermaid\nnot a fence')).toBeNull()
    expect(openFenceBody('plain text')).toBeNull()
    expect(openFenceBody('~~~\nopen')).toBe('open')
    // A different kind of fence does not close it.
    expect(openFenceBody('```\nopen\n~~~')).toBe('open\n~~~')
  })

  it('keeps a fence in one piece while the reply streams in, so a half block is never cut off from its start', () => {
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(20).trim()
    const diagram = '```mermaid\nflowchart TD\n  A --> B\n\n  B --> C\n```'
    const text = [para, para, diagram, para, para].join('\n\n')
    for (let n = 100; n <= text.length; n += 53) {
      for (const piece of splitMarkdown(text.slice(0, n))) {
        const opens = (piece.match(/^ {0,3}```/gm) ?? []).length
        // A piece is cut only outside a fence: it holds both fences of a block, or an open one at its very end.
        expect(opens % 2 === 0 || /```mermaid[\s\S]*$/.test(piece)).toBe(true)
      }
    }
    expect(splitMarkdown(text).some((p) => p.includes('```mermaid') && p.includes('B --> C\n```'))).toBe(true)
  })
})

describe('checking a diagram before it is drawn', () => {
  it('passes a normal one through, and finds its summary line', () => {
    const r = prepareMermaid('%% summary: Sign-in goes from the form to the server and back.\nflowchart TD\n  A[Form] --> B[Server]\n')
    expect(r).toEqual({ ok: true, value: { source: '%% summary: Sign-in goes from the form to the server and back.\nflowchart TD\n  A[Form] --> B[Server]', summary: 'Sign-in goes from the form to the server and back.' } })
    expect(prepareMermaid('flowchart TD\n  A --> B')).toMatchObject({ ok: true, value: { source: 'flowchart TD\n  A --> B' } })
    expect((prepareMermaid('flowchart TD\n  A --> B') as { value: object }).value).not.toHaveProperty('summary')
  })

  it('takes out a directive that would change the library’s own settings (the security level, the theme), on one line or many', () => {
    const r = prepareMermaid('%%{init: {"securityLevel": "loose", "theme": "dark"}}%%\nflowchart TD\n  A --> B\n%%{\n  init: { "flowchart": { "htmlLabels": true } }\n}%%\n  B --> C')
    expect(r.ok && r.value.source).toBe('flowchart TD\n  A --> B\n\n  B --> C')
    expect(r.ok && r.value.source).not.toMatch(/securityLevel|init|%%\{/)
  })

  it('refuses an empty one, one over 20,000 characters, and one with more than 200 parts', () => {
    expect(prepareMermaid('   \n ')).toEqual({ ok: false, error: 'The diagram is empty.' })
    const long = prepareMermaid(`flowchart TD\n${'%% x\n'.repeat(MERMAID_MAX_CHARS / 4)}`)
    expect(long.ok).toBe(false)
    expect(!long.ok && long.error).toMatch(/longer than 20,000/)
    const many = prepareMermaid(`flowchart TD\n${Array.from({ length: 150 }, (_, i) => `  N${i}[a] --> M${i}[b]`).join('\n')}`)
    expect(many.ok).toBe(false)
    expect(!many.ok && many.error).toMatch(/more than 200 parts/)
  })
})

describe('checking a chart', () => {
  const chart = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'bar', title: 'Sales', labels: ['Q1', 'Q2'], series: [{ name: 'Units', data: [3, 5] }], summary: 'Sales rose in Q2.', ...over })

  it('accepts bar, line and pie, and keeps only the fields it knows', () => {
    const r = parseChart(chart({ colors: ['red'], script: 'alert(1)', options: { plugins: {} }, series: [{ name: 'Units', data: [3, 5], backgroundColor: 'red', onClick: 'x' }] }))
    expect(r).toEqual({ ok: true, value: { type: 'bar', title: 'Sales', labels: ['Q1', 'Q2'], series: [{ name: 'Units', data: [3, 5] }], summary: 'Sales rose in Q2.' } })
    expect(parseChart(chart({ type: 'line' })).ok).toBe(true)
    expect(parseChart(chart({ type: 'pie' })).ok).toBe(true)
  })

  it('refuses a type it does not draw, and what is not a chart', () => {
    for (const bad of [chart({ type: 'radar' }), chart({ type: undefined }), 'not json', '[]', '"x"', chart({ labels: [] }), chart({ labels: 'Q1' }), chart({ series: [] }), chart({ series: [{ name: 'x', data: ['a'] }] }), chart({ series: [{ name: 'x', data: [1, null] }] })]) {
      expect(parseChart(bad).ok).toBe(false)
    }
  })

  it('keeps to its limits: 50 labels, 6 series, 500 points, one series for a pie, and not a huge block', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i)
    expect(parseChart(chart({ labels: many(CHART_MAX_LABELS), series: [{ name: 'a', data: many(CHART_MAX_LABELS) }] })).ok).toBe(true)
    expect(parseChart(chart({ labels: many(CHART_MAX_LABELS + 1) }))).toMatchObject({ ok: false, error: expect.stringContaining('50 labels') })
    expect(parseChart(chart({ series: Array.from({ length: CHART_MAX_SERIES + 1 }, () => ({ name: 'a', data: [1] })) }))).toMatchObject({ ok: false, error: expect.stringContaining('6 series') })
    expect(parseChart(chart({ labels: many(50), series: Array.from({ length: 6 }, () => ({ name: 'a', data: many(100) })) }))).toMatchObject({ ok: false, error: expect.stringContaining(`${CHART_MAX_POINTS} points`) })
    expect(parseChart(chart({ type: 'pie', series: [{ name: 'a', data: [1] }, { name: 'b', data: [2] }] }))).toMatchObject({ ok: false, error: expect.stringContaining('one series') })
    expect(parseChart(`{"type":"bar","labels":["a"],"series":[{"name":"x","data":[1]}],"summary":"${'x'.repeat(120_000)}"}`)).toMatchObject({ ok: false, error: expect.stringContaining('too large') })
  })

  it('cuts long texts, and names a series that has no name', () => {
    const r = parseChart(chart({ title: 'T'.repeat(500), series: [{ data: [1, 2] }] }))
    expect(r.ok && r.value.title?.length).toBe(120)
    expect(r.ok && r.value.series[0]?.name).toBe('Series 1')
  })
})

describe('checking steps', () => {
  const steps = (over: Record<string, unknown> = {}) => JSON.stringify({ title: 'Turn on two-step sign-in', steps: [{ title: 'Open settings', text: 'Click your picture, then Settings.', link: { label: 'Settings', url: 'https://example.com/settings' } }, { title: 'Run this', copy: 'gh auth login' }], ...over })

  it('accepts a title and steps with text, a value to copy and a link, and drops unknown fields', () => {
    const r = parseSteps(steps({ run: 'rm -rf /', steps: [{ title: 'A', onClick: 'x', link: { label: 'L', url: 'https://example.com/a', rel: 'x' } }] }))
    expect(r).toEqual({ ok: true, value: { title: 'Turn on two-step sign-in', steps: [{ title: 'A', link: { label: 'L', url: 'https://example.com/a' } }] } })
    const full = parseSteps(steps())
    expect(full.ok && full.value.steps[1]).toEqual({ title: 'Run this', copy: 'gh auth login' })
  })

  it('leaves out a link that is not https, and keeps the step', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'file:///etc/passwd', 'data:text/html,x', 'https://localhost', 'ftp://example.com/a', 'not a url', 42]) {
      const r = parseSteps(steps({ steps: [{ title: 'A', link: { label: 'L', url } }] }))
      expect(r.ok && r.value.steps[0]).toEqual({ title: 'A' })
    }
    expect(safeLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeLink('https://' + 'a'.repeat(2000) + '.com')).toBeUndefined()
  })

  it('refuses no title, no steps, a step with no title, and more than 20 steps', () => {
    expect(parseSteps(steps({ title: '' }))).toMatchObject({ ok: false })
    expect(parseSteps(steps({ steps: [] }))).toMatchObject({ ok: false })
    expect(parseSteps(steps({ steps: [{ text: 'no title' }] }))).toMatchObject({ ok: false, error: 'Each step needs a title.' })
    expect(parseSteps(steps({ steps: ['text'] }))).toMatchObject({ ok: false })
    expect(parseSteps(steps({ steps: Array.from({ length: STEPS_MAX + 1 }, (_, i) => ({ title: `S${i}` })) }))).toMatchObject({ ok: false, error: expect.stringContaining('20 steps') })
    expect(parseSteps(steps({ steps: Array.from({ length: STEPS_MAX }, (_, i) => ({ title: `S${i}` })) })).ok).toBe(true)
    expect(parseSteps('nope')).toMatchObject({ ok: false })
  })
})

describe('trying again', () => {
  beforeEach(() => resetRetries())

  it('says what could not be drawn, with the library’s words, marked as automatic', () => {
    expect(retryMessage('mermaid', 'Parse error on line 3:\n  A --> --> ???')).toBe('(automatic) That diagram could not be drawn: Parse error on line 3: A --> --> ??? Please fix it and send it again.')
    expect(retryMessage('chart', 'The chart needs a list of labels.')).toMatch(/^\(automatic\) That chart could not be drawn/)
    expect(retryMessage('steps', 'x'.repeat(1000)).length).toBeLessThan(400)
  })

  it('counts each block in each chat on its own, and stops at two', () => {
    expect(MAX_RETRIES).toBe(2)
    expect(retriesOf('chat-1', 'abc')).toBe(0)
    noteRetry('chat-1', 'abc')
    noteRetry('chat-1', 'abc')
    expect(retriesOf('chat-1', 'abc')).toBe(2)
    expect(retriesOf('chat-1', 'other')).toBe(0)
    expect(retriesOf('chat-2', 'abc')).toBe(0)
  })
})

describe('what a picture says in words', () => {
  it('reads the summary of each kind, and nothing from a block that is broken', () => {
    expect(summaryOf('mermaid', '%% summary: A to B.\nflowchart TD\n  A --> B')).toBe('A to B.')
    expect(summaryOf('chart', '{"type":"bar","labels":["a"],"series":[{"name":"x","data":[1]}],"summary":"Up."}')).toBe('Up.')
    expect(summaryOf('steps', '{"title":"T","summary":"Three steps.","steps":[{"title":"A"}]}')).toBe('Three steps.')
    expect(summaryOf('chart', 'not json')).toBe('')
    expect(summaryOf('mermaid', '')).toBe('')
  })

  it('gives the phone a line in place of the picture, and never the source', () => {
    expect(phoneLine('mermaid', '%% summary: A to B.\nflowchart TD\n  A --> B')).toBe('A to B. (open on the computer to see the picture)')
    expect(phoneLine('mermaid', 'flowchart TD\n  A --> B')).toBe('A diagram (open on the computer)')
    expect(phoneLine('chart', '{}')).toBe('A chart (open on the computer)')
    expect(phoneLine('steps', '{}')).toBe('Steps (open on the computer)')
    expect(phoneLine('mermaid', 'flowchart TD\n  SECRET --> B')).not.toContain('SECRET')
  })
})
