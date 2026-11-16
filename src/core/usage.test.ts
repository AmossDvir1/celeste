import { describe, expect, it } from 'vitest'
import type { VendorId } from '@shared/agent'
import { untilText, usageLevel, type VendorUsage } from '@shared/usage'
import { claudeUsageFrom, copilotUsageFrom, UsageService, type ClaudeUsageAnswer, type UsageReader } from './usage'

const AT = Date.parse('2026-11-16T12:00:00Z')

/*
 * The shapes below are what the SDKs declare (Claude's `usage_EXPERIMENTAL…` answer, sdk.d.ts SDKControlGetUsageResponse; Copilot's
 * `account.getQuota`, rpc.d.ts AccountGetQuotaResult), written out by hand: no account was available to record a real answer.
 */
const plan: ClaudeUsageAnswer = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42.5, resets_at: '2026-11-16T15:12:00Z' },
    seven_day: { utilization: 81, resets_at: '2026-11-20T00:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 12, resets_at: '2026-11-20T00:00:00Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 96.4, resets_at: '2026-11-20T00:00:00Z' }],
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'USD' }
  }
}

describe('Claude’s usage', () => {
  it('lists the 5-hour session first, then the week, and the weekly meters of single models, each with its reset time', () => {
    const u = claudeUsageFrom(plan, AT) as VendorUsage
    expect(u.vendor).toBe('claude')
    expect(u.plan).toBe('max')
    expect(u.windows.map((w) => [w.key, w.label, w.percentUsed])).toEqual([
      ['five_hour', '5-hour session', 42.5],
      ['seven_day', '7-day', 81],
      ['seven_day_sonnet', '7-day Sonnet', 12],
      ['model_fable', '7-day Fable', 96.4],
      ['extra_usage', 'Extra usage', 25]
    ])
    expect(u.windows[0]?.resetsAt).toBe(Date.parse('2026-11-16T15:12:00Z'))
    expect(u.windows[4]).toMatchObject({ text: '12.5 of 50 USD used', resetsAt: null })
    expect(u.at).toBe(AT)
  })

  it('has nothing to show for an API key, where plan limits do not apply (and so for every Celeste release)', () => {
    expect(claudeUsageFrom({ subscription_type: null, rate_limits_available: false, rate_limits: null }, AT)).toBeNull()
    expect(claudeUsageFrom(null, AT)).toBeNull()
    expect(claudeUsageFrom({ rate_limits_available: true, rate_limits: {} }, AT)).toBeNull()
  })

  it('leaves out a meter with no number, keeps the rest, and keeps a percentage within 0 to 100', () => {
    const u = claudeUsageFrom({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 130, resets_at: 'not a date' } } }, AT) as VendorUsage
    expect(u.windows).toEqual([{ key: 'seven_day', label: '7-day', percentUsed: 100, resetsAt: null }])
  })

  it('shows extra usage only when it is switched on', () => {
    const u = claudeUsageFrom({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: null }, extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: 0 } } }, AT) as VendorUsage
    expect(u.windows.map((w) => w.key)).toEqual(['five_hour'])
  })
})

