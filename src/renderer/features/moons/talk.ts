/*
 * The timing of the bubbles in the sky. Pure: the time is always passed in, so it is tested without timers.
 *
 * A message from a seat shows typing dots for a moment and then the bubble. The next one starts only after the one before could be read,
 * so a burst of messages is told like a conversation and never lands in one piece. A note (said to nobody) has no dots.
 */

export interface Said {
  id: string
  seat: 0 | 1 | 'note'
  text: string
  file?: string
  line?: number
  code?: string
  /** When it arrived, in ms (the same clock as the `now` that is passed in). */
  at: number
}

export type BubbleState = 'hidden' | 'typing' | 'shown'

export interface TalkView {
  /** Every message the player knows, in the order they arrived. */
  items: { id: string; state: BubbleState }[]
  /** The seat whose bubble appeared a moment ago and is still "speaking" (the moon moves its mouth), or null. */
  speaker: 0 | 1 | null
  /** The seat that shows typing dots now, or null. */
  typing: 0 | 1 | null
  /** Nothing is playing and nothing is about to. The sky may close. */
  over: boolean
}

export const DOTS_MS = 900
export const READ_BASE_MS = 1200
export const READ_PER_CHAR_MS = 32
export const READ_MAX_MS = 6000
export const SPEAK_BASE_MS = 500
export const SPEAK_PER_CHAR_MS = 32
export const SPEAK_MAX_MS = 4000
export const LINGER_MS = 2500
export const MAX_PLAYED = 8
/** A message this old when it is first seen belongs to a chat the person comes back to: it is not played. */
export const STALE_MS = 20_000

/** How long after its bubble appears a message could be read. */
export const readMs = (text: string): number => Math.min(READ_MAX_MS, READ_BASE_MS + READ_PER_CHAR_MS * text.length)
/** How long after its bubble appears its sender is shown as speaking. */
export const speakMs = (text: string): number => Math.min(SPEAK_MAX_MS, SPEAK_BASE_MS + SPEAK_PER_CHAR_MS * text.length)

interface Entry {
  msg: Said
  seenAt: number
  /** Played at once: seen too late, or pushed out by newer ones. */
  instant: boolean
  /** Its times are set. */
  planned: boolean
  dotsAt: number
  bubbleAt: number
  readEnd: number
}

export class TalkPlayer {
  private entries: Entry[] = []
  private known = new Set<string>()

  /** Give it the messages in the order they arrived, as often as you like: it takes in only those it has not seen. */
  feed(messages: Said[], now: number): void {
    const fresh = messages.filter((m) => !this.known.has(m.id))
    if (!fresh.length) return
    const added: Entry[] = []
    for (const msg of fresh) {
      this.known.add(msg.id)
      const stale = now - msg.at > STALE_MS
      added.push({ msg, seenAt: now, instant: stale, planned: false, dotsAt: -Infinity, bubbleAt: -Infinity, readEnd: -Infinity })
    }
    this.entries.push(...added)
    this.schedule(now)
  }

  /** Plan the messages that have not started yet, one after the other, and let only the newest few play. */
  private schedule(now: number): void {
    const started = this.entries.filter((e) => !e.instant && e.planned && e.dotsAt <= now)
    const waiting = this.entries.filter((e) => !e.instant && (!e.planned || e.dotsAt > now))
    const running = started.filter((e) => e.readEnd > now).length
    const room = Math.max(0, MAX_PLAYED - running)
    for (const e of waiting.slice(0, Math.max(0, waiting.length - room))) e.instant = true
    let prevEnd = started.reduce((m, e) => Math.max(m, e.readEnd), -Infinity)
    for (const e of waiting) {
      if (e.instant) continue
      const from = Math.max(e.seenAt, prevEnd)
      const dots = e.msg.seat === 'note' ? 0 : DOTS_MS
      e.planned = true
      e.dotsAt = from
      e.bubbleAt = from + dots
      e.readEnd = e.bubbleAt + readMs(e.msg.text)
      prevEnd = e.readEnd
    }
  }

  /** What to show at this moment. */
  view(now: number): TalkView {
    const items: TalkView['items'] = []
    let typing: 0 | 1 | null = null
    let speaker: 0 | 1 | null = null
    let speakerAt = -Infinity
    let end = -Infinity
    for (const e of this.entries) {
      if (e.instant) {
        items.push({ id: e.msg.id, state: 'shown' })
        continue
      }
      end = Math.max(end, e.readEnd)
      if (now < e.dotsAt) {
        items.push({ id: e.msg.id, state: 'hidden' })
      } else if (now < e.bubbleAt) {
        items.push({ id: e.msg.id, state: 'typing' })
        if (e.msg.seat !== 'note') typing = e.msg.seat
      } else {
        items.push({ id: e.msg.id, state: 'shown' })
        if (e.msg.seat !== 'note' && now - e.bubbleAt < speakMs(e.msg.text) && e.bubbleAt >= speakerAt) {
          speaker = e.msg.seat
          speakerAt = e.bubbleAt
        }
      }
    }
    return { items, speaker, typing, over: now >= end + LINGER_MS }
  }
}
