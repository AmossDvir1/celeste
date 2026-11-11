import type { SessionMode, ToolKind } from '@shared/agent'
import type { TimelineItem } from '@/stores/types'

// What a conversation shows and what it folds: shared by the computer's timeline and the phone app, so both fold the same way.

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>
export type ThinkingItem = Extract<TimelineItem, { kind: 'thinking' }>

export type Block = { kind: 'item'; item: TimelineItem } | { kind: 'group'; id: string; items: (ToolItem | ThinkingItem)[] }

/** Reading and searching: the part of Develop's work that is folded. Edits, commands, web and tools stay as cards of their own. */
const QUIET: ToolKind[] = ['read', 'search']

/**
 * Chat folds all thinking and every tool call into groups: a person using it for questions wants the answer, and the way there is
 * one click away. Develop shows thinking while it streams and each tool call, but folds runs of reading and searching, which
 * are many and the least interesting.
 */
export function toBlocks(items: TimelineItem[], mode: SessionMode): Block[] {
  const out: Block[] = []
  let run: (ToolItem | ThinkingItem)[] = []
  const emit = () => {
    if (run.length === 0) return
    if (mode === 'chat' || run.some((i) => i.kind === 'tool')) out.push({ kind: 'group', id: run[0]!.id, items: run })
    // Develop: thinking with no reading beside it is shown on its own.
    else for (const item of run) out.push({ kind: 'item', item })
    run = []
  }
  for (const item of items) {
    const foldable =
      mode === 'chat'
        ? item.kind === 'tool' || item.kind === 'thinking'
        : (item.kind === 'tool' && QUIET.includes(item.tool)) || (item.kind === 'thinking' && item.endedAt !== undefined)
    if (foldable) run.push(item as ToolItem | ThinkingItem)
    else {
      emit()
      out.push({ kind: 'item', item })
    }
  }
  emit()
  return out
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What a run of tool calls did, in a few words: "Read 3 files, ran 2 commands". */
export function summarize(tools: ToolItem[]): string {
  const count = (k: ToolKind[]) => tools.filter((t) => k.includes(t.tool)).length
  const parts: string[] = []
  const reads = count(['read'])
  if (reads) parts.push(`read ${plural(reads, 'file', 'files')}`)
  const searches = count(['search'])
  if (searches) parts.push(searches === 1 ? 'searched the project' : `searched ${searches} times`)
  if (count(['web'])) parts.push('browsed the web')
  const cmds = count(['shell'])
  if (cmds) parts.push(`ran ${plural(cmds, 'command', 'commands')}`)
  if (count(['edit', 'write'])) parts.push('edited files')
  const mcp = count(['mcp', 'agent', 'other'])
  if (mcp) parts.push(`used ${plural(mcp, 'tool', 'tools')}`)
  const text = parts.join(', ')
  return text ? text[0].toUpperCase() + text.slice(1) : 'Worked'
}

/** The line a group folds into: "Read 3 files · 2 s", "Thought for 4 s", or "Working…" while it is still going. */
export function groupLabel(items: (ToolItem | ThinkingItem)[], format: (ms: number) => string): { running: boolean; text: string } {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
  const running = tools.some((t) => t.status === 'running') || items.some((i) => i.kind === 'thinking' && i.endedAt === undefined)
  const start = Math.min(...items.map((i) => i.startedAt))
  const end = Math.max(...items.map((i) => ('endedAt' in i && i.endedAt ? i.endedAt : start)))
  if (running) return { running, text: `${tools.length ? 'Working' : 'Thinking'}…` }
  return { running, text: tools.length ? `${summarize(tools)} · ${format(end - start)}` : `Thought for ${format(end - start)}` }
}