describe('Copilot’s usage', () => {
  it('shows premium requests used, of how many, and when they come back, with chat and completions when they have a limit', () => {
    const u = copilotUsageFrom(
      {
        chat: { isUnlimitedEntitlement: true, entitlementRequests: -1, usedRequests: 0, remainingPercentage: 100 },
        completions: { isUnlimitedEntitlement: false, entitlementRequests: 2000, usedRequests: 500, remainingPercentage: 75, resetDate: '2026-12-01T00:00:00Z' },
        premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 212, remainingPercentage: 29.3, overage: 0, overageAllowedWithExhaustedQuota: false, resetDate: '2026-12-01T00:00:00Z' }
      },
      AT
    ) as VendorUsage
    expect(u.windows.map((w) => [w.key, w.label, w.percentUsed, w.text])).toEqual([
      ['premium_interactions', 'Premium requests', 70.7, '212 of 300 used'],
      ['completions', 'Code completions', 25, '500 of 2000 used']
    ])
    expect(u.windows[0]?.resetsAt).toBe(Date.parse('2026-12-01T00:00:00Z'))
    expect(u.note).toBeUndefined()
  })

  it('says unlimited when premium requests are, with no bar to fill', () => {
    const u = copilotUsageFrom({ premium_interactions: { isUnlimitedEntitlement: true, entitlementRequests: -1, usedRequests: 40, remainingPercentage: 100 } }, AT) as VendorUsage
    expect(u.windows).toEqual([{ key: 'premium_interactions', label: 'Premium requests', percentUsed: null, resetsAt: null, unlimited: true, text: 'Unlimited' }])
  })

  it('says when requests beyond the allowance cost money, and how many did', () => {
    const allowed = copilotUsageFrom({ premium_interactions: { entitlementRequests: 300, usedRequests: 300, remainingPercentage: 0, overage: 0, overageAllowedWithExhaustedQuota: true } }, AT) as VendorUsage
    expect(allowed.note).toBe('Requests beyond the allowance are allowed, at pay-per-request rates.')
    const used = copilotUsageFrom({ premium_interactions: { entitlementRequests: 300, usedRequests: 310, remainingPercentage: 0, overage: 10, overageAllowedWithExhaustedQuota: true } }, AT) as VendorUsage
    expect(used.note).toBe('10 extra requests at pay-per-request rates this month.')
    expect(used.windows[0]?.percentUsed).toBe(100)
  })

  it('works out the percentage itself when the runtime gives only the counts, and shows nothing for an answer it cannot read', () => {
    const counts = copilotUsageFrom({ premium_interactions: { entitlementRequests: 200, usedRequests: 50 } }, AT) as VendorUsage
    expect(counts.windows[0]?.percentUsed).toBe(25)
    expect(copilotUsageFrom({}, AT)).toBeNull()
    expect(copilotUsageFrom(null, AT)).toBeNull()
    expect(copilotUsageFrom({ premium_interactions: {} }, AT)).toBeNull()
  })
})

