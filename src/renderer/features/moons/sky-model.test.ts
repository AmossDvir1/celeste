import { describe, expect, it } from 'vitest'
import type { FileDiff } from '@shared/agent'
import type { LogEvent } from '@shared/api'
import { MOON_PATTERN_ORDER, PATTERNS, type MoonPattern } from '@shared/moons'
import { foldEvents } from '@/stores/reduce'
import type { Session } from '@/stores/types'
import { DONE_MS, EDIT_MOMENT_MS, HAND_MS, fileOfTool, mergeDiffs, sameFile, skyOf, type SkyView } from './sky-model'

const T0 = 1_000_000

function blank(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    vendor: 'claude',
    mode: 'develop',
    title: id,
    model: 'm',
    effort: null,
    approval: 'auto',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    lastSeq: 0,
    items: [],
    activity: null,
    loaded: true,
    foldedSeq: 0,
    queue: { items: [], paused: false },
    ...over
  }
}

const chatOf = (pattern: MoonPattern): Session => blank('chat', { moons: { pattern, childId: 'kid' } })
const play = (s: Session, ...events: [number, LogEvent][]): Session => foldEvents(s, events.map(([at, event], i) => ({ seq: s.foldedSeq + i + 1, at, event })))
const say = (text = 'Do it'): LogEvent => ({ type: 'user.message', text, attachments: [] })
const start = (id: string, kind: 'read' | 'edit' | 'write' | 'shell' | 'web' | 'search' | 'mcp' | 'agent' | 'other', title: string, input?: unknown): LogEvent => ({ type: 'tool.started', id, kind, title, input })

const diff = (path: string, lines: [('ctx' | 'add' | 'del'), string, number?][]): FileDiff => ({
  path,
  status: 'modified',
  added: lines.filter((l) => l[0] === 'add').length,
  removed: lines.filter((l) => l[0] === 'del').length,
  hunks: [{ header: '@@ -1,3 +1,4 @@', lines: lines.map(([type, text, newNo]) => ({ type, text, ...(newNo !== undefined ? { newNo } : {}) })) }]
})

const LOGIN = diff('src/auth/login.ts', [
  ['ctx', 'setBusy(true)', 1],
  ['del', "const res = await fetch('/api/session', {"],
  ['add', 'const stop = AbortSignal.timeout(8000)', 2],
  ['add', "const res = await fetch('/api/session', { signal: stop,", 3],
  ['ctx', "  method: 'POST', body: JSON.stringify(form)", 4],
  ['ctx', '})', 5]
])

/** The one that works is the pen (the chat itself): Builder in `build`. */
function builderEditing(at = T0): Session {
  return play(chatOf('build'), [at, say()], [at + 10, { type: 'moons.turn', seat: 0, step: 'build' }], [at + 20, start('e1', 'edit', 'Edit login.ts', JSON.stringify({ file_path: 'C:\\app\\src\\auth\\login.ts' }))])
}

const sky = (s: Session, child: Session | undefined, now: number, idleSince?: number): SkyView => {
  const v = skyOf(s, child, now, idleSince === undefined ? {} : { idleSince })
  expect(v).not.toBeNull()
  return v as SkyView
}

describe('when the sky is down', () => {
  it('is null for a chat without moons, for an idle chat, and for one that is idle with nothing to celebrate', () => {
    expect(skyOf(blank('plain'), undefined, T0)).toBeNull()
    expect(skyOf(chatOf('build'), undefined, T0)).toBeNull()
    const ended = play(builderEditing(), [T0 + 100, { type: 'moons.ended', why: 'stopped' }])
    expect(ended.status).toBe('idle')
    expect(skyOf(ended, undefined, T0 + 200, { idleSince: T0 + 100 })).toBeNull()
  })
})

