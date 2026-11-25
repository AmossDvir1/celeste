import type { FileDiff, ToolKind } from '@shared/agent'
import { PATTERNS, moonName, type MoonPattern, type MoonRole, type MoonStep, type Seat } from '@shared/moons'
import { basename } from '@/lib/format'
import type { Session, TimelineItem } from '@/stores/types'
import type { MoonState } from './types'

/*
 * What the sky shows, worked out from the chat and from the other moon's own session. Pure: no React and no canvas, and the time is always passed in,
 * so every state is tested without timers. Everything here is read from what the agents really did; where a tool gives no lines (Copilot may give only
 * file names) the scene names the file and nothing is made up.
 */

type Tool = Extract<TimelineItem, { kind: 'tool' }>
type Approval = Extract<TimelineItem, { kind: 'approval' }>
type Ask = Extract<TimelineItem, { kind: 'ask' }>

export interface SceneLine {
  k: 'ctx' | 'add' | 'del'
  text: string
  /** The line's number in the new file (absent for a deleted line). */
  no?: number
}

export type Scene =
  | { kind: 'think'; words: string[] }
  | { kind: 'read'; title: string; lines: string[] }
  | { kind: 'edit'; /** Changes when a new diff lands, so the lines are typed in again. */ key: string; file: string; lines: SceneLine[]; added: number; removed: number }
  | { kind: 'run'; command: string; output: string[] }
  | { kind: 'lens'; file: string; lines: SceneLine[]; marks: { row: number; text: string }[] }
  | { kind: 'wait'; /** What the buttons do: answer here, or open the chat that holds the full card. */ buttons: 'answer' | 'open'; question: string; title: string; detail: string; allow: string; requestId: string; sessionId: string }
  | { kind: 'plan'; steps: string[] }
  | { kind: 'compare'; both: number; first: number; second: number; /** What only this moon found, shortened. */ rows: string[] }
  | { kind: 'done'; title: string; text: string }

export interface SkySeat {
  seat: Seat
  role: MoonRole
  name: string
  /** The second of two moons with the same role takes the other color. */
  second: boolean
  state: MoonState
  /** It is the one working (or, in two and both, a working one). */
  lit: boolean
}

export interface SkyView {
  /** one: one works and the other rests. two: both work, each with a scene. both: both are shown together (the end). */
  mode: 'one' | 'two' | 'both'
  lit: Seat | 'both'
  seats: [SkySeat, SkySeat]
  caption: string
  /** Nothing is working, so the caption does not shimmer. */
  still: boolean
  /** Where in the pattern's track it is. The track's length means all of it is behind. -1: none. */
  step: number
  track: string[]
  /** One scene (mode one and both), or one for each seat (two). A seat may have none. */
  scenes: (Scene | null)[]
  /** The two reviews are being compared: the moons come together. */
  conj: boolean
  /** The 4 seconds after a run that ended well. */
  done: boolean
  /** When this view changes by the clock alone (a moment that ends), so the caller knows when to look again. */
  until: number | null
  /** Equal for views that look the same, so React is touched only when something changed. */
  key: string
}

/** What the caller has seen that the items do not say: when the chat became idle. Without it the newest time in the run's items stands in. */
export interface SkyContext {
  idleSince?: number | null
}

export const EDIT_MOMENT_MS = 1600
export const HAND_MS = 1800
export const DONE_MS = 4000
/** Two reviews end the moment they are compared, so what both found is shown for this long after. */
export const COMPARE_MS = 7000
const LINES_MAX = 8
const CAPTION_COMMAND_MAX = 60

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The folder's part of a path is dropped, and the other way of writing the slash is understood. */
const norm = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
export function sameFile(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = norm(a)
  const y = norm(b)
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

/** The index where the current run's items begin: right after the person's last message (or, in the other moon, the one Celeste sent it). */
function sinceIndex(items: TimelineItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'user') return i + 1
  return 0
}

const KEY_NAMES = ['file_path', 'path', 'filePath', 'file', 'filename', 'notebook_path']

