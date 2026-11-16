/*
 * What an answer's fenced blocks may say when they are pictures (docs/plans/CHAT_DISPLAY_PLAN.md, section 11a). Pure: the checks come before
 * anything is drawn, so a block that is too big, or not what it says it is, is turned into a short note and never reaches a library.
 * Unknown fields are dropped, and no colour or script comes from the model's text.
 */

import { parseDrawing } from './drawing'

export type VisualKind = 'mermaid' | 'chart' | 'steps' | 'excalidraw'

/** The fenced languages that are drawn as a picture, or null for an ordinary code block. */
export function visualKind(lang: string | undefined): VisualKind | null {
  const l = lang?.toLowerCase()
  return l === 'mermaid' || l === 'chart' || l === 'steps' || l === 'excalidraw' ? l : null
}

/** A short stable hash of a block's text, to tell blocks apart (a retry count, a step's ticks). Not a secret. */
export function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** The text after the last fence line of a reply that is still open (the closing fence has not arrived), or null when every fence is closed. */
export function openFenceBody(text: string): string | null {
  const lines = text.split('\n')
  let fence: string | null = null
  let from = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i] as string)
    if (!m) continue
    const mark = (m[1] as string)[0] as string
    if (fence === null) {
      fence = mark
      from = i + 1
    } else if (fence === mark) fence = null
  }
  return fence === null ? null : lines.slice(from).join('\n')
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error })

// --- Mermaid ------------------------------------------------------------------------------------------

export const MERMAID_MAX_CHARS = 20_000
export const MERMAID_MAX_NODES = 200

export interface MermaidSource {
  /** What is handed to the library: no `%%{init}%%` directive, which would let the text change the library's own settings. */
  source: string
  /** The words that say what the picture shows (the first `%% summary:` line), for a screen reader and the phone. */
  summary?: string
}