describe('the one that works and its state', () => {
  it('is the pen when the chat works and no turn is recorded yet', () => {
    const s = play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'turn.started', turnId: 't' }])
    const v = sky(s, undefined, T0 + 5)
    expect(v).toMatchObject({ mode: 'one', lit: 0, step: 0, still: false })
    expect(v.seats.map((x) => x.state)).toEqual(['think', 'rest'])
    expect(v.caption).toBe('Builder is thinking')
    const plan = play(chatOf('plan'), [T0, say()], [T0 + 1, { type: 'turn.started', turnId: 't' }])
    expect(sky(plan, undefined, T0 + 5)).toMatchObject({ lit: 1, step: 2 })
  })

  it('edits: the file is named by its basename, the lit seat is the pen, the other rests', () => {
    const v = sky(builderEditing(), undefined, T0 + 30)
    expect(v).toMatchObject({ mode: 'one', lit: 0, step: 0, caption: 'Builder is editing login.ts' })
    expect(v.seats.map((x) => [x.name, x.state, x.lit])).toEqual([['Builder', 'edit', true], ['Reviewer', 'rest', false]])
    // No lines yet: the scene names the file and invents nothing.
    expect(v.scenes[0]).toEqual({ kind: 'edit', key: 'e1', file: 'login.ts', lines: [], added: 0, removed: 0 })
  })

  it('replays the real lines of an edit that just landed, for 1.6 seconds, and then goes on thinking', () => {
    const done = play(builderEditing(), [T0 + 500, { type: 'tool.completed', id: 'e1', ok: true, diff: [LOGIN] }])
    const v = sky(done, undefined, T0 + 700)
    expect(v.seats[0].state).toBe('edit')
    expect(v.caption).toBe('Builder is editing login.ts')
    expect(v.until).toBe(T0 + 500 + EDIT_MOMENT_MS)
    const scene = v.scenes[0]
    expect(scene).toMatchObject({ kind: 'edit', key: 'e1:d', file: 'login.ts', added: 2, removed: 1 })
    expect(scene && scene.kind === 'edit' && scene.lines.map((l) => [l.k, l.text])).toEqual([
      ['ctx', 'setBusy(true)'],
      ['del', "const res = await fetch('/api/session', {"],
      ['add', 'const stop = AbortSignal.timeout(8000)'],
      ['add', "const res = await fetch('/api/session', { signal: stop,"],
      ['ctx', "  method: 'POST', body: JSON.stringify(form)"],
      ['ctx', '})']
    ])
    // Its key differs from the running edit's, so the typing starts again when the diff lands.
    expect(v.key).not.toBe(sky(builderEditing(), undefined, T0 + 30).key)
    const later = sky(done, undefined, T0 + 500 + EDIT_MOMENT_MS)
    expect(later.seats[0].state).toBe('think')
    expect(later.caption).toBe('Builder is thinking')
  })

  it('cuts a long diff to six lines with one line of context before the first change', () => {
    const lines: [('ctx' | 'add' | 'del'), string, number?][] = Array.from({ length: 12 }, (_, i) => ['ctx', `line ${i + 1}`, i + 1])
    lines[8] = ['add', 'the change', 9]
    const s = play(builderEditing(), [T0 + 500, { type: 'tool.completed', id: 'e1', ok: true, diff: [diff('a.ts', lines)] }])
    const scene = sky(s, undefined, T0 + 600).scenes[0]
    expect(scene && scene.kind === 'edit' && scene.lines.map((l) => l.text)).toEqual(['line 7', 'line 8', 'the change', 'line 10', 'line 11', 'line 12'])
    const early: [('ctx' | 'add' | 'del'), string, number?][] = Array.from({ length: 12 }, (_, i) => ['ctx', `line ${i + 1}`, i + 1])
    early[4] = ['del', 'old']
    const t = play(builderEditing(), [T0 + 500, { type: 'tool.completed', id: 'e1', ok: true, diff: [diff('a.ts', early)] }])
    const around = sky(t, undefined, T0 + 600).scenes[0]
    expect(around && around.kind === 'edit' && around.lines.map((l) => l.text)).toEqual(['line 4', 'old', 'line 6', 'line 7', 'line 8', 'line 9'])
  })

  it('says only the file when a tool gives no lines', () => {
    const s = play(builderEditing(), [T0 + 500, { type: 'tool.completed', id: 'e1', ok: true, diff: [{ path: 'src/a.ts', status: 'modified', added: 0, removed: 0, hunks: [] }] }])
    const scene = sky(s, undefined, T0 + 600).scenes[0]
    expect(scene).toMatchObject({ kind: 'edit', file: 'a.ts', lines: [] })
  })

  it('runs a command: the caption cuts it at 60 characters and the scene keeps the last 4 lines of its output', () => {
    const long = `npm test -- ${'x'.repeat(90)}`
    let s = play(chatOf('build'), [T0, say()], [T0 + 1, start('r1', 'shell', 'Run tests', long)])
    s = play(s, [T0 + 2, { type: 'tool.output', id: 'r1', text: 'one\ntwo\n\x1b[32mthree\x1b[0m\n' }], [T0 + 3, { type: 'tool.output', id: 'r1', text: 'four\nfive\n' }])
    const v = sky(s, undefined, T0 + 10)
    expect(v.seats[0].state).toBe('run')
    expect(v.caption).toBe(`Builder is running ${long.slice(0, 59)}…`)
    expect(v.scenes[0]).toMatchObject({ kind: 'run', output: ['two', 'three', 'four', 'five'] })
  })

  it('reads: a builder reads, a reviewer uses its lens; search and web are reading too', () => {
    const s = play(chatOf('build'), [T0, say()], [T0 + 1, start('a', 'read', 'Read src/main.ts')])
    expect(sky(s, undefined, T0 + 5)).toMatchObject({ caption: 'Builder is reading main.ts' })
    expect(sky(s, undefined, T0 + 5).seats[0].state).toBe('read')
    expect(sky(play(chatOf('build'), [T0, say()], [T0 + 1, start('a', 'search', 'Search for login')]), undefined, T0 + 5).seats[0].state).toBe('read')
    expect(sky(play(chatOf('build'), [T0, say()], [T0 + 1, start('a', 'web', 'Search the web')]), undefined, T0 + 5).seats[0].state).toBe('read')
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, start('b', 'read', 'Read src/main.ts')])
    const reviewing = play(chatOf('build'), [T0, say()], [T0 + 2, { type: 'moons.turn', seat: 1, step: 'review' }])
    const v = sky(reviewing, kid, T0 + 5)
    expect(v).toMatchObject({ lit: 1, step: 1, caption: 'Reviewer is checking the change' })
    expect(v.seats.map((x) => x.state)).toEqual(['rest', 'lens'])
  })

  it('treats mcp, agent and other tools as running something', () => {
    for (const kind of ['mcp', 'agent', 'other'] as const) {
      const s = play(chatOf('build'), [T0, say()], [T0 + 1, start('a', kind, 'Some tool')])
      expect(sky(s, undefined, T0 + 5).seats[0].state).toBe('run')
    }
  })

  it('thinks with the last 7 distinct files or words from the tools, and with no words when there were no tools', () => {
    let s = play(chatOf('build'), [T0, say()], [T0, { type: 'turn.started', turnId: 't' }])
    expect(sky(s, undefined, T0 + 1).scenes[0]).toEqual({ kind: 'think', words: [] })
    const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'a.ts']
    for (const [i, n] of names.entries()) s = play(s, [T0 + 10 + i * 2, start(`t${i}`, 'read', `Read src/${n}`)], [T0 + 11 + i * 2, { type: 'tool.completed', id: `t${i}`, ok: true }])
    const scene = sky(s, undefined, T0 + 10_000).scenes[0]
    expect(scene).toEqual({ kind: 'think', words: ['b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'] })
  })

  it('waits for the person: a pending approval wins, still, with the real request to answer', () => {
    const s = play(builderEditing(), [T0 + 100, { type: 'approval.requested', requestId: 'q1', kind: 'shell', title: 'npm run test:e2e', detail: 'npm run test:e2e -- login' }])
    expect(s.status).toBe('waiting')
    const v = sky(s, undefined, T0 + 200)
    expect(v).toMatchObject({ caption: 'Builder is waiting for you', still: true })
    expect(v.seats[0].state).toBe('wait')
    expect(v.scenes[0]).toMatchObject({ kind: 'wait', buttons: 'answer', requestId: 'q1', sessionId: 'chat', question: 'Builder wants to run a command.', title: 'npm run test:e2e -- login' })
  })

  it('offers Open for a question with options, and for an approval with a slider', () => {
    const asked = play(builderEditing(), [T0 + 100, { type: 'ask_user.requested', requestId: 'a1', questions: [{ header: 'Which', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: false }] }])
    expect(sky(asked, undefined, T0 + 200).scenes[0]).toMatchObject({ kind: 'wait', buttons: 'open', question: 'Which database?', detail: 'SQLite, Postgres', requestId: 'a1', sessionId: 'chat' })
    const slid = play(builderEditing(), [T0 + 100, { type: 'approval.requested', requestId: 'q2', kind: 'other', title: 'Use the computer', slider: { min: 1, max: 60, step: 1, value: 10 } }])
    expect(sky(slid, undefined, T0 + 200).scenes[0]).toMatchObject({ kind: 'wait', buttons: 'open' })
  })

  it('shows the approval of the other moon, with that session’s id', () => {
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, { type: 'approval.requested', requestId: 'k1', kind: 'shell', title: 'git diff', detail: 'git diff' }])
    const s = play(chatOf('build'), [T0, say()], [T0 + 2, { type: 'moons.turn', seat: 1, step: 'review' }])
    const v = sky(s, kid, T0 + 5)
    expect(v.seats.map((x) => x.state)).toEqual(['rest', 'wait'])
    expect(v.scenes[0]).toMatchObject({ kind: 'wait', requestId: 'k1', sessionId: 'kid', question: 'Reviewer wants to run a command.' })
  })
})

