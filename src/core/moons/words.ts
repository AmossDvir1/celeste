import type { FileDiff } from '@shared/agent'
import type { LogEvent } from '@shared/api'
import { DIFF_CHARS, MAX_FINDINGS, PATTERNS, moonName, type Finding, type MoonPattern } from '@shared/moons'

/*
 * What the two agents of a Two Moons chat are told (docs/plans/TWO_MOONS_PLAN.md, section 8). Plain and short. Every text that one agent wrote
 * for the other is framed as data, so it is never taken for the person's words; the person's own request is quoted as theirs. Each text that
 * asks for an answer ends by showing the exact block the answer must end with, because a program reads it.
 */

const FENCE = '```'
const block = (json: string): string => `${FENCE}moons\n${json}\n${FENCE}`

/** What an agent wrote for the other one, marked as such. */
export const framed = (from: string, text: string): string => `[From the ${from}, another assistant in this chat. It is not the person’s words.]\n${text.trim() || '(It said nothing.)'}`

/** The person's request, quoted as theirs. */
const quoted = (request: string): string => `“${request.trim()}”`

export const filesWord = (n: number): string => (n === 1 ? '1 file' : `${n} files`)
export const stepsWord = (n: number): string => (n === 1 ? '1 step' : `${n} steps`)
export const notesWord = (n: number): string => (n === 1 ? '1 note' : `${n} notes`)

// ---- the blocks an answer ends with ----

const REVIEW_BLOCK = (to: string): string => block(`{"say": "One sentence to ${to}.", "findings": [{"text": "What is wrong.", "file": "src/example.ts", "line": 12, "code": "The line that is wrong"}]}`)
const FIX_BLOCK = (to: string): string => block(`{"say": "One sentence to the ${to}.", "answers": [{"n": 1, "fixed": true, "say": "What you did, or why you did not change it."}]}`)
const PLAN_BLOCK = block('{"say": "One sentence to the person.", "steps": ["First step", "Second step"]}')
const TEST_BLOCK = block('{"say": "One sentence to the Builder.", "failed": true, "file": "src/example.ts", "line": 12, "code": "The line where it goes wrong"}')

const ENDING = 'End your reply with this block, and write nothing after it. It is read by a program, so keep to its shape:'

// ---- the change, as text ----

function fileText(f: FileDiff): string {
  const counts = f.binary || f.truncated ? '' : `, ${f.added} added, ${f.removed} removed`
  const head = `File: ${f.path} (${f.status}${counts})`
  if (f.binary) return `${head}\n(Not text: there are no lines to show.)`
  if (f.truncated) return `${head}\n(Too large to show here: read the file.)`
  if (f.hunks.length === 0) return `${head}\n(No lines to show: read the file.)`
  const body = f.hunks.map((h) => [h.header, ...h.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)].join('\n'))
  return `${head}\n${body.join('\n')}`
}

/** The change as a unified diff, cut at `max` characters with a sentence that says how much was left out. */
export function diffText(files: FileDiff[], max = DIFF_CHARS): { text: string; cut: number } {
  const all = files.map(fileText).join('\n\n')
  if (all.length <= max) return { text: all, cut: 0 }
  const cut = all.length - max
  return { text: `${all.slice(0, max)}\n[The change is longer than can be shown here. The last ${cut} characters of it are left out. Read the files for the rest.]`, cut }
}

/**
 * What the tools of one session say they changed, by file, from the events given: the lines of each edit that landed (later edits of a file are
 * added to its earlier ones), and the files a chat wrote with no lines to show. The account to use when there are no checkpoints.
 */
