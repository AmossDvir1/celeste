import type { StoredEvent } from './api'

/**
 * Runs of token entries in a session's log, folded into one. A reply is logged as it arrives, so an old conversation holds tens of
 * thousands of entries that say a few characters each; reading it back one by one is what makes a long conversation slow to open.
 * Entries next to each other that continue the same text (the answer, the thinking, one tool's output) become one entry that
 * carries all of it, with the number of the last and the time of the first. Replaying the result gives the same conversation.
 */
export function coalesceEvents(events: StoredEvent[]): StoredEvent[] {
  const out: StoredEvent[] = []
  for (const stored of events) {
    const e = stored.event
    const last = out[out.length - 1]
    if (last && joinable(last.event, e)) {
      out[out.length - 1] = { seq: stored.seq, at: last.at, event: { ...last.event, text: (last.event as { text: string }).text + (e as { text: string }).text } as StoredEvent['event'] }
    } else out.push(stored)
  }
  return out
}

function joinable(a: StoredEvent['event'], b: StoredEvent['event']): boolean {
  if (a.type === 'message.delta' || a.type === 'thinking.delta') return b.type === a.type
  if (a.type === 'tool.output') return b.type === 'tool.output' && b.id === a.id
  return false
}
