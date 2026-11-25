import type { ApprovalMode, Effort, VendorId } from './agent'

/*
 * Helpers: sessions the assistant of a chat starts for a piece of work (docs/plans/SUB_AGENTS_PLAN.md). These are the limits and the
 * shapes that Core, the window and the phone share.
 */

/** A helper cannot start helpers. */
export const MAX_DEPTH = 1
export const MAX_RUNNING_PER_PARENT = 4
export const MAX_RUNNING_TOTAL = 8
/** Helpers started since the person's last message in one chat. Stops "a helper ends, the chat wakes, it starts another" from going on without the person. */
export const MAX_STARTS_PER_MESSAGE = 12
export const TASK_MAX_CHARS = 20_000
export const TITLE_MAX_CHARS = 60
export const RESULT_MAX_CHARS = 12_000
/** How much of one helper's answer goes in a note to the parent (several notes may go at once). */
export const NOTE_MAX_CHARS = 8_000
/** Helpers that end within this time of each other wake the parent once, with one note. */
export const NOTE_BATCH_MS = 2_000
/**
 * How long one waiting tool call lasts before it gives the helper's id back and the work goes on in the background. The smallest tool-call
 * limit of the four vendors, less 90 s (section 16 of the plan).
 */
export const WAIT_CAP_MS = 8 * 60_000

/**
 * How long one waiting tool call may last for a chat of this vendor (measured 21 Nov 2026, plan section 16). 0: its program gives up on a tool call
 * after about a minute and cannot be told otherwise, so its helpers always work in the background and the tool says so.
 */
export function waitCapFor(vendor: VendorId): number {
  return vendor === 'gemini' ? 0 : WAIT_CAP_MS
}

/** How strict each mode is, so a helper's mode can be checked against its parent's. Higher is stricter. */
export const STRICTNESS: Record<ApprovalMode, number> = { auto: 0, edits: 1, ask: 2, plan: 3 }

/** The mode a helper gets: the one asked for, never looser than the parent's. Null when what was asked is looser. */
export function helperApproval(parent: ApprovalMode, asked: ApprovalMode | undefined): ApprovalMode | null {
  // A chat that only plans gets helpers that only plan.
  if (parent === 'plan') return 'plan'
  const mode = asked ?? parent
  return STRICTNESS[mode] < STRICTNESS[parent] ? null : mode
}

/** What a session row keeps about how it was started, when it is a helper. Stored as JSON in `sessions.spawn`. */
export interface SpawnInfo {
  /** The session whose assistant started this one. Also in `SessionSummary.parentId`. */
  parentId: string
  /** 'copy' when it got a separate copy of the project (Develop). */
  folder: 'same' | 'copy'
  /** The parent's approval mode when it started: the loosest this helper may ever be set to. */
  ceiling: ApprovalMode
  /** Set when this is the second moon of a Two Moons chat (docs/plans/TWO_MOONS_PLAN.md) and not a helper the assistant started: Celeste, not a model, gives it its turns. */
  moon?: true
}

/** Derived, never stored: 'working' and 'waiting' come from the child's status; the rest from its last child.finished. */
export type HelperState = 'working' | 'waiting' | 'done' | 'failed' | 'stopped' | 'abandoned' | 'deleted'

/** One line of `agent_list` and of the parent's card. */
export interface HelperView {
  id: string
  title: string
  vendor: VendorId
  model: string
  effort: Effort | null
  state: HelperState
  /** When the current or last assignment started and ended. */
  startedAt: number
  endedAt?: number
}

/** The tools of the assistant for helpers, by the name they have on Celeste's tool server. */
export const AGENT_TOOL_NAMES = ['agent_start', 'agent_send', 'agent_wait', 'agent_stop', 'agent_list'] as const

/** What a helper is told when it asks for the computer's mouse and keyboard or the phone: there is one of each, for the whole computer. */
export const HELPER_REFUSAL = 'This is not available to a helper. Ask the assistant that started you to do it.'