export function diffsOfTools(events: { event: LogEvent }[]): FileDiff[] {
  const byPath = new Map<string, FileDiff>()
  for (const { event } of events) {
    if (event.type === 'tool.completed' && event.ok !== false && event.diff) {
      for (const d of event.diff) {
        const seen = byPath.get(d.path)
        if (!seen) {
          byPath.set(d.path, { ...d, hunks: [...d.hunks] })
          continue
        }
        seen.hunks.push(...d.hunks)
        seen.added += d.added
        seen.removed += d.removed
        if (d.binary) seen.binary = true
        if (d.truncated) seen.truncated = true
        seen.status = d.status === 'deleted' ? 'deleted' : seen.status === 'deleted' ? 'modified' : seen.status
      }
    } else if (event.type === 'files.produced') {
      for (const f of event.files) if (!byPath.has(f.path)) byPath.set(f.path, { path: f.path, status: f.status, added: 0, removed: 0, hunks: [] })
    }
  }
  return [...byPath.values()]
}

// ---- to the Builder ----

/** What the pen is told besides the person's words, when the person's message goes straight to it. */
export function penLine(pattern: MoonPattern): string {
  if (pattern === 'build') return '[Celeste: this chat has two assistants. You are the Builder. When your turn ends, the Reviewer, another assistant, checks what you changed and may send you notes.]'
  if (pattern === 'plan') return '[Celeste: this chat has two assistants. You are the Builder. A Planner, another assistant, wrote the plan the person agreed to.]'
  if (pattern === 'reviews') return `[Celeste: this chat has two assistants who review the same thing at the same time and cannot see each other’s work. You are Reviewer 1. Read what you need and change nothing. Report only real problems: wrong behaviour, missing cases, broken things, not style. At most ${MAX_FINDINGS}. Nothing wrong: give an empty list. ${ENDING}]\n${REVIEW_BLOCK('the person')}`
  return ''
}

/** The Reviewer’s notes for the Builder, numbered, with what the Builder is to do with them. */
export function fixRequest(reviewer: string, say: string, notes: Finding[]): string {
  const list = notes
    .map((f, i) => {
      const at = f.file ? ` (${f.file}${f.line ? `, line ${f.line}` : ''})` : ''
      return `${i + 1}. ${f.text}${at}${f.code ? `\n   Code: ${f.code}` : ''}`
    })
    .join('\n')
  return [
    framed(reviewer, `${say.trim() ? `${say.trim()}\n` : ''}Notes on your change:\n${list}`),
    'Fix what is right. If a note is wrong, do not change anything for it, and say why. Do not change anything the notes do not call for.',
    ENDING,
    FIX_BLOCK(reviewer)
  ].join('\n\n')
}

/** The Tester’s finding for the Builder, and the files the Tester changed (it may have added a failing test). */
export function fixBugRequest(tester: string, request: string, found: { say: string; file?: string; line?: number; code?: string }, paths: string[]): string {
  const where = found.file ? `\nFile: ${found.file}${found.line ? `, line ${found.line}` : ''}` : ''
  const code = found.code ? `\nCode: ${found.code}` : ''
  const changed = paths.length ? `\nThe ${tester} changed these files, for example to add a failing test. Keep that test: ${paths.join(', ')}` : ''
  return [
    framed(tester, `${found.say.trim()}${where}${code}${changed}`),
    `The person’s request was ${quoted(request)}.`,
    'Fix the cause. Make the failing case pass, and change nothing else.',
    ENDING,
    FIX_BLOCK(tester)
  ].join('\n\n')
}

/** The plan the person agreed to, for the Builder. */
export function buildRequest(planner: string, request: string, steps: string[]): string {
  return [`The person agreed to this plan. Build it.`, framed(planner, steps.map((s, i) => `${i + 1}. ${s}`).join('\n')), `The person’s request was ${quoted(request)}.`].join('\n\n')
}

// ---- to the Reviewer ----

