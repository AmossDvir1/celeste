import type { Effort, VendorId } from './agent'

/*
 * Two Moons: a chat with two agents that take turns on one task (docs/plans/TWO_MOONS_PLAN.md). These are the words, the shapes and the
 * reading of the short structured messages that Core, the window and the phone share. Pure: no Node and no browser.
 */

export type MoonRole = 'planner' | 'builder' | 'reviewer' | 'tester'
export type MoonPattern = 'build' | 'plan' | 'bug' | 'reviews'
/** 0 or 1: first or second in the pattern. */
export type Seat = 0 | 1
export type MoonStep = 'build' | 'review' | 'fix' | 'check' | 'plan' | 'test' | 'retest' | 'compare' | 'answer'

export interface PatternDef {
  id: MoonPattern
  label: string
  /** One sentence for the picker: what happens. */
  says: string
  roles: [MoonRole, MoonRole]
  /** The seat that is the chat's own agent, the only one that may change files (except a Tester, which only runs things). */
  pen: Seat
  /** The phases the sky shows, in order. */
  track: string[]
}

export const PATTERNS: Record<MoonPattern, PatternDef> = {
  build: {
    id: 'build',
    label: 'Build and review',
    says: 'The Builder builds, the Reviewer checks, and the Builder fixes what it found. Two rounds at most.',
    roles: ['builder', 'reviewer'],
    pen: 0,
    track: ['Build', 'Review', 'Fix', 'Check']
  },
  plan: {
    id: 'plan',
    label: 'Plan, then build',
    says: 'The Planner writes a plan. You can change it. Then the Builder builds it.',
    roles: ['planner', 'builder'],
    pen: 1,
    track: ['Plan', 'You agree', 'Build']
  },
  bug: {
    id: 'bug',
    label: 'Find and fix a bug',
    says: 'The Tester makes the bug happen, and the Builder fixes it.',
    roles: ['tester', 'builder'],
    pen: 1,
    track: ['Make it happen', 'Fix', 'Try again']
  },
  reviews: {
    id: 'reviews',
    label: 'Two reviews',
    says: 'Both review without seeing each other, and you see what both found.',
    roles: ['reviewer', 'reviewer'],
    pen: 0,
    track: ['Review apart', 'Compare']
  }
}

export const MOON_PATTERN_ORDER: MoonPattern[] = ['build', 'plan', 'bug', 'reviews']

/** A review or a fix is given up after this many rounds, and what is left is shown. */
export const MAX_ROUNDS = 2
export const MAX_FINDINGS = 12
export const MAX_STEPS = 20
/** What a reviewer is given of the change, in characters. The rest is cut, and it is told so. */
export const DIFF_CHARS = 24_000
/** One text of a reply (a finding, a step, a sentence to the other moon). Longer is cut. */
export const MOON_TEXT_MAX = 600

export function isMoonPattern(value: unknown): value is MoonPattern {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PATTERNS, value)
}