describe('the lens', () => {
  const reviewing = () => {
    let s = play(chatOf('build'), [T0, say()], [T0 + 1, start('e1', 'edit', 'Edit login.ts')], [T0 + 2, { type: 'tool.completed', id: 'e1', ok: true, diff: [LOGIN, diff('src/other.ts', [['add', 'x', 1]])] }])
    s = play(s, [T0 + 3, { type: 'moons.handed', from: 0, to: 1, what: '2 files' }], [T0 + 4, { type: 'moons.turn', seat: 1, step: 'review' }])
    return s
  }

  it('shows the first file of the pen’s changes when the reviewer has no tool running', () => {
    const kid = play(blank('kid'), [T0, say('Review it')])
    const v = sky(reviewing(), kid, T0 + 10_000)
    expect(v.seats[1].state).toBe('lens')
    const scene = v.scenes[0]
    expect(scene).toMatchObject({ kind: 'lens', file: 'login.ts', marks: [] })
    expect(scene && scene.kind === 'lens' && scene.lines).toHaveLength(6)
  })

  it('shows the file the reviewer is reading when it is one of the changed files', () => {
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, start('r', 'read', 'Read other.ts')])
    expect(sky(reviewing(), kid, T0 + 10_000).scenes[0]).toMatchObject({ kind: 'lens', file: 'other.ts' })
  })

  it('marks the lines the findings cite, and only those that are on show', () => {
    let s = reviewing()
    s = play(
      s,
      [T0 + 5, { type: 'moons.said', seat: 1, id: 'f1', text: 'The error is not shown', file: 'src/auth/login.ts', line: 3, finding: true }],
      [T0 + 6, { type: 'moons.said', seat: 1, id: 'f2', text: 'Cites a file that is not there', file: 'src/nope.ts', line: 3, finding: true }],
      [T0 + 7, { type: 'moons.said', seat: 1, id: 'f3', text: 'No such line', file: 'src/auth/login.ts', line: 99, finding: true }],
      [T0 + 8, { type: 'moons.said', seat: 1, id: 'f4', text: 'A remark, not a finding', file: 'src/auth/login.ts', line: 2 }]
    )
    const kid = play(blank('kid'), [T0, say('Review it')])
    const scene = sky(s, kid, T0 + 10_000).scenes[0]
    expect(scene && scene.kind === 'lens' && scene.marks).toEqual([{ row: 3, text: 'The error is not shown' }])
  })

  it('has no lines when nothing was written, and shows what a read gives', () => {
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, start('r', 'read', 'Read a.ts')], [T0 + 2, { type: 'tool.output', id: 'r', text: 'first\nsecond\n' }])
    const s = play(chatOf('build'), [T0, say()], [T0 + 2, { type: 'moons.turn', seat: 1, step: 'review' }])
    expect(sky(s, kid, T0 + 5).scenes[0]).toEqual({ kind: 'lens', file: 'a.ts', lines: [{ k: 'ctx', text: 'first' }, { k: 'ctx', text: 'second' }], marks: [] })
  })
})

