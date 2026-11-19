import type { VendorId } from './agent'

/*
 * How much of a vendor's allowance is used and when it comes back (docs/QUEUE_AND_USAGE_PLAN.md, Part 2). Each reading is made by that
 * vendor's own SDK or program with the account already signed in; nothing is sent anywhere new.
 */

/** One meter: a window of time, or a monthly allowance. */
export interface UsageWindow {
  /** Stable, for keys: `five_hour`, `seven_day`, `premium_interactions`. */
  key: string
  /** What the person reads: "5-hour session", "Premium requests". */
  label: string
  /** How much is used, 0 to 100. Null when there is no number to show (unlimited). */
  percentUsed: number | null
  /** When the meter starts again, in milliseconds since 1970. */
  resetsAt: number | null
  /** The same in words where the vendor gives amounts: "212 of 300 used". */
  text?: string
  /** No limit: there is nothing to run out of. */
  unlimited?: boolean
}

export interface VendorUsage {
  vendor: VendorId
  /** The plan, as the vendor names it ("max", "copilot_pro"). */
  plan?: string
  /** Every meter the vendor gave, the one the strip draws first. */
  windows: UsageWindow[]
  /** Something to say beside the meters ("Overage is allowed"). */
  note?: string
  /** When this was read, in milliseconds since 1970. */
  at: number
  /** The last try to read it again failed at this time; what is shown is from `at`. */
  failedAt?: number
}

/** A reading is stale after this long; the strip says so. */
export const USAGE_STALE_MS = 15 * 60_000
/** How often a window that is open asks again. */
export const USAGE_REFRESH_MS = 5 * 60_000

/** From 80% the meter is amber, from 95% red. */
export type UsageLevel = 'ok' | 'warn' | 'limit'
export const usageLevel = (percentUsed: number | null): UsageLevel => (percentUsed === null ? 'ok' : percentUsed >= 95 ? 'limit' : percentUsed >= 80 ? 'warn' : 'ok')

/** The meter the strip draws: the first one, which each vendor's reader puts first. */
export const mainWindow = (u: VendorUsage): UsageWindow | undefined => u.windows[0]

/** How the vendors are named in a sentence. */
export const VENDOR_NAMES: Record<VendorId, string> = { copilot: 'GitHub Copilot', claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' }

/** A vendor that is at its limit and comes back later than this is not waited for: the person is told, and decides. */
export const LIMIT_WAIT_MAX_MS = 6 * 3_600_000

/**
 * When a vendor that has just said it is at its limit comes back, from its latest reading: the meters at 95% or more that have a reset time
 * ahead, and the latest of those (every one has to come back). Null when no meter is at its limit, or none says when.
 */
export function limitReset(u: VendorUsage | undefined, now: number): { resetsAt: number; window: string } | null {
  if (!u) return null
  const hit = u.windows.filter((w) => !w.unlimited && w.percentUsed !== null && w.percentUsed >= 95 && w.resetsAt !== null && w.resetsAt > now)
  if (!hit.length) return null
  const last = hit.reduce((a, b) => ((b.resetsAt as number) > (a.resetsAt as number) ? b : a))
  return { resetsAt: last.resetsAt as number, window: last.label }
}

/** A time of day for a sentence: "4:30 PM", with the day when it is not today ("Dec 1, 4:30 PM"). */
export function clockText(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const same = d.toDateString() === new Date(now).toDateString()
  return same ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** The line in the chat when a vendor is at its limit (`at` is when it happened). */
export function limitNotice(e: { vendor: VendorId; resetsAt?: number; window?: string }, at: number): string {
  const name = VENDOR_NAMES[e.vendor]
  const which = e.window ? ` (${e.window})` : ''
  if (e.resetsAt === undefined) return `${name} is at its limit${which}. It did not say when it comes back.`
  return `${name} is at its limit${which}. It comes back in ${untilText(e.resetsAt, at)}, around ${clockText(e.resetsAt, at)}.`
}

/** "3 h 12 min", "5 min", "2 days" until a time, or "now" when it has passed. */
export function untilText(at: number, now: number): string {
  const ms = at - now
  if (ms <= 0) return 'now'
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'under a minute'
  if (min < 60) return `${min} min`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} h${min % 60 ? ` ${min % 60} min` : ''}`
  const days = Math.round(ms / 86_400_000)
  return `${days} day${days === 1 ? '' : 's'}`
}
