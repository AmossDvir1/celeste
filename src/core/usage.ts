import type { VendorId } from '@shared/agent'
import type { UsageWindow, VendorUsage } from '@shared/usage'

/*
 * Usage for each vendor (docs/QUEUE_AND_USAGE_PLAN.md, Part 2). The readers turn what a vendor's own SDK says into the same shape, and
 * the service keeps the last answer of each, asks again when told to, and never lets a failed reading take away what is already known.
 */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const when = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}
const clamp = (p: number): number => Math.min(100, Math.max(0, Math.round(p * 10) / 10))

// --- Claude --------------------------------------------------------------------------------------------

/** The part of Claude Code's `/usage` answer that is read (the SDK marks the whole call as experimental, so everything here is checked). */
export interface ClaudeUsageAnswer {
  subscription_type?: string | null
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null
    seven_day?: { utilization: number | null; resets_at: string | null } | null
    seven_day_opus?: { utilization: number | null; resets_at: string | null } | null
    seven_day_sonnet?: { utilization: number | null; resets_at: string | null } | null
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[]
    extra_usage?: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null
  } | null
}

/**
 * Claude's plan windows: the 5-hour session first, then the week and the weekly meters of single models. Null when the account has no
 * plan limits to show (an API key, Bedrock, Vertex), which is what a Celeste release always has: a Claude subscription login is not offered.
 */