/** The file a tool works on: from its diff, from its input when that is JSON, or from the words of its title. Empty when none is known. */
export function fileOfTool(t: Tool): string {
  const first = t.diff?.[0]
  if (first) return first.path
  if (t.input) {
    try {
      const o: unknown = JSON.parse(t.input)
      if (o && typeof o === 'object') {
        for (const k of KEY_NAMES) {
          const v = (o as Record<string, unknown>)[k]
          if (typeof v === 'string' && v) return v
        }
      }
    } catch {
      /* not JSON: the title may name it */
    }
  }
  const m = /([\w@.\-/\\]+\.[A-Za-z0-9]{1,8})(?![\w.])/.exec(t.title)
  return m ? (m[1] as string) : ''
}

/** The command a shell tool runs: its input when that is plain text, else its title. */
function commandOf(t: Tool): string {
  const input = (t.input ?? '').trim()
  if (input && !input.startsWith('{') && !input.startsWith('[')) return input.replace(/\s+/g, ' ')
  if (input.startsWith('{')) {
    try {
      const o = JSON.parse(input) as Record<string, unknown>
      for (const k of ['command', 'cmd', 'script']) if (typeof o[k] === 'string' && o[k]) return (o[k] as string).replace(/\s+/g, ' ').trim()
    } catch {
      /* use the title */
    }
  }
  return t.title.replace(/\s+/g, ' ').trim()
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

function tail(output: string, n: number): string[] {
  return output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  ').trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .map((l) => cut(l, 120))
}

function head(output: string, n: number): string[] {
  return output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '  ').trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(0, n)
    .map((l) => cut(l, 120))
}

function flatLines(diff: FileDiff): SceneLine[] {
  const out: SceneLine[] = []
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      const text = l.text.replace(/\t/g, '  ')
      out.push(l.type === 'del' ? { k: 'del', text } : { k: l.type, text, ...(l.newNo !== undefined ? { no: l.newNo } : {}) })
    }
  }
  return out
}

/** Eight lines (or what fits) with one line of context before the change, or around a chosen line. */
function windowOf(lines: SceneLine[], center?: number): SceneLine[] {
  if (lines.length <= LINES_MAX) return lines
  const at = center ?? Math.max(0, lines.findIndex((l) => l.k !== 'ctx'))
  const start = Math.min(Math.max(0, at - 1), lines.length - LINES_MAX)
  return lines.slice(start, start + LINES_MAX)
}

/** The diffs of the tools in these items, one entry for each file (in the order the files first appeared), a file changed twice with its hunks joined. */
export function mergeDiffs(items: TimelineItem[]): FileDiff[] {
  const byPath = new Map<string, FileDiff>()
  for (const it of items) {
    if (it.kind !== 'tool' || !it.diff) continue
    for (const d of it.diff) {
      const known = byPath.get(d.path)
      if (!known) byPath.set(d.path, { ...d, hunks: [...d.hunks] })
      else byPath.set(d.path, { ...known, added: known.added + d.added, removed: known.removed + d.removed, hunks: [...known.hunks, ...d.hunks], binary: known.binary || d.binary, truncated: known.truncated || d.truncated })
    }
  }
  return [...byPath.values()]
}

function editScene(t: Tool): Scene {
  const diff = t.diff?.find((d) => d.hunks.length > 0 && !d.binary && !d.truncated) ?? t.diff?.[0]
  if (!diff) return { kind: 'edit', key: t.id, file: basename(fileOfTool(t)), lines: [], added: 0, removed: 0 }
  return { kind: 'edit', key: `${t.id}:d`, file: basename(diff.path), lines: windowOf(flatLines(diff)), added: diff.added, removed: diff.removed }
}

function readScene(t: Tool): Scene {
  const file = fileOfTool(t)
  const title = file ? basename(file) : cut(t.title.replace(/^(Read|Search|Fetch)\s+/i, ''), 60)
  return { kind: 'read', title: title || 'something', lines: t.tool === 'read' ? head(t.output, LINES_MAX) : [] }
}

function runScene(t: Tool): Scene {
  return { kind: 'run', command: cut(commandOf(t), 120), output: tail(t.output, 4) }
}