describe('every pattern', () => {
  const scenario = (pattern: MoonPattern, seat: 0 | 1, step: 'build' | 'review' | 'fix' | 'check' | 'plan' | 'test' | 'retest'): Session =>
    play(chatOf(pattern), [T0, say()], [T0 + 1, { type: 'moons.turn', seat, step }])

  it('lights the seat whose turn it is and names the track step, for each pattern', () => {
    const cases: [MoonPattern, 0 | 1, 'build' | 'review' | 'fix' | 'check' | 'plan' | 'test' | 'retest', number][] = [
      ['build', 0, 'build', 0],
      ['build', 1, 'review', 1],
      ['build', 0, 'fix', 2],
      ['build', 1, 'check', 3],
      ['plan', 0, 'plan', 0],
      ['plan', 1, 'build', 2],
      ['bug', 0, 'test', 0],
      ['bug', 1, 'fix', 1],
      ['bug', 0, 'retest', 2]
    ]
    for (const [pattern, seat, step, index] of cases) {
      const v = sky(scenario(pattern, seat, step), blank('kid'), T0 + 5)
      expect(v, `${pattern} ${step}`).toMatchObject({ mode: 'one', lit: seat, step: index, track: PATTERNS[pattern].track })
      expect(v.seats[seat].lit).toBe(true)
      expect(v.seats[seat === 0 ? 1 : 0]).toMatchObject({ lit: false, state: 'rest' })
    }
  })

  it('names the seats by role, and the second of two of a kind gets the other color', () => {
    const v = sky(play(chatOf('reviews'), [T0, say()], [T0 + 1, { type: 'turn.started', turnId: 't' }]), undefined, T0 + 5)
    expect(v.seats.map((x) => [x.name, x.role, x.second])).toEqual([['Reviewer 1', 'reviewer', false], ['Reviewer 2', 'reviewer', true]])
    const b = sky(scenario('build', 0, 'build'), undefined, T0 + 5)
    expect(b.seats.map((x) => [x.name, x.role, x.second])).toEqual([['Builder', 'builder', false], ['Reviewer', 'reviewer', false]])
  })

  it('does not throw for any pattern with no items, no child, a child with no items, or a loaded-looking child that was deleted', () => {
    for (const pattern of MOON_PATTERN_ORDER) {
      for (const seat of [0, 1] as const) {
        const s = { ...chatOf(pattern), status: 'working' as const, moonsTurn: { seat, step: 'build' as const } }
        for (const kid of [undefined, blank('kid'), blank('kid', { loaded: false })]) {
          expect(() => skyOf(s, kid, T0)).not.toThrow()
          expect(skyOf(s, kid, T0)).not.toBeNull()
        }
      }
    }
  })

  it('thinks, without a scene error, when the other moon’s session is not loaded yet', () => {
    const s = play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 1, step: 'review' }])
    const v = sky(s, undefined, T0 + 5)
    expect(v.seats.map((x) => x.state)).toEqual(['rest', 'think'])
    expect(v.scenes[0]).toEqual({ kind: 'think', words: [] })
  })
})