const ROLE_NAMES: Record<MoonRole, string> = { planner: 'Planner', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' }

/** 'Builder'; 'Reviewer 1' and 'Reviewer 2' when both seats have the same role. */
export function moonName(pattern: MoonPattern, seat: Seat): string {
  const roles = PATTERNS[pattern].roles
  const name = ROLE_NAMES[roles[seat]]
  return roles[0] === roles[1] ? `${name} ${seat + 1}` : name
}

/** The seat that is the child session: the one that is not the pen. */
export function otherSeat(pattern: MoonPattern): Seat {
  return PATTERNS[pattern].pen === 0 ? 1 : 0
}

/** Kept on the chat's row (`sessions.moons`, JSON) and in its summary. Vendor, model and effort are those of the chat and of the child. */
export interface MoonsInfo {
  pattern: MoonPattern
  childId: string
}

/** What the window sends when it makes such a chat. Vendor, model and effort are those of the OTHER moon: the chat's own are the pen's. */
export interface MoonsInput {
  pattern: MoonPattern
  vendor: VendorId
  model: string
  effort: Effort | null
}

export interface Finding {
  text: string
  file?: string
  line?: number
  code?: string
}
export interface ReviewReply {
  say: string
  findings: Finding[]
}
export interface FixReply {
  say: string
  answers: { n: number; fixed: boolean; say?: string }[]
}
export interface PlanReply {
  say: string
  steps: string[]
}
export interface TestReply {
  say: string
  failed: boolean
  file?: string
  line?: number
  code?: string
}

// ---- finding the block in a reply ----

interface Scan {
  /** The moons blocks, by the index of their opening line and of the last line they take (the closing fence, or the last line of the text). */
  blocks: { open: number; close: number; content: string; /** The words that were on the opening line before the fence. */ keep?: string }[]
  /** The index of the last line when it is only the start of an opening fence that is still arriving. */
  partial: number
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
// `moons`, then nothing that makes it another word (`moonshot`).
const MOONS_INFO = /^moons(?![\p{L}\p{N}_-])/iu
// Words, then a moons fence that ends the line (nothing after `moons` or `moons json`), so a sentence that merely mentions the block is not taken for one.
const MID_FENCE = /^(.*\S.*?)\s*(`{3,})(moons(?![\p{L}\p{N}_-])[ \t]*(?:json)?)[ \t]*$/iu
// What an opening fence looks like while it is still being typed: three backticks, then some of the letters of `moons`.
const PARTIAL_FENCE = /^ {0,3}```(m(o(o(n(s)?)?)?)?)?$/i

function scan(text: string): Scan {
  const lines = text.split(/\r?\n/)
  const blocks: Scan['blocks'] = []
  let partial = -1
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const open = OPEN_FENCE.exec(line)
    // A model sometimes ends its last sentence with the fence on the same line: "Done. ```moons". The words before it stay.
    const mid = open ? null : MID_FENCE.exec(line)
    if (!open && !mid) {
      i++
      continue
    }
    const fence = (open ? open[1] : mid?.[2]) as string
    const info = ((open ? open[2] : mid?.[3]) as string).trim()
    const keep = mid ? (mid[1] as string).trimEnd() : undefined
    const closing = new RegExp(`^ {0,3}${fence[0] === '~' ? '~' : '`'}{${fence.length},}\\s*$`)
    const moons = MOONS_INFO.test(info)
    // `moons json {…}`: the words of the fence, then maybe the start of the JSON on the same line.
    const rest = moons ? info.replace(MOONS_INFO, '').trim().replace(/^json\b/i, '').trim() : ''
    const content: string[] = rest ? [rest] : []
    let close = lines.length - 1
    let closed = false
    // The fence may also close on the same line as the JSON: `{…}` followed by three backticks.
    const inlineClose = (s: string): string | null => (s.trim().endsWith(fence) && s.trim() !== fence ? s.trim().slice(0, -fence.length) : null)
    if (moons && rest) {
      const cut = inlineClose(rest)
      if (cut !== null) {
        content[0] = cut
        close = i
        closed = true
      }
    }
    let j = i + 1
    while (!closed && j < lines.length) {
      const body = lines[j] as string
      if (closing.test(body)) {
        close = j
        closed = true
        break
      }
      const cut = moons ? inlineClose(body) : null
      if (cut !== null) {
        content.push(cut)
        close = j
        closed = true
        break
      }
      content.push(body)
      j++
    }
    if (moons) blocks.push({ open: i, close, content: content.join('\n'), ...(keep ? { keep } : {}) })
    i = closed ? close + 1 : lines.length
  }
  // A fence that is only just starting at the very end of the text, outside every block.
  const lastIndex = lines.length - 1
  const last = lines[lastIndex] as string
  const insideBlock = blocks.some((b) => b.open <= lastIndex && lastIndex <= b.close)
  if (!insideBlock && PARTIAL_FENCE.test(last) && !hasOpenOtherBlock(lines)) partial = lastIndex
  return { blocks, partial }
}

/** Whether the last line is inside a code fence of another language that has not closed yet (so a lone fence there is its end, not a start). */
function hasOpenOtherBlock(lines: string[]): boolean {
  let open: RegExp | null = null
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] as string
    if (open) {
      if (open.test(line)) open = null
      continue
    }
    const m = OPEN_FENCE.exec(line)
    if (m) {
      const fence = m[1] as string
      open = new RegExp(`^ {0,3}${fence[0] === '~' ? '~' : '`'}{${fence.length},}\\s*$`)
    }
  }
  return open !== null
}

/** The last ```moons block of a text, parsed, or undefined. Tolerates a fence cut short and `json` after the word; trailing commas are not tolerated. */
export function readBlock(text: string): unknown {
  const blocks = scan(text).blocks
  const last = blocks[blocks.length - 1]
  if (!last) return undefined
  try {
    const value: unknown = JSON.parse(last.content.trim())
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The text without any ```moons block, also one that is still arriving. What the window shows. */
export function withoutBlock(text: string): string {
  const found = scan(text)
  if (!found.blocks.length && found.partial < 0) return text
  const lines = text.split(/\r?\n/)
  const hidden = new Set<number>()
  for (const b of found.blocks) for (let i = b.open; i <= b.close; i++) hidden.add(i)
  if (found.partial >= 0) hidden.add(found.partial)
  const kept = new Map(found.blocks.filter((b) => b.keep).map((b) => [b.open, b.keep as string]))
  return lines
    .map((line, i) => (kept.has(i) ? (kept.get(i) as string) : hidden.has(i) ? null : line))
    .filter((line): line is string => line !== null)
    .join('\n')
    .trimEnd()
}

// ---- reading what the block says ----

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > MOON_TEXT_MAX ? t.slice(0, MOON_TEXT_MAX).trimEnd() : t
}

/** A line number as a model writes it: a number, or the digits in a string. Anything else is not a line. */
function lineOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

/** The optional file, line and code of a finding or a test: each is dropped when it is not what it should be. */
function where(o: Record<string, unknown>): { file?: string; line?: number; code?: string } {
  const file = clean(o.file)
  const line = lineOf(o.line)
  const code = clean(o.code)
  return { ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}), ...(code ? { code } : {}) }
}

function findings(v: unknown): Finding[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Finding[] = []
  for (const entry of v) {
    if (!isObject(entry)) continue
    const text = clean(entry.text)
    if (!text) continue
    out.push({ text, ...where(entry) })
    if (out.length >= MAX_FINDINGS) break
  }
  return out
}

function sayOf(v: unknown): string | undefined {
  return clean(isObject(v) ? v.say : undefined)
}

export function readReview(text: string): ReviewReply | undefined {
  const block = readBlock(text)
  const say = sayOf(block)
  const list = isObject(block) ? findings(block.findings) : undefined
  return say === undefined || list === undefined ? undefined : { say, findings: list }
}

export function readFix(text: string): FixReply | undefined {
  const block = readBlock(text)
  const say = sayOf(block)
  if (say === undefined || !isObject(block) || !Array.isArray(block.answers)) return undefined
  const answers: FixReply['answers'] = []
  for (const entry of block.answers) {
    if (!isObject(entry)) continue
    if (typeof entry.n !== 'number' || !Number.isInteger(entry.n) || entry.n < 1 || typeof entry.fixed !== 'boolean') continue
    const why = clean(entry.say)
    answers.push({ n: entry.n, fixed: entry.fixed, ...(why ? { say: why } : {}) })
    if (answers.length >= MAX_FINDINGS) break
  }
  return { say, answers }
}

export function readPlan(text: string): PlanReply | undefined {
  const block = readBlock(text)
  const say = sayOf(block)
  if (say === undefined || !isObject(block) || !Array.isArray(block.steps)) return undefined
  const steps: string[] = []
  for (const entry of block.steps) {
    const step = clean(entry)
    if (step) steps.push(step)
    if (steps.length >= MAX_STEPS) break
  }
  return { say, steps }
}

export function readTest(text: string): TestReply | undefined {
  const block = readBlock(text)
  const say = sayOf(block)
  if (say === undefined || !isObject(block) || typeof block.failed !== 'boolean') return undefined
  return { say, failed: block.failed, ...where(block) }
}

// ---- comparing two reviews ----

const fileKey = (f: string): string => f.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\//, '').toLowerCase()
const textKey = (t: string): string => t.trim().replace(/\s+/g, ' ').toLowerCase()

/** How far apart two findings are when they are about the same thing, or null when they are not. */
function distance(a: Finding, b: Finding): number | null {
  if (a.file !== undefined || b.file !== undefined) {
    if (a.file === undefined || b.file === undefined || fileKey(a.file) !== fileKey(b.file)) return null
    if (a.line !== undefined && b.line !== undefined) {
      const d = Math.abs(a.line - b.line)
      return d <= 3 ? d : null
    }
  } else if (a.line !== undefined && b.line !== undefined && a.line === b.line) {
    // Neither names a file: only the same line and the same words count.
    return textKey(a.text) === textKey(b.text) ? 0 : null
  }
  // No line on one side or on both: the same words, or nothing.
  return a.line === undefined && b.line === undefined && textKey(a.text) === textKey(b.text) ? 0 : null
}

/** Findings of two reviews, matched: same file (compared without regard to slashes or case) and lines within 3 of each other; with no line on either, equal text. Each is used once. */
export function matchFindings(a: Finding[], b: Finding[]): { both: { a: Finding; b: Finding }[]; first: Finding[]; second: Finding[] } {
  const pairs: { i: number; j: number; d: number }[] = []
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const d = distance(x, y)
      if (d !== null) pairs.push({ i, j, d })
    })
  )
  // The closest pairs first, so a finding takes the nearest one and not just the first one that fits.
  pairs.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j)
  const usedA = new Set<number>()
  const usedB = new Set<number>()
  const matched: { i: number; j: number }[] = []
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue
    usedA.add(p.i)
    usedB.add(p.j)
    matched.push(p)
  }
  matched.sort((p, q) => p.i - q.i)
  return {
    both: matched.map((p) => ({ a: a[p.i] as Finding, b: b[p.j] as Finding })),
    first: a.filter((_, i) => !usedA.has(i)),
    second: b.filter((_, j) => !usedB.has(j))
  }
}

// ---- writing to one moon ----

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `@Reviewer please…` → the seat and the rest. Case does not matter; 'Reviewer 2' is matched before 'Reviewer'. Null when nobody is named, or nothing follows. */
export function mention(pattern: MoonPattern, text: string): { seat: Seat; rest: string } | null {
  const names = ([0, 1] as Seat[]).map((seat) => ({ seat, name: moonName(pattern, seat) })).sort((x, y) => y.name.length - x.name.length)
  for (const { seat, name } of names) {
    // 'Reviewer 2' may be written 'Reviewer2'. The name must end there, so '@Reviewers' is nobody.
    const re = new RegExp(`^\\s*@${escapeRegExp(name).replace(/ /g, '\\s*')}(?![\\p{L}\\p{N}_])\\s*[:,]?`, 'iu')
    const m = re.exec(text)
    if (!m) continue
    const rest = text.slice(m[0].length).trim()
    return rest ? { seat, rest } : null
  }
  return null
}