/** What a tool touched, in a word or two: what was looked for, the file, the command. */
function touched(it: Tool): string {
  const looked = it.tool === 'search' ? /^Search(?:ed|ing)?(?: for)?\s+["“']?(.+?)["”']?$/i.exec(it.title.replace(/\s+/g, ' ').trim()) : null
  if (looked) return `“${cut(looked[1]!, 30)}”`
  if (it.tool === 'web') return 'the web'
  if (it.tool === 'shell') return cut(commandOf(it), 32)
  return basename(fileOfTool(it)) || cut(it.title, 32)
}

function thinkScene(since: TimelineItem[]): Scene {
  const words: string[] = []
  for (const it of since) {
    if (it.kind !== 'tool') continue
    const word = touched(it)
    if (word && !words.includes(word)) words.push(word)
  }
  return { kind: 'think', words: words.slice(-7) }
}

interface Finding {
  text: string
  file?: string
  line?: number
}

function findingsOf(items: TimelineItem[]): Finding[] {
  const out: Finding[] = []
  for (const it of items) {
    if (it.kind !== 'moonsTalk') continue
    for (const m of it.messages) if (m.finding) out.push({ text: m.text, ...(m.file ? { file: m.file } : {}), ...(m.line !== undefined ? { line: m.line } : {}) })
  }
  return out
}

/** The change under review: the pen's diffs, the first file or the one the reviewer is reading; marks only where a finding's line is on show. */
function lensScene(chatSince: TimelineItem[], reading: Tool | undefined): Scene {
  const diffs = mergeDiffs(chatSince)
  const readFile = reading ? fileOfTool(reading) : ''
  const diff = (readFile ? diffs.find((d) => sameFile(d.path, readFile)) : undefined) ?? diffs.find((d) => d.hunks.length > 0) ?? diffs[0]
  if (!diff) {
    // Nothing was written (two reviews, or a reviewer looking at files): the lines it reads, if the tool gave them.
    const lines: SceneLine[] = reading ? head(reading.output, LINES_MAX).map((text) => ({ k: 'ctx' as const, text })) : []
    return { kind: 'lens', file: readFile ? basename(readFile) : '', lines, marks: [] }
  }
  const all = flatLines(diff)
  const found = findingsOf(chatSince).filter((f) => f.file && f.line !== undefined && sameFile(f.file, diff.path))
  const firstMarked = found.map((f) => all.findIndex((l) => l.no === f.line)).find((i) => i >= 0)
  const lines = windowOf(all, firstMarked)
  const marks: { row: number; text: string }[] = []
  for (const f of found) {
    const row = lines.findIndex((l) => l.no === f.line)
    if (row >= 0 && !marks.some((m) => m.row === row)) marks.push({ row, text: cut(f.text, 40) })
  }
  return { kind: 'lens', file: basename(diff.path), lines, marks }
}

type Pending = { item: Approval | Ask; sessionId: string }

function pendingOf(s: Session | undefined, since: TimelineItem[]): Pending | undefined {
  if (!s) return undefined
  for (let i = since.length - 1; i >= 0; i--) {
    const it = since[i]!
    if ((it.kind === 'approval' || it.kind === 'ask') && it.status === 'pending') return { item: it, sessionId: s.id }
  }
  return undefined
}

const WANTS: Partial<Record<ToolKind, string>> = {
  shell: 'wants to run a command.',
  edit: 'wants to change files.',
  write: 'wants to create a file.',
  web: 'wants to use the web.',
  read: 'wants to read a file.',
  mcp: 'wants to call a tool.',
  agent: 'wants to start a helper.'
}

function waitScene(p: Pending, name: string): Scene {
  if (p.item.kind === 'ask') {
    const q = p.item.questions[0]
    const options = (q?.options ?? []).map((o) => o.label).join(', ')
    return { kind: 'wait', buttons: 'open', question: cut(q?.question ?? `${name} has a question.`, 120), title: '', detail: cut(options, 120), allow: 'Allow', requestId: p.item.requestId, sessionId: p.sessionId }
  }
  const a = p.item
  const plain = !a.slider && !a.proposal
  const question = a.tool === 'other' ? (a.title.endsWith('?') ? a.title : `${a.title}?`) : `${name} ${WANTS[a.tool] ?? 'asks for your approval.'}`
  // The steps of a plan come as lines. In the one line this scene has they would run into each other, so the first one is shown and the rest counted.
  const lines = (a.detail ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const detail = lines.length > 1 ? `${cut(lines[0]!, 100)} (and ${lines.length - 1} more)` : cut(lines[0] ?? '', 160)
  return { kind: 'wait', buttons: plain ? 'answer' : 'open', question: cut(question, 120), title: a.tool === 'other' ? '' : cut(a.detail ?? a.title, 120), detail: a.tool === 'other' ? detail : '', allow: a.choices?.allow ?? 'Allow', requestId: a.requestId, sessionId: p.sessionId }
}

interface Work {
  state: MoonState
  scene: Scene | null
  /** The words after the name in the caption: "is editing login.ts". */
  doing: string
  until: number | null
}

interface Look {
  role: MoonRole
  name: string
  /** Its own session (the chat for the pen, the helper for the other), when it is loaded. */
  own: Session | undefined
  chatSince: TimelineItem[]
  pending: Pending | undefined
  planSteps: string[] | undefined
  now: number
}

function workOf(l: Look): Work {
  if (l.pending) return { state: 'wait', scene: waitScene(l.pending, l.name), doing: 'is waiting for you', until: null }
  const items = l.own?.items ?? []
  const since = items.slice(sinceIndex(items))
  const reviewer = l.role === 'reviewer'
  let running: Tool | undefined
  let last: Tool | undefined
  for (let i = since.length - 1; i >= 0; i--) {
    const it = since[i]!
    if (it.kind !== 'tool') continue
    last ??= it
    if (it.status === 'running') {
      running = it
      break
    }
  }
  if (running) {
    const file = fileOfTool(running)
    switch (running.tool) {
      case 'read':
      case 'search':
      case 'web':
        if (reviewer) return { state: 'lens', scene: lensScene(l.chatSince, running), doing: 'is checking the change', until: null }
        return {
          state: 'read',
          scene: readScene(running),
          doing: running.tool === 'read' ? (file ? `is reading ${basename(file)}` : 'is reading') : running.tool === 'search' ? 'is looking through the project' : 'is looking something up',
          until: null
        }
      case 'edit':
      case 'write':
        return { state: 'edit', scene: editScene(running), doing: file ? `is ${running.tool === 'write' ? 'creating' : 'editing'} ${basename(file)}` : running.tool === 'write' ? 'is creating a file' : 'is editing files', until: null }
      default: {
        const command = cut(commandOf(running), CAPTION_COMMAND_MAX)
        return { state: 'run', scene: runScene(running), doing: running.tool === 'shell' ? `is running ${command}` : `is working with ${cut(running.title, 40)}`, until: null }
      }
    }
  }
  if (last && (last.tool === 'edit' || last.tool === 'write') && last.status === 'ok' && last.diff?.length && last.endedAt !== undefined && l.now - last.endedAt < EDIT_MOMENT_MS) {
    const file = fileOfTool(last)
    return { state: 'edit', scene: editScene(last), doing: file ? `is editing ${basename(file)}` : 'is editing files', until: last.endedAt + EDIT_MOMENT_MS }
  }
  if (l.role === 'planner' && l.planSteps?.length) return { state: 'edit', scene: { kind: 'plan', steps: l.planSteps.slice(0, 6).map((s) => cut(s, 70)) }, doing: 'is drawing the plan', until: null }
  if (reviewer && mergeDiffs(l.chatSince).length) return { state: 'lens', scene: lensScene(l.chatSince, undefined), doing: 'is checking the change', until: null }
  return { state: 'think', scene: thinkScene(since), doing: 'is thinking', until: null }
}

/** When no turn has been recorded yet but the chat works, it is the pen's first step. */
const penFirstStep: Record<MoonPattern, MoonStep> = { build: 'build', plan: 'build', bug: 'fix', reviews: 'review' }

const STEP_INDEX: Record<MoonPattern, Partial<Record<MoonStep, number>>> = {
  build: { build: 0, review: 1, fix: 2, check: 3 },
  plan: { plan: 0, build: 2 },
  bug: { test: 0, fix: 1, retest: 2 },
  reviews: { review: 0, compare: 1, answer: 0 }
}

function stepIndex(pattern: MoonPattern, step: MoonStep, waiting: boolean, hasPlan: boolean): number {
  if (step === 'answer') return -1
  if (pattern === 'plan' && step === 'plan' && waiting && hasPlan) return 1
  return STEP_INDEX[pattern][step] ?? -1
}

function summary(chatSince: TimelineItem[]): string {
  const diffs = mergeDiffs(chatSince)
  const parts: string[] = []
  if (diffs.length) parts.push(plural(diffs.length, 'file'), `${plural(diffs.reduce((n, d) => n + d.added + d.removed, 0), 'line')} changed`)
  let fixed = 0
  for (const it of chatSince) if (it.kind === 'moonsTalk') fixed += it.messages.filter((m) => m.fixed).length
  if (fixed) parts.push(`${plural(fixed, 'note')} fixed`)
  return parts.join(', ')
}

/** The newest time the items themselves tell (a message, a hand-over, the end of a tool), or null. */
function lastTime(items: TimelineItem[]): number | null {
  let t: number | null = null
  const see = (x: number | undefined) => {
    if (x !== undefined && (t === null || x > t)) t = x
  }
  for (const it of items) {
    if (it.kind === 'tool') see(it.endedAt ?? it.startedAt)
    else if (it.kind === 'moonsHand') see(it.at)
    else if (it.kind === 'moonsTalk') for (const m of it.messages) see(m.at)
  }
  return t
}

function finish(v: Omit<SkyView, 'key'>): SkyView {
  const { until: _until, ...rest } = v
  return { ...v, key: JSON.stringify(rest) }
}

/** The sky for this chat at this moment, or null when nothing is going on (the chat is idle), except for 4 seconds after a run that ended well. */
export function skyOf(session: Session, child: Session | undefined, now: number, ctx: SkyContext = {}): SkyView | null {
  const moons = session.moons
  if (!moons) return null
  const pat = PATTERNS[moons.pattern]
  if (!pat) return null
  const pattern = moons.pattern
  const pen = pat.pen
  const names: [string, string] = [moonName(pattern, 0), moonName(pattern, 1)]
  const second = (seat: Seat) => seat === 1 && pat.roles[0] === pat.roles[1]
  const mk = (seat: Seat, state: MoonState, lit: boolean): SkySeat => ({ seat, role: pat.roles[seat], name: names[seat], second: second(seat), state, lit })

  // The two reviews side by side: what only each found, and what both did.
  const compareView = (c: Extract<TimelineItem, { kind: 'moonsCompare' }>, caption: string, until: number | null): SkyView => {
    const rows = (list: { text: string }[]) => list.slice(0, 3).map((f) => cut(f.text, 60))
    const counts = { both: c.both.length, first: c.first.length, second: c.second.length }
    return finish({
      mode: 'two',
      lit: 'both',
      seats: [mk(0, 'agree', true), mk(1, 'agree', true)],
      caption,
      still: true,
      step: until === null ? 1 : pat.track.length,
      track: pat.track,
      scenes: [{ kind: 'compare', ...counts, rows: rows(c.first) }, { kind: 'compare', ...counts, rows: rows(c.second) }],
      conj: true,
      done: until !== null,
      until
    })
  }

  const chatSince = session.items.slice(sinceIndex(session.items))
  let compared: Extract<TimelineItem, { kind: 'moonsCompare' }> | undefined
  let handItem: Extract<TimelineItem, { kind: 'moonsHand' }> | undefined
  let planItem: Extract<TimelineItem, { kind: 'moonsPlan' }> | undefined
  let ended: Extract<TimelineItem, { kind: 'moonsEnded' }> | undefined
  for (const it of chatSince) {
    if (it.kind === 'moonsCompare') compared = it
    else if (it.kind === 'moonsHand') handItem = it
    else if (it.kind === 'moonsPlan') planItem = it
    else if (it.kind === 'moonsEnded') ended = it
  }

  if (session.status === 'idle') {
    // The moment after a run that ended well: both together, and the sky closes when it is over. A run that ended well and had nothing to add leaves
    // no line (the reducer draws none), so it is told by what happened in it: the moons handed work over, compared, or an agreed plan was built. Words
    // alone are not enough: a question to one of them ends with an answer, and nobody agreed on anything.
    const wellEnded = ended ? ended.why === 'agreed' : !!handItem || !!compared || chatSince.some((i) => i.kind === 'moonsPlan' && i.agreed)
    const since = ctx.idleSince ?? lastTime(chatSince)
    const lasts = compared ? COMPARE_MS : DONE_MS
    if (!wellEnded || since == null || now < since || now - since >= lasts) return null
    if (compared) return compareView(compared, 'Both reviews are in', since + lasts)
    const caption = 'Both agree it is done'
    return finish({
      mode: 'both',
      lit: 'both',
      seats: [mk(0, 'done', true), mk(1, 'done', true)],
      caption,
      still: true,
      step: pat.track.length,
      track: pat.track,
      scenes: [{ kind: 'done', title: `${caption}.`, text: summary(chatSince) }],
      conj: false,
      done: true,
      until: since + DONE_MS
    })
  }

  const seatNow: Seat = session.moonsTurn?.seat ?? pen
  const step: MoonStep = session.moonsTurn?.step ?? penFirstStep[pattern]
  const sessionOf = (seat: Seat): Session | undefined => (seat === pen ? session : child)
  const pendingFor = (seat: Seat): Pending | undefined => {
    const own = sessionOf(seat)
    const ownItems = own?.items ?? []
    return pendingOf(own, ownItems.slice(sinceIndex(ownItems))) ?? (seat !== pen ? pendingOf(session, chatSince) : undefined)
  }
  const lookAt = (seat: Seat): Look => ({ role: pat.roles[seat], name: names[seat], own: sessionOf(seat), chatSince, pending: pendingFor(seat), planSteps: planItem?.steps, now })
  const untilOf = (...ws: Work[]): number | null => {
    const times = ws.map((w) => w.until).filter((t): t is number => t !== null)
    return times.length ? Math.min(...times) : null
  }

  // A hand-over of a moment ago is named in the caption.
  const handCaption = (): { text: string; until: number } | null => {
    if (!handItem || now < handItem.at || now - handItem.at >= HAND_MS) return null
    return { text: `${names[handItem.from]} is handing ${handItem.what} to ${names[handItem.to]}`, until: handItem.at + HAND_MS }
  }
  const earliest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b))

  if (pattern === 'reviews') {
    if (compared) return compareView(compared, 'Comparing what they found', null)
    const w = [workOf(lookAt(0)), workOf(lookAt(1))]
    // A reviewer that has already answered (its own turn is over) waits for the other without a scene.
    const finished = child && child.loaded && child.status === 'idle' && child.items.slice(sinceIndex(child.items)).some((i) => i.kind === 'assistant')
    const seat1: Work = finished && w[1]!.state !== 'wait' ? { state: 'idle', scene: null, doing: 'is done', until: null } : w[1]!
    const waiting = w[0]!.state === 'wait' ? 0 : seat1.state === 'wait' ? 1 : -1
    const hand = handCaption()
    const caption = waiting >= 0 ? `${names[waiting as Seat]} is waiting for you` : (hand?.text ?? 'Both are reviewing, without seeing each other')
    return finish({
      mode: 'two',
      lit: 'both',
      seats: [mk(0, w[0]!.state, true), mk(1, seat1.state, seat1.state !== 'idle')],
      caption,
      still: waiting >= 0,
      step: stepIndex(pattern, 'review', false, false),
      track: pat.track,
      scenes: [w[0]!.scene, seat1.scene],
      conj: false,
      done: false,
      until: earliest(untilOf(w[0]!, seat1), hand?.until ?? null)
    })
  }

  const w = workOf(lookAt(seatNow))
  const hand = handCaption()
  const seats: [SkySeat, SkySeat] = seatNow === 0 ? [mk(0, w.state, true), mk(1, 'rest', false)] : [mk(0, 'rest', false), mk(1, w.state, true)]
  return finish({
    mode: 'one',
    lit: seatNow,
    seats,
    caption: w.state === 'wait' ? `${names[seatNow]} ${w.doing}` : (hand?.text ?? `${names[seatNow]} ${w.doing}`),
    still: w.state === 'wait',
    step: stepIndex(pattern, step, w.state === 'wait', !!planItem),
    track: pat.track,
    scenes: [w.scene],
    conj: false,
    done: false,
    until: earliest(w.until, hand?.until ?? null)
  })
}