describe('the plan', () => {
  it('shows the plan being drawn by the Planner, and waits on the plan’s own question with the chat’s request', () => {
    let s = play(chatOf('plan'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 0, step: 'plan' }])
    s = play(s, [T0 + 2, { type: 'moons.plan', id: 'p1', say: 'Here is the plan.', steps: ['Save in UTC', 'Show in the reader’s zone'] }])
    const drawing = sky(s, blank('kid'), T0 + 3)
    expect(drawing.seats[0].state).toBe('edit')
    expect(drawing.scenes[0]).toEqual({ kind: 'plan', steps: ['Save in UTC', 'Show in the reader’s zone'] })
    expect(drawing.caption).toBe('Planner is drawing the plan')
    const asked = play(s, [T0 + 4, { type: 'approval.requested', requestId: 'plan-q', kind: 'other', title: 'Build it this way', detail: '1. Save in UTC' }])
    const v = sky(asked, blank('kid'), T0 + 5)
    expect(v).toMatchObject({ lit: 0, step: 1, still: true, caption: 'Planner is waiting for you' })
    expect(v.scenes[0]).toMatchObject({ kind: 'wait', buttons: 'answer', requestId: 'plan-q', sessionId: 'chat', question: 'Build it this way?' })
  })

  it('shows the first step of a plan in the question, and counts the rest, so lines do not run into each other', () => {
    let s = play(chatOf('plan'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 0, step: 'plan' }])
    s = play(s, [T0 + 2, { type: 'approval.requested', requestId: 'plan-q', kind: 'other', title: 'Build it this way', detail: '1. Save in UTC\n2. Show it\n3. Test it' }])
    expect(sky(s, blank('kid'), T0 + 3).scenes[0]).toMatchObject({ kind: 'wait', detail: '1. Save in UTC (and 2 more)' })
  })
})