/** The change, for a Reviewer that has not seen it. */
export function reviewRequest(o: { name: string; builder: string; request: string; builderSaid: string; files: FileDiff[] }): string {
  const { text, cut } = diffText(o.files)
  return [
    `You are the ${o.name} in a chat with another assistant, the ${o.builder}. The ${o.builder} made a change for the person. Check it. Read what you need, and change nothing.`,
    `The person asked: ${quoted(o.request)}`,
    framed(o.builder, o.builderSaid),
    `Files changed: ${o.files.map((f) => f.path).join(', ')}${cut ? ' (the change below is cut, see the end of it)' : ''}`,
    text,
    `Report only real problems: wrong behaviour, missing cases, broken things. Not style. At most ${MAX_FINDINGS}. If nothing is wrong, give an empty list.`,
    ENDING,
    REVIEW_BLOCK(`the ${o.builder}`)
  ].join('\n\n')
}

/** The same change after the Builder answered the notes, for the Reviewer that wrote them. */
export function checkRequest(o: { name: string; builder: string; notes: Finding[]; answers: { n: number; fixed: boolean; say?: string }[]; say: string; files: FileDiff[] }): string {
  const { text, cut } = diffText(o.files)
  const lines = o.notes.map((f, i) => {
    const a = o.answers.find((x) => x.n === i + 1)
    const state = a ? (a.fixed ? 'fixed' : 'not changed') : 'no answer'
    return `${i + 1}. ${f.text}\n   ${o.builder}: ${state}${a?.say ? `. ${a.say}` : ''}`
  })
  return [
    `The ${o.builder} answered your notes. Look at the change again.`,
    framed(o.builder, `${o.say.trim()}\n${lines.join('\n')}`),
    `Files changed: ${o.files.map((f) => f.path).join(', ')}${cut ? ' (the change below is cut, see the end of it)' : ''}`,
    text,
    `Report only what is still wrong. Do not repeat a note that was fixed. A note the ${o.builder} did not follow for a good reason is not a problem. If nothing is left, give an empty list.`,
    ENDING,
    REVIEW_BLOCK(`the ${o.builder}`)
  ].join('\n\n')
}

/** For the second reviewer of Two reviews: the same words the person wrote, and who else is looking. */
export function reviewBothRequest(name: string, request: string): string {
  return [
    `You are ${name} in a chat with another assistant, ${moonName('reviews', 0)}. You both review the same thing at the same time and cannot see each other’s work.`,
    `The person asked: ${quoted(request)}`,
    `Read what you need and change nothing. Report only real problems: wrong behaviour, missing cases, broken things, not style. At most ${MAX_FINDINGS}. If nothing is wrong, give an empty list.`,
    ENDING,
    REVIEW_BLOCK('the person')
  ].join('\n\n')
}

// ---- to the Planner and the Tester ----

export function planRequest(request: string): string {
  return [
    'You are the Planner in a chat with another assistant, the Builder. Write a plan and nothing else: change nothing. Read what you need.',
    `The person said: ${quoted(request)}`,
    'Give 3 to 12 short steps, in the person’s words, each one thing to do. If the person asked a question about an earlier plan, answer it in the plan.',
    ENDING,
    PLAN_BLOCK
  ].join('\n\n')
}

export function testRequest(request: string): string {
  return [
    'You are the Tester in a chat with another assistant, the Builder. Make the problem happen. Run what you need. You may add a failing test that shows it. Do not fix it.',
    `The person said: ${quoted(request)}`,
    'If you could not make it happen, say so with "failed": false.',
    ENDING,
    TEST_BLOCK
  ].join('\n\n')
}

export function retestRequest(o: { builder: string; say: string }): string {
  return [`The ${o.builder} says the problem is fixed. Try again the same way.`, framed(o.builder, o.say), 'Say whether it still happens.', ENDING, TEST_BLOCK].join('\n\n')
}

/** The person wrote to the other moon directly (`@Reviewer …`). No block is needed. */
export function directRequest(name: string, pattern: MoonPattern, rest: string): string {
  const mate = moonName(pattern, PATTERNS[pattern].pen)
  return [`You are the ${name} in a chat with another assistant, the ${mate}. The person is writing to you, not to the ${mate}. Answer in plain words. Change nothing.`, `The person said: ${quoted(rest)}`].join('\n\n')
}
