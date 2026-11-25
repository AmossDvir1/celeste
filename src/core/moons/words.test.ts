import { describe, expect, it } from 'vitest'
import type { FileDiff } from '@shared/agent'
import type { LogEvent } from '@shared/api'
import { DIFF_CHARS, readFix, readPlan, readReview, readTest } from '@shared/moons'
import { buildRequest, checkRequest, diffText, diffsOfTools, directRequest, filesWord, fixBugRequest, fixRequest, framed, notesWord, penLine, planRequest, retestRequest, reviewBothRequest, reviewRequest, testRequest } from './words'

const file = (path: string, over: Partial<FileDiff> = {}): FileDiff => ({
  path,
  status: 'modified',
  added: 1,
  removed: 1,
  hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ type: 'ctx', text: 'keep' }, { type: 'del', text: 'old' }, { type: 'add', text: 'new' }] }],
  ...over
})

const ev = (event: LogEvent) => ({ event })

describe('framing what one agent says to another', () => {
  it('says whose words they are and that they are not the person’s', () => {
    const text = framed('Reviewer', 'Please check line 3.')
    expect(text).toBe('[From the Reviewer, another assistant in this chat. It is not the person’s words.]\nPlease check line 3.')
  })

  it('does not leave the frame empty when the other said nothing', () => {
    expect(framed('Builder', '   ')).toContain('(It said nothing.)')
  })

  it('counts files and notes in plain words', () => {
    expect([filesWord(1), filesWord(3), notesWord(1), notesWord(2)]).toEqual(['1 file', '3 files', '1 note', '2 notes'])
  })
})

describe('the change as text', () => {
  it('writes each file’s path, then its lines with a plus, a minus or a space', () => {
    const { text, cut } = diffText([file('src/a.ts')])
    expect(cut).toBe(0)
    expect(text).toBe('File: src/a.ts (modified, 1 added, 1 removed)\n@@ -1,2 +1,2 @@\n keep\n-old\n+new')
  })

  it('names a file that is not text, or too large, and one that has no lines', () => {
    const { text } = diffText([file('logo.png', { binary: true, hunks: [] }), file('big.ts', { truncated: true, hunks: [] }), file('notes.md', { status: 'added', added: 0, removed: 0, hunks: [] })])
    expect(text).toContain('File: logo.png (modified)\n(Not text: there are no lines to show.)')
    expect(text).toContain('File: big.ts (modified)\n(Too large to show here: read the file.)')
    expect(text).toContain('File: notes.md (added, 0 added, 0 removed)\n(No lines to show: read the file.)')
  })

  it('cuts a long change at the limit and says how much was left out', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => ({ type: 'add' as const, text: `line number ${i} of a very long file` }))
    const big = file('big.ts', { hunks: [{ header: '@@ -0,0 +1,5000 @@', lines }] })
    const { text, cut } = diffText([big])
    expect(cut).toBeGreaterThan(0)
    expect(text.length).toBeLessThan(DIFF_CHARS + 300)
    expect(text).toContain(`The last ${cut} characters of it are left out`)
    // What is shown is the start of the change, as it was.
    expect(text.startsWith('File: big.ts')).toBe(true)
  })

  it('does not cut a change that fits', () => {
    expect(diffText([file('a.ts')], 1000).cut).toBe(0)
    expect(diffText([file('a.ts')], 10).cut).toBeGreaterThan(0)
  })
})