describe('two reviews', () => {
  it('shows both at once, each with its own scene, until the comparison arrives', () => {
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, start('r', 'read', 'Read cart.ts')])
    const s = play(chatOf('reviews'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 0, step: 'review' }], [T0 + 2, start('c', 'shell', 'git diff', 'git diff')])
    const v = sky(s, kid, T0 + 5)
    expect(v).toMatchObject({ mode: 'two', lit: 'both', step: 0, conj: false, caption: 'Both are reviewing, without seeing each other' })
    expect(v.seats.map((x) => x.state)).toEqual(['run', 'lens'])
    expect(v.scenes.map((x) => x?.kind)).toEqual(['run', 'lens'])
  })

  it('says one of them waits for the person, and that one wins the caption', () => {
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, { type: 'approval.requested', requestId: 'k', kind: 'shell', title: 'x', detail: 'x' }])
    const s = play(chatOf('reviews'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 0, step: 'review' }])
    const v = sky(s, kid, T0 + 5)
    expect(v).toMatchObject({ caption: 'Reviewer 2 is waiting for you', still: true })
    expect(v.seats[1].state).toBe('wait')
  })

  it('lets a reviewer that has answered rest while the other goes on', () => {
    const kid = play(blank('kid'), [T0, say('Review it')], [T0 + 1, { type: 'turn.started', turnId: 'k' }], [T0 + 2, { type: 'message.delta', text: 'No problems.' }], [T0 + 3, { type: 'turn.completed', turnId: 'k' }])
    expect(kid.status).toBe('idle')
    const s = play(chatOf('reviews'), [T0, say()], [T0 + 1, { type: 'turn.started', turnId: 't' }])
    const v = sky(s, kid, T0 + 5)
    expect(v.seats.map((x) => [x.state, x.lit])).toEqual([['think', true], ['idle', false]])
  })

  it('brings the moons together for the comparison, with the counts and what only each found', () => {
    const s = play(
      chatOf('reviews'),
      [T0, say()],
      [T0 + 1, { type: 'moons.turn', seat: 0, step: 'review' }],
      [T0 + 2, { type: 'moons.compared', both: [{ text: 'Twice' }, { text: 'NaN' }], first: [{ text: 'The currency is fixed to USD' }], second: [{ text: 'The test never awaits' }, { text: 'Another' }] }]
    )
    const v = sky(s, blank('kid'), T0 + 5)
    expect(v).toMatchObject({ mode: 'two', conj: true, step: 1, still: true, caption: 'Comparing what they found' })
    expect(v.scenes[0]).toEqual({ kind: 'compare', both: 2, first: 1, second: 2, rows: ['The currency is fixed to USD'] })
    expect(v.scenes[1]).toEqual({ kind: 'compare', both: 2, first: 1, second: 2, rows: ['The test never awaits', 'Another'] })
    const ended = play(s, [T0 + 3, { type: 'moons.ended', why: 'agreed' }])
    const done = sky(ended, blank('kid'), T0 + 10, T0 + 3 + 7)
    expect(done).toMatchObject({ mode: 'two', conj: true, done: true, caption: 'Both reviews are in' })
    expect(done.scenes[0]).toEqual({ kind: 'compare', both: 2, first: 1, second: 2, rows: ['The currency is fixed to USD'] })
  })
})