describe('the usage service', () => {
  const usage = (vendor: VendorId, percent = 10, at = 1): VendorUsage => ({ vendor, windows: [{ key: 'm', label: 'Meter', percentUsed: percent, resetsAt: null }], at })

  function world(over: { connected?: VendorId[]; kept?: VendorUsage[]; readers?: Partial<Record<VendorId, UsageReader>>; turnGapMs?: number } = {}) {
    let clock = 1_000_000
    const asked: VendorId[] = []
    const saves: VendorUsage[][] = []
    let changes = 0
    const state = { connected: over.connected ?? (['claude', 'copilot'] as VendorId[]) }
    const reader = (v: VendorId, answer: VendorUsage | null | Error): UsageReader => async () => {
      asked.push(v)
      if (answer instanceof Error) throw answer
      return answer
    }
    const service = new UsageService({
      readers: over.readers ?? { claude: reader('claude', usage('claude')), copilot: reader('copilot', usage('copilot', 70)) },
      connected: () => state.connected,
      load: () => over.kept ?? [],
      save: (all) => saves.push(all),
      changed: () => changes++,
      now: () => clock,
      turnGapMs: over.turnGapMs ?? 60_000
    })
    return { service, asked, saves, state, changes: () => changes, tick: (ms: number) => (clock += ms), reader }
  }

  it('asks the connected vendors, together, saves what it learned and says something changed', async () => {
    const w = world()
    expect(w.service.get()).toEqual([])
    const all = await w.service.refresh()
    expect(all.map((u) => u.vendor).sort()).toEqual(['claude', 'copilot'])
    expect(w.asked.sort()).toEqual(['claude', 'copilot'])
    // Both were learned together: one save, one announcement.
    expect(w.saves).toHaveLength(1)
    expect(w.saves[0]).toHaveLength(2)
    expect(w.changes()).toBe(1)
  })

  it('asks nobody that is not connected, and nothing at all when none is', async () => {
    const w = world({ connected: ['copilot'] })
    await w.service.refresh()
    expect(w.asked).toEqual(['copilot'])
    const none = world({ connected: [] })
    expect(await none.service.refresh()).toEqual([])
    expect(none.asked).toEqual([])
    // A vendor with no reader (OpenAI, Gemini) is left alone too.
    const other = world({ connected: ['openai', 'gemini'] })
    await other.service.refresh()
    expect(other.asked).toEqual([])
  })

  it('asks only the vendor it was asked about', async () => {
    const w = world()
    await w.service.refresh('copilot')
    expect(w.asked).toEqual(['copilot'])
  })

  it('shows what was kept from last time at once, without asking, only for vendors that are still connected', () => {
    const w = world({ kept: [usage('claude', 5), usage('copilot', 50)], connected: ['copilot'] })
    expect(w.service.get().map((u) => u.vendor)).toEqual(['copilot'])
    expect(w.asked).toEqual([])
  })

  it('keeps the last answer, marked as not updated, when a reading fails, and says so once', async () => {
    const w = world({ kept: [usage('copilot', 50, 7)], readers: { copilot: undefined } })
    const failing = world({ kept: [usage('copilot', 50, 7)] })
    failing.service['deps'].readers.copilot = failing.reader('copilot', new Error('no network'))
    const all = await failing.service.refresh('copilot')
    expect(all[0]).toMatchObject({ vendor: 'copilot', at: 7, failedAt: 1_000_000, windows: [{ percentUsed: 50 }] })
    expect(failing.changes()).toBe(1)
    await failing.service.refresh('copilot')
    expect(failing.changes()).toBe(1)
    void w
  })

  it('clears the mark when the next reading works', async () => {
    const w = world({ kept: [{ ...usage('copilot', 50, 7), failedAt: 9 }], readers: {} })
    w.service['deps'].readers.copilot = w.reader('copilot', usage('copilot', 60, 2_000_000))
    const [u] = await w.service.refresh('copilot')
    expect(u).toMatchObject({ at: 2_000_000, windows: [{ percentUsed: 60 }] })
    expect(u).not.toHaveProperty('failedAt')
  })

  it('has nothing for a failed reading when it knew nothing before', async () => {
    const w = world({ readers: {} })
    w.service['deps'].readers.claude = w.reader('claude', new Error('boom'))
    expect(await w.service.refresh('claude')).toEqual([])
    expect(w.saves).toHaveLength(0)
  })

  it('drops an old answer when the vendor now has nothing to show (a key in place of a plan)', async () => {
    const w = world({ kept: [usage('claude', 90)], readers: {} })
    w.service['deps'].readers.claude = w.reader('claude', null)
    expect(await w.service.refresh('claude')).toEqual([])
    expect(w.saves.at(-1)).toEqual([])
  })

  it('gives up on a reading that takes too long, and keeps the last answer', async () => {
    const service = new UsageService({
      readers: { copilot: () => new Promise<never>(() => undefined) },
      connected: () => ['copilot'],
      load: () => [usage('copilot', 50, 3)],
      save: () => undefined,
      changed: () => undefined,
      timeoutMs: 20
    })
    const [u] = await service.refresh('copilot')
    expect(u).toMatchObject({ at: 3 })
    expect(u?.failedAt).toBeGreaterThan(0)
  })

  it('shares one reading between two askers at once', async () => {
    const w = world()
    await Promise.all([w.service.refresh('copilot'), w.service.refresh('copilot')])
    expect(w.asked).toEqual(['copilot'])
  })

  it('asks again after a turn, but not more than once a minute, and never for a vendor that had nothing to show', async () => {
    const w = world()
    w.service.afterTurn('copilot')
    w.service.afterTurn('copilot')
    await new Promise((r) => setTimeout(r, 10))
    expect(w.asked).toEqual(['copilot'])
    w.tick(61_000)
    w.service.afterTurn('copilot')
    await new Promise((r) => setTimeout(r, 10))
    expect(w.asked).toEqual(['copilot', 'copilot'])
    // Claude with an API key has nothing: the turn does not ask again and again.
    const key = world({ readers: {} })
    key.service['deps'].readers.claude = key.reader('claude', null)
    await key.service.refresh('claude')
    key.tick(120_000)
    key.service.afterTurn('claude')
    await new Promise((r) => setTimeout(r, 10))
    expect(key.asked).toEqual(['claude'])
  })

  it('forgets a vendor that was disconnected', async () => {
    const w = world()
    await w.service.refresh()
    w.state.connected = ['claude']
    expect((await w.service.refresh()).map((u) => u.vendor)).toEqual(['claude'])
  })
})

describe('how usage reads', () => {
  it('colours from 80% amber and from 95% red, and unlimited never', () => {
    expect([0, 79.9, 80, 94.9, 95, 100].map(usageLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'limit', 'limit'])
    expect(usageLevel(null)).toBe('ok')
  })

  it('says how long until a reset', () => {
    const now = 1_000_000_000
    expect(untilText(now - 5, now)).toBe('now')
    expect(untilText(now + 20_000, now)).toBe('under a minute')
    expect(untilText(now + 5 * 60_000, now)).toBe('5 min')
    expect(untilText(now + (3 * 60 + 12) * 60_000, now)).toBe('3 h 12 min')
    expect(untilText(now + 4 * 3_600_000, now)).toBe('4 h')
    expect(untilText(now + 3 * 86_400_000, now)).toBe('3 days')
    expect(untilText(now + 86_400_000, now)).toBe('1 day')
  })
})