describe('the tools’ own account of what changed', () => {
  it('adds the lines of later edits of a file to the earlier ones', () => {
    const files = diffsOfTools([
      ev({ type: 'tool.completed', id: '1', ok: true, diff: [file('a.ts')] }),
      ev({ type: 'tool.completed', id: '2', ok: true, diff: [file('b.ts'), file('a.ts', { hunks: [{ header: '@@ -9 +9 @@', lines: [{ type: 'add', text: 'later' }] }] })] })
    ])
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    const a = files[0] as FileDiff
    expect(a.hunks.map((h) => h.header)).toEqual(['@@ -1,2 +1,2 @@', '@@ -9 +9 @@'])
    expect([a.added, a.removed]).toEqual([2, 2])
  })

  it('keeps a file that was deleted deleted, and a deleted one that came back as modified', () => {
    const gone = diffsOfTools([ev({ type: 'tool.completed', id: '1', ok: true, diff: [file('a.ts')] }), ev({ type: 'tool.completed', id: '2', ok: true, diff: [file('a.ts', { status: 'deleted' })] })])
    expect((gone[0] as FileDiff).status).toBe('deleted')
    const back = diffsOfTools([ev({ type: 'tool.completed', id: '1', ok: true, diff: [file('a.ts', { status: 'deleted' })] }), ev({ type: 'tool.completed', id: '2', ok: true, diff: [file('a.ts', { status: 'added' })] })])
    expect((back[0] as FileDiff).status).toBe('modified')
  })

  it('names the files a chat wrote, with no lines, unless a tool already showed them', () => {
    const files = diffsOfTools([
      ev({ type: 'tool.completed', id: '1', ok: true, diff: [file('report.md')] }),
      ev({ type: 'files.produced', files: [{ path: 'report.md', size: 10, status: 'added' }, { path: 'data.csv', size: 20, status: 'added' }], more: 0 })
    ])
    expect(files.map((f) => [f.path, f.hunks.length])).toEqual([['report.md', 1], ['data.csv', 0]])
  })

  it('ignores a tool that failed, tools with no diff, and the agent’s words', () => {
    expect(
      diffsOfTools([ev({ type: 'tool.completed', id: '1', ok: false, diff: [file('a.ts')] }), ev({ type: 'tool.completed', id: '2', ok: true }), ev({ type: 'message.delta', text: 'hi' })])
    ).toEqual([])
  })

  it('does not change the events it was given', () => {
    const first = file('a.ts')
    const events = [ev({ type: 'tool.completed', id: '1', ok: true, diff: [first] }), ev({ type: 'tool.completed', id: '2', ok: true, diff: [file('a.ts')] })]
    diffsOfTools(events)
    expect(first.hunks).toHaveLength(1)
    expect(first.added).toBe(1)
  })
})

