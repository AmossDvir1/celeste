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