describe('hand-overs', () => {
  it('names the hand-over for 1.8 seconds, with the names of the two seats and what was handed', () => {
    const s = play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'moons.handed', from: 1, to: 0, what: '2 notes' }], [T0 + 2, { type: 'moons.turn', seat: 0, step: 'fix' }])
    const v = sky(s, blank('kid'), T0 + 500)
    expect(v.caption).toBe('Reviewer is handing 2 notes to Builder')
    expect(v.lit).toBe(0)
    expect(v.until).toBe(T0 + 1 + HAND_MS)
    expect(sky(s, blank('kid'), T0 + 1 + HAND_MS).caption).toBe('Builder is thinking')
    // A hand-over from an old run is no news.
    expect(sky(s, blank('kid'), T0 + 60_000).caption).toBe('Builder is thinking')
  })

  it('lets the person’s wait win over the hand-over caption', () => {
    const s = play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'moons.handed', from: 1, to: 0, what: '2 notes' }], [T0 + 2, { type: 'moons.turn', seat: 0, step: 'fix' }], [T0 + 3, { type: 'approval.requested', requestId: 'q', kind: 'edit', title: 'Edit x', detail: 'x' }])
    expect(sky(s, blank('kid'), T0 + 500).caption).toBe('Builder is waiting for you')
  })
})

describe('the end', () => {
  const finished = () => play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 0, step: 'build' }], [T0 + 2, start('e', 'edit', 'Edit a.ts')], [T0 + 3, { type: 'tool.completed', id: 'e', ok: true, diff: [LOGIN] }], [T0 + 4, { type: 'moons.handed', from: 0, to: 1, what: '1 file' }], [T0 + 5, { type: 'moons.said', seat: 1, id: 'n1', text: 'Fine.', to: 'person' }])

  it('shows both agree for 4 seconds after a run that ended well, from when the chat became idle', () => {
    const s = play(finished(), [T0 + 6, { type: 'moons.ended', why: 'agreed' }])
    expect(s.status).toBe('idle')
    const v = sky(s, blank('kid'), T0 + 7000, T0 + 7000)
    expect(v).toMatchObject({ mode: 'both', lit: 'both', still: true, done: true, caption: 'Both agree it is done', step: 4, until: T0 + 7000 + DONE_MS })
    expect(v.seats.map((x) => [x.state, x.lit])).toEqual([['done', true], ['done', true]])
    expect(v.scenes[0]).toEqual({ kind: 'done', title: 'Both agree it is done.', text: '1 file, 3 lines changed' })
    expect(skyOf(s, blank('kid'), T0 + 7000 + DONE_MS, { idleSince: T0 + 7000 })).toBeNull()
    expect(skyOf(s, blank('kid'), T0 + 7000 + DONE_MS - 1, { idleSince: T0 + 7000 })).not.toBeNull()
  })

  it('counts the notes that were fixed', () => {
    let s = play(finished(), [T0 + 5, { type: 'moons.said', seat: 1, id: 'f1', text: 'A', file: 'a.ts', line: 1, finding: true }], [T0 + 5, { type: 'moons.fixed', ids: ['f1'] }])
    s = play(s, [T0 + 6, { type: 'moons.ended', why: 'agreed' }])
    const scene = sky(s, undefined, T0 + 100, T0 + 100).scenes[0]
    expect(scene).toMatchObject({ kind: 'done', text: '1 file, 3 lines changed, 1 note fixed' })
  })

  it('takes the time from the items when the caller gives none, and is gone for an old chat', () => {
    const s = play(finished(), [T0 + 6, { type: 'moons.ended', why: 'agreed' }])
    expect(skyOf(s, undefined, T0 + 1000)).not.toBeNull()
    expect(skyOf(s, undefined, T0 + 60_000)).toBeNull()
  })

  it('is not shown for a run that ended any other way, or that did nothing', () => {
    for (const why of ['rounds', 'declined', 'stopped', 'failed', 'unread'] as const) {
      const s = play(finished(), [T0 + 6, { type: 'moons.ended', why, note: 'x' }])
      expect(skyOf(s, undefined, T0 + 100, { idleSince: T0 + 100 }), why).toBeNull()
    }
    const nothing = play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'moons.turn', seat: 0, step: 'build' }], [T0 + 2, { type: 'moons.ended', why: 'nothing' }])
    expect(skyOf(nothing, undefined, T0 + 100, { idleSince: T0 + 100 })).toBeNull()
  })

  it('is shown for an agreed run that has a line to say, too', () => {
    const s = play(chatOf('bug'), [T0, say()], [T0 + 1, { type: 'moons.ended', why: 'agreed', note: 'It did not fail.' }])
    expect(skyOf(s, undefined, T0 + 100, { idleSince: T0 + 100 })).not.toBeNull()
  })
})