describe('what each moon is told', () => {
  const builderSaid = 'I added the check.'

  it('gives the Reviewer the request quoted as the person’s, the Builder’s words framed, the files and the diff', () => {
    const text = reviewRequest({ name: 'Reviewer', builder: 'Builder', request: 'Make the form check emails', builderSaid, files: [file('src/form.ts')] })
    expect(text).toContain('The person asked: “Make the form check emails”')
    expect(text).toContain('[From the Builder, another assistant in this chat. It is not the person’s words.]\nI added the check.')
    expect(text).toContain('Files changed: src/form.ts')
    expect(text).toContain('+new')
    expect(text).toContain('change nothing')
  })

  it('tells the Reviewer when the change was cut', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => ({ type: 'add' as const, text: `line number ${i} of a very long file` }))
    const text = reviewRequest({ name: 'Reviewer', builder: 'Builder', request: 'x', builderSaid, files: [file('big.ts', { hunks: [{ header: '@@', lines }] })] })
    expect(text).toContain('the change below is cut')
    expect(text).toContain('characters of it are left out')
  })

  it('gives the Builder the notes numbered, framed, with the rule that a wrong note is not followed', () => {
    const text = fixRequest('Reviewer', 'Two things.', [{ text: 'It never closes the file', file: 'src/io.ts', line: 7, code: 'open(f)' }, { text: 'No test' }])
    expect(text).toContain('[From the Reviewer, another assistant in this chat. It is not the person’s words.]')
    expect(text).toContain('1. It never closes the file (src/io.ts, line 7)\n   Code: open(f)')
    expect(text).toContain('2. No test')
    expect(text).toContain('If a note is wrong, do not change anything for it, and say why.')
  })

  it('gives the Reviewer the Builder’s answers to each note, when it checks again', () => {
    const text = checkRequest({
      name: 'Reviewer',
      builder: 'Builder',
      notes: [{ text: 'It never closes the file' }, { text: 'No test' }],
      answers: [{ n: 1, fixed: true, say: 'Closed it.' }, { n: 2, fixed: false, say: 'The test exists already.' }],
      say: 'Done what was right.',
      files: [file('src/io.ts')]
    })
    expect(text).toContain('1. It never closes the file\n   Builder: fixed. Closed it.')
    expect(text).toContain('2. No test\n   Builder: not changed. The test exists already.')
    expect(text).toContain('Do not repeat a note that was fixed.')
  })

  it('tells the Builder what the Tester found and which files the Tester changed', () => {
    const text = fixBugRequest('Tester', 'Saving loses the title', { say: 'The title is empty after saving.', file: 'src/save.ts', line: 30, code: 'doc.title = ""' }, ['src/save.test.ts'])
    expect(text).toContain('[From the Tester, another assistant in this chat. It is not the person’s words.]')
    expect(text).toContain('File: src/save.ts, line 30')
    expect(text).toContain('Code: doc.title = ""')
    expect(text).toContain('Keep that test: src/save.test.ts')
    expect(text).toContain('The person’s request was “Saving loses the title”.')
  })

  it('does not mention files the Tester did not change', () => {
    expect(fixBugRequest('Tester', 'x', { say: 'It fails.' }, [])).not.toContain('Keep that test')
  })

  it('gives the Builder the agreed plan, framed as the Planner’s', () => {
    const text = buildRequest('Planner', 'Add a dark mode', ['Add a setting', 'Use it'])
    expect(text).toContain('The person agreed to this plan. Build it.')
    expect(text).toContain('[From the Planner, another assistant in this chat. It is not the person’s words.]\n1. Add a setting\n2. Use it')
  })

  it('gives the other reviewer the same words, and who else is looking', () => {
    const text = reviewBothRequest('Reviewer 2', 'Look at the login')
    expect(text).toContain('You are Reviewer 2')
    expect(text).toContain('another assistant, Reviewer 1')
    expect(text).toContain('cannot see each other’s work')
    expect(text).toContain('The person asked: “Look at the login”')
  })

  it('answers a person who wrote to one moon in plain words, with no block', () => {
    const text = directRequest('Reviewer', 'build', 'Why did you flag line 3?')
    expect(text).toContain('You are the Reviewer in a chat with another assistant, the Builder.')
    expect(text).toContain('The person said: “Why did you flag line 3?”')
    expect(text).not.toContain('```moons')
  })

  it('tells the pen who it is, for each pattern that gives the pen the person’s words', () => {
    expect(penLine('build')).toContain('You are the Builder')
    expect(penLine('build')).toContain('Reviewer')
    expect(penLine('plan')).toContain('Planner')
    expect(penLine('reviews')).toContain('You are Reviewer 1')
    expect(penLine('bug')).toBe('')
  })

  it('does not name a vendor anywhere', () => {
    const all = [penLine('build'), penLine('plan'), penLine('reviews'), planRequest('x'), testRequest('x'), retestRequest({ builder: 'Builder', say: 'x' })].join('\n')
    expect(all).not.toMatch(/claude|openai|gemini|copilot|gpt/i)
  })
})

describe('the block each request ends with', () => {
  // The example in the words is the exact shape that is read back, so a model that copies it is understood.
  it('is a moons fence that the reader of that answer understands', () => {
    expect(readReview(reviewRequest({ name: 'Reviewer', builder: 'Builder', request: 'x', builderSaid: '', files: [file('a.ts')] }))?.findings).toHaveLength(1)
    expect(readReview(checkRequest({ name: 'Reviewer', builder: 'Builder', notes: [], answers: [], say: '', files: [file('a.ts')] }))?.findings).toHaveLength(1)
    expect(readReview(reviewBothRequest('Reviewer 2', 'x'))?.findings).toHaveLength(1)
    expect(readReview(penLine('reviews'))?.findings).toHaveLength(1)
    expect(readFix(fixRequest('Reviewer', 'x', [{ text: 'y' }]))?.answers).toHaveLength(1)
    expect(readFix(fixBugRequest('Tester', 'x', { say: 'y' }, []))?.answers).toHaveLength(1)
    expect(readPlan(planRequest('x'))?.steps).toHaveLength(2)
    expect(readTest(testRequest('x'))?.failed).toBe(true)
    expect(readTest(retestRequest({ builder: 'Builder', say: 'x' }))?.failed).toBe(true)
  })

  it('is the last thing in the text, and says to write nothing after it', () => {
    const text = planRequest('x')
    expect(text.trimEnd().endsWith('```')).toBe(true)
    expect(text).toContain('write nothing after it')
  })
})