export function claudeUsageFrom(answer: ClaudeUsageAnswer | null | undefined, at: number): VendorUsage | null {
  const limits = answer?.rate_limits
  if (!answer || answer.rate_limits_available !== true || !limits) return null
  const windows: UsageWindow[] = []
  const add = (key: string, label: string, w: { utilization: number | null; resets_at: string | null } | null | undefined) => {
    const used = num(w?.utilization)
    if (!w || used === null) return
    windows.push({ key, label, percentUsed: clamp(used), resetsAt: when(w.resets_at) })
  }
  add('five_hour', '5-hour session', limits.five_hour)
  add('seven_day', '7-day', limits.seven_day)
  add('seven_day_opus', '7-day Opus', limits.seven_day_opus)
  add('seven_day_sonnet', '7-day Sonnet', limits.seven_day_sonnet)
  for (const m of limits.model_scoped ?? []) add(`model_${m.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, `7-day ${m.display_name}`, m)
  const extra = limits.extra_usage
  if (extra?.is_enabled && num(extra.utilization) !== null) {
    const unit = extra.currency ?? ''
    windows.push({
      key: 'extra_usage',
      label: 'Extra usage',
      percentUsed: clamp(extra.utilization as number),
      resetsAt: null,
      ...(num(extra.used_credits) !== null && num(extra.monthly_limit) !== null ? { text: `${extra.used_credits} of ${extra.monthly_limit}${unit ? ` ${unit}` : ''} used` } : {})
    })
  }
  if (windows.length === 0) return null
  return { vendor: 'claude', ...(answer.subscription_type ? { plan: answer.subscription_type } : {}), windows, at }
}

// --- Copilot -------------------------------------------------------------------------------------------

/** What the runtime's `account.getQuota` gives for each kind of quota. */
export interface CopilotQuotaSnapshot {
  isUnlimitedEntitlement?: boolean
  entitlementRequests?: number
  usedRequests?: number
  remainingPercentage?: number
  overage?: number
  overageAllowedWithExhaustedQuota?: boolean
  usageAllowedWithExhaustedQuota?: boolean
  resetDate?: string
}

const COPILOT_LABELS: Record<string, string> = { premium_interactions: 'Premium requests', chat: 'Chat messages', completions: 'Code completions' }

/**
 * Copilot's premium requests first (what a month of agent work is counted in), then chat and completions when they have a limit.
 * Null when the runtime gave nothing it could be read from.
 */
export function copilotUsageFrom(quotas: Record<string, CopilotQuotaSnapshot | undefined> | null | undefined, at: number): VendorUsage | null {
  if (!quotas) return null
  const windows: UsageWindow[] = []
  const notes: string[] = []
  const order = ['premium_interactions', ...Object.keys(quotas).filter((k) => k !== 'premium_interactions')]
  for (const key of order) {
    const q = quotas[key]
    if (!q || typeof q !== 'object') continue
    const label = COPILOT_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    const resetsAt = when(q.resetDate)
    if (q.isUnlimitedEntitlement === true || q.entitlementRequests === -1) {
      // Chat and completions are unlimited on most plans; they are not worth a row. Premium requests say so.
      if (key === 'premium_interactions') windows.push({ key, label, percentUsed: null, resetsAt, unlimited: true, text: 'Unlimited' })
      continue
    }
    const used = num(q.usedRequests)
    const entitlement = num(q.entitlementRequests)
    const remaining = num(q.remainingPercentage)
    const percentUsed = remaining !== null ? clamp(100 - remaining) : used !== null && entitlement && entitlement > 0 ? clamp((used / entitlement) * 100) : null
    if (percentUsed === null) continue
    windows.push({ key, label, percentUsed, resetsAt, ...(used !== null && entitlement !== null ? { text: `${used} of ${entitlement} used` } : {}) })
    if (key === 'premium_interactions') {
      if ((num(q.overage) ?? 0) > 0) notes.push(`${q.overage} extra request${q.overage === 1 ? '' : 's'} at pay-per-request rates this month.`)
      else if (q.overageAllowedWithExhaustedQuota === true || q.usageAllowedWithExhaustedQuota === true) notes.push('Requests beyond the allowance are allowed, at pay-per-request rates.')
    }
  }
  if (windows.length === 0) return null
  return { vendor: 'copilot', windows, ...(notes.length ? { note: notes.join(' ') } : {}), at }
}

// --- the service ---------------------------------------------------------------------------------------

/** Reads one vendor. Null: nothing to show for this account (and an old reading is dropped). Throws: it could not be read this time. */
export type UsageReader = () => Promise<VendorUsage | null>

export interface UsageDeps {
  readers: Partial<Record<VendorId, UsageReader>>
  /** The vendors the person has connected. Nothing is asked of any other. */
  connected: () => VendorId[]
  /** What was kept from the last run, so the strip is not empty at start. */
  load: () => VendorUsage[]
  save: (all: VendorUsage[]) => void
  /** Something changed. */
  changed: () => void
  now?: () => number
  /** How long a reading may take. */
  timeoutMs?: number
  /** The least time between two readings of one vendor that the end of a turn asks for. */
  turnGapMs?: number
}

export class UsageService {
  private kept = new Map<VendorId, VendorUsage>()
  private readonly running = new Map<VendorId, Promise<void>>()
  private readonly lastTurnRead = new Map<VendorId, number>()
  /** Vendors whose reader said there is nothing to show, so a turn does not ask again every time. */
  private readonly none = new Set<VendorId>()
  /** Something was learned that has not been saved and announced yet. */
  private dirty = false

  constructor(private readonly deps: UsageDeps) {
    for (const u of deps.load()) if (u && typeof u.vendor === 'string' && Array.isArray(u.windows)) this.kept.set(u.vendor, u)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** What is known about each connected vendor, without asking anyone. */
  get(): VendorUsage[] {
    const connected = this.deps.connected()
    return [...this.kept.values()].filter((u) => connected.includes(u.vendor))
  }

  /** Asks the connected vendors (or one) again, together, and answers with what is known. A vendor that cannot be read keeps its last answer. */
  async refresh(vendor?: VendorId): Promise<VendorUsage[]> {
    const connected = this.deps.connected()
    // Never for a vendor that is not connected, and nothing at all when none is.
    const wanted = connected.filter((v) => (!vendor || v === vendor) && this.deps.readers[v])
    await Promise.all(wanted.map((v) => this.read(v)))
    // A vendor that was disconnected no longer shows or counts.
    for (const v of [...this.kept.keys()]) {
      if (connected.includes(v)) continue
      this.kept.delete(v)
      this.dirty = true
    }
    // One save and one announcement for everything learned together.
    if (this.dirty) {
      this.dirty = false
      this.deps.save([...this.kept.values()])
      this.deps.changed()
    }
    return this.get()
  }

  /** A turn of this vendor ended: usage has changed. Asked again, but not more than once in a while. */
  afterTurn(vendor: VendorId): void {
    const gap = this.deps.turnGapMs ?? 60_000
    const now = this.now()
    if (this.none.has(vendor) || now - (this.lastTurnRead.get(vendor) ?? 0) < gap) return
    this.lastTurnRead.set(vendor, now)
    void this.refresh(vendor).catch(() => undefined)
  }

  private read(vendor: VendorId): Promise<void> {
    const reader = this.deps.readers[vendor]
    if (!reader) return Promise.resolve()
    // Two askers at once share one reading.
    const already = this.running.get(vendor)
    if (already) return already
    const job = (async () => {
      let next: VendorUsage | null | undefined
      let failed = false
      try {
        next = await withTimeout(reader(), this.deps.timeoutMs ?? 30_000)
      } catch {
        failed = true
      }
      const before = this.kept.get(vendor)
      if (failed) {
        // The last answer stays, marked as not updated. With no last answer there is nothing to show.
        if (before) this.kept.set(vendor, { ...before, failedAt: this.now() })
      } else if (next) {
        this.none.delete(vendor)
        this.kept.set(vendor, { ...next, vendor, at: next.at || this.now() })
      } else {
        this.none.add(vendor)
        this.kept.delete(vendor)
      }
      if (JSON.stringify(before) !== JSON.stringify(this.kept.get(vendor))) this.dirty = true
    })().finally(() => this.running.delete(vendor))
    this.running.set(vendor, job)
    return job
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Reading the usage took too long.')), ms)))]).finally(() => clearTimeout(timer))
}