describe('the key', () => {
  it('stays the same while nothing a person can see changes, and changes when it does', () => {
    const s = play(chatOf('build'), [T0, say()], [T0 + 1, { type: 'turn.started', turnId: 't' }])
    const a = sky(s, undefined, T0 + 100)
    const b = sky(s, undefined, T0 + 5000)
    expect(a.key).toBe(b.key)
    const c = play(s, [T0 + 6000, start('x', 'shell', 'ls', 'ls')])
    expect(sky(c, undefined, T0 + 6100).key).not.toBe(a.key)
  })
})

describe('small helpers', () => {
  it('finds the file of a tool from its diff, its JSON input, or its title', () => {
    const t = (over: object) => ({ kind: 'tool' as const, id: 'x', tool: 'read' as const, title: '', output: '', status: 'ok' as const, startedAt: 0, ...over })
    expect(fileOfTool(t({ diff: [LOGIN] }))).toBe('src/auth/login.ts')
    expect(fileOfTool(t({ input: JSON.stringify({ file_path: 'a/b.ts' }) }))).toBe('a/b.ts')
    expect(fileOfTool(t({ title: 'Read src/x.tsx' }))).toBe('src/x.tsx')
    expect(fileOfTool(t({ title: 'Searching' }))).toBe('')
  })

  it('compares files without regard to slashes, case or the folder', () => {
    expect(sameFile('src\\Auth\\login.ts', 'src/auth/login.ts')).toBe(true)
    expect(sameFile('C:\\app\\src\\login.ts', 'src/login.ts')).toBe(true)
    expect(sameFile('login.ts', 'logout.ts')).toBe(false)
    expect(sameFile('', 'a')).toBe(false)
  })

  it('joins the diffs of one file changed twice, in the order the files first appeared', () => {
    const s = play(
      chatOf('build'),
      [T0, say()],
      [T0 + 1, start('a', 'edit', 'Edit')],
      [T0 + 2, { type: 'tool.completed', id: 'a', ok: true, diff: [diff('b.ts', [['add', 'x', 1]])] }],
      [T0 + 3, start('b', 'edit', 'Edit')],
      [T0 + 4, { type: 'tool.completed', id: 'b', ok: true, diff: [diff('a.ts', [['add', 'y', 1]]), diff('b.ts', [['del', 'z']])] }]
    )
    const merged = mergeDiffs(s.items)
    expect(merged.map((d) => [d.path, d.added, d.removed, d.hunks.length])).toEqual([['b.ts', 1, 1, 2], ['a.ts', 1, 0, 1]])
  })
})
