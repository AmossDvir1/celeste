import type { AttachmentInfo, ContextRef, Effort, VendorId } from './agent'
import type { LogEvent } from './api'

/** How many messages may wait behind a running turn. */
export const MAX_QUEUED = 20

/**
 * What `sessions.send` does with a message when the assistant is already working.
 * - `queue`: it waits, and is sent when the turn ends. When nothing is running it is sent at once.
 * - `stop`: the turn is stopped and this message is sent at once ("send now"). When nothing is running it is sent at once.
 * - `steer`: the message goes into the turn that is running, to be read at its next step, and the work so far is kept. Where the vendor
 *   cannot do that, or the assistant is waiting for an answer, it is a `queue`. When nothing is running it is sent at once.
 * Without a mode the message goes straight to the agent, as it always did.
 */
export type SendMode = 'queue' | 'stop' | 'steer'

/**
 * The vendors whose program takes a message into a turn that is running (checked with the real programs on 16 November 2026 for Claude;
 * Copilot's SDK documents it). The window and the phone offer Steer only for these.
 */
export const STEERING_VENDORS: readonly VendorId[] = ['claude', 'copilot']
export const canSteer = (vendor: VendorId): boolean => STEERING_VENDORS.includes(vendor)

/** What can be done with a message that is waiting. */
export type QueueAction =
  | { type: 'edit'; queueId: string; text: string }
  | { type: 'remove'; queueId: string }
  /** Stops the running turn, if there is one, and sends this message at once. */
  | { type: 'now'; queueId: string }
  /** A paused queue carries on: the next message is sent when the turn ends, or now when nothing is running. */
  | { type: 'resume' }
  /** Throws away every message that is waiting. */
  | { type: 'clear' }

/** A message that is waiting for its turn. Its files and the model are kept as they were when it was typed. */
export interface QueuedMessage {
  id: string
  text: string
  attachments: AttachmentInfo[]
  context?: ContextRef[]
  model?: string
  effort?: Effort | null
}

export interface QueueState {
  items: QueuedMessage[]
  /** The person stopped the turn, it failed, or Celeste was closed: nothing is sent by itself until `resume`. */
  paused: boolean
}

export const EMPTY_QUEUE: QueueState = { items: [], paused: false }

/**
 * The queue after one more logged event. Core keeps its queue with this, and the window and the phone replay the same events with
 * it, so all of them always show the same list.
 */
export function foldQueue(q: QueueState, e: LogEvent): QueueState {
  switch (e.type) {
    case 'queue.added':
      return {
        ...q,
        items: [
          ...q.items,
          {
            id: e.id,
            text: e.text,
            attachments: e.attachments,
            ...(e.context?.length ? { context: e.context } : {}),
            ...(e.model ? { model: e.model } : {}),
            ...(e.effort !== undefined ? { effort: e.effort } : {})
          }
        ]
      }
    case 'queue.edited':
      return { ...q, items: q.items.map((m) => (m.id === e.id ? { ...m, text: e.text } : m)) }
    case 'queue.removed':
    case 'queue.sent': {
      const items = q.items.filter((m) => m.id !== e.id)
      return { items, paused: items.length > 0 && q.paused }
    }
    case 'queue.paused':
      return q.items.length ? { ...q, paused: true } : q
    case 'queue.resumed':
      return q.paused ? { ...q, paused: false } : q
    default:
      return q
  }
}