/** Checks a Mermaid block before it is drawn. The library is the real validator; this keeps out what is too big, and what changes its settings. */
export function prepareMermaid(raw: string): Checked<MermaidSource> {
  const text = raw.trim()
  if (!text) return bad('The diagram is empty.')
  if (text.length > MERMAID_MAX_CHARS) return bad(`The diagram is longer than ${MERMAID_MAX_CHARS.toLocaleString('en-GB')} characters.`)
  // A directive can change the security level and the theme: the settings are Celeste's, never the model's.
  const source = text.replace(/%%\{[\s\S]*?\}%%/g, '').trim()
  // A rough count of boxes and links; a cheap check, the library does the rest.
  const nodes = (source.match(/-->|---|==>|-\.->|->>|-->>/g) ?? []).length + (source.match(/[\[({]/g) ?? []).length / 2
  if (nodes > MERMAID_MAX_NODES) return bad(`The diagram has more than ${MERMAID_MAX_NODES} parts.`)
  const summary = /^\s*%%\s*summary:\s*(.+)$/im.exec(source)?.[1]?.trim()
  return { ok: true, value: { source, ...(summary ? { summary: summary.slice(0, 300) } : {}) } }
}

// --- charts -------------------------------------------------------------------------------------------

export type ChartType = 'bar' | 'line' | 'pie'
export interface ChartSpec {
  type: ChartType
  title?: string
  labels: string[]
  series: { name: string; data: number[] }[]
  summary?: string
}

export const CHART_MAX_LABELS = 50
export const CHART_MAX_SERIES = 6
export const CHART_MAX_POINTS = 500

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

function json(raw: string): Checked<Record<string, unknown>> {
  if (raw.length > 100_000) return bad('The block is too large.')
  try {
    const v: unknown = JSON.parse(raw)
    return isObject(v) ? { ok: true, value: v } : bad('It is not an object.')
  } catch {
    return bad('It is not valid JSON.')
  }
}

/** A chart spec from a block's text. Unknown fields are dropped; a limit that is passed is refused with a sentence. */
export function parseChart(raw: string): Checked<ChartSpec> {
  const parsed = json(raw)
  if (!parsed.ok) return parsed
  const v = parsed.value
  const type = v.type
  if (type !== 'bar' && type !== 'line' && type !== 'pie') return bad('The chart type must be bar, line or pie.')
  if (!Array.isArray(v.labels) || v.labels.length === 0 || v.labels.some((l) => typeof l !== 'string' && typeof l !== 'number')) return bad('The chart needs a list of labels.')
  if (v.labels.length > CHART_MAX_LABELS) return bad(`A chart may have at most ${CHART_MAX_LABELS} labels.`)
  if (!Array.isArray(v.series) || v.series.length === 0) return bad('The chart needs at least one series.')
  if (v.series.length > CHART_MAX_SERIES) return bad(`A chart may have at most ${CHART_MAX_SERIES} series.`)
  const labels = (v.labels as (string | number)[]).map((l) => String(l).slice(0, 80))
  const series: ChartSpec['series'] = []
  let points = 0
  for (const s of v.series) {
    if (!isObject(s) || !Array.isArray(s.data) || s.data.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return bad('Each series needs a name and a list of numbers.')
    points += s.data.length
    if (points > CHART_MAX_POINTS) return bad(`A chart may have at most ${CHART_MAX_POINTS} points.`)
    series.push({ name: text(s.name, 80) ?? `Series ${series.length + 1}`, data: s.data as number[] })
  }
  if (type === 'pie' && series.length > 1) return bad('A pie chart has one series.')
  const title = text(v.title, 120)
  const summary = text(v.summary, 300)
  return { ok: true, value: { type, labels, series, ...(title ? { title } : {}), ...(summary ? { summary } : {}) } }
}

// --- steps --------------------------------------------------------------------------------------------

export interface StepsSpec {
  title: string
  summary?: string
  steps: { title: string; text?: string; copy?: string; link?: { label: string; url: string } }[]
}

export const STEPS_MAX = 20

/** The address of a link a step offers: https only, and a real one. */
export function safeLink(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > 2000) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/** A step card from a block's text. A link that is not https is left out, and the step still shows. */
export function parseSteps(raw: string): Checked<StepsSpec> {
  const parsed = json(raw)
  if (!parsed.ok) return parsed
  const v = parsed.value
  const title = text(v.title, 120)
  if (!title) return bad('The steps need a title.')
  if (!Array.isArray(v.steps) || v.steps.length === 0) return bad('The steps need a list of steps.')
  if (v.steps.length > STEPS_MAX) return bad(`There may be at most ${STEPS_MAX} steps.`)
  const steps: StepsSpec['steps'] = []
  for (const s of v.steps) {
    if (!isObject(s)) return bad('A step is not an object.')
    const stepTitle = text(s.title, 160)
    if (!stepTitle) return bad('Each step needs a title.')
    const body = text(s.text, 800)
    const copy = text(s.copy, 400)
    const url = isObject(s.link) ? safeLink(s.link.url) : undefined
    const label = isObject(s.link) ? text(s.link.label, 80) : undefined
    steps.push({ title: stepTitle, ...(body ? { text: body } : {}), ...(copy ? { copy } : {}), ...(url ? { link: { label: label ?? url, url } } : {}) })
  }
  const summary = text(v.summary, 300)
  return { ok: true, value: { title, steps, ...(summary ? { summary } : {}) } }
}

// --- trying again -------------------------------------------------------------------------------------

/** How many times in a row a block may be sent back to the assistant. */
export const MAX_RETRIES = 2

/** The message that sends a block's error back: visible in the chat, and marked as automatic. */
export function retryMessage(kind: VisualKind, error: string): string {
  const what = kind === 'mermaid' ? 'diagram' : kind === 'chart' ? 'chart' : kind === 'excalidraw' ? 'drawing' : 'list of steps'
  const reason = error.replace(/\s+/g, ' ').trim().slice(0, 300)
  return `(automatic) That ${what} could not be drawn: ${reason} Please fix it and send it again.`
}

const tries = new Map<string, number>()
/** How many times this block (in this chat) has been sent back. */
export const retriesOf = (chat: string, hash: string): number => tries.get(`${chat}:${hash}`) ?? 0
export const noteRetry = (chat: string, hash: string): void => void tries.set(`${chat}:${hash}`, retriesOf(chat, hash) + 1)
export const resetRetries = (): void => tries.clear()

/** What a picture shows in words, from its block's text, for a screen reader and for the phone (which does not draw pictures). Empty when the block has none. */
export function summaryOf(kind: VisualKind, source: string): string {
  if (kind === 'mermaid') {
    const r = prepareMermaid(source)
    return r.ok ? (r.value.summary ?? '') : ''
  }
  const r = kind === 'chart' ? parseChart(source) : kind === 'excalidraw' ? parseDrawing(source) : parseSteps(source)
  return r.ok ? (r.value.summary ?? '') : ''
}

/** The line the phone shows in place of a picture: its summary, and where to see it. Never the source. */
export function phoneLine(kind: VisualKind, source: string): string {
  const summary = summaryOf(kind, source)
  const name = kind === 'mermaid' ? 'A diagram' : kind === 'chart' ? 'A chart' : kind === 'excalidraw' ? 'A drawing' : 'Steps'
  return summary ? `${summary} (open on the computer to see the picture)` : `${name} (open on the computer)`
}
