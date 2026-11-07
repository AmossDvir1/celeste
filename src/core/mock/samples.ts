import type { ApprovalMode, AttachmentInfo, Effort, SessionMode, ToolKind } from '@shared/agent'
import type { LogEvent } from '@shared/api'
import { checkoutDiff } from './diffs'

/*
 * Sample sessions for the design preview. They match the sidebar in design/Design.jpeg and are written as
 * event logs, so opening one replays exactly what a live conversation would have recorded.
 */

export interface SampleEvent {
  at: number
  event: LogEvent
}

export interface SampleSession {
  id: string
  mode: SessionMode
  title: string
  model: string
  effort: Effort | null
  approval: ApprovalMode
  cwd?: string
  branch?: string
  createdAt: number
  events: SampleEvent[]
}

const DAY = 86_400_000

/** The given clock time today, or yesterday when that time has not come yet. */
function today(h: number, m: number): number {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime() > Date.now() ? d.getTime() - DAY : d.getTime()
}
function daysAgo(n: number, h: number, m: number): number {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

/** Writes one conversation as events, moving a clock forward as it goes. */
class Script {
  readonly events: SampleEvent[] = []
  private at: number
  private tools = 0
  private turns = 0

  constructor(
    private readonly id: string,
    start: number
  ) {
    this.at = start
  }

  private add(event: LogEvent, waitMs = 0): this {
    this.events.push({ at: this.at, event })
    this.at += waitMs
    return this
  }

  user(text: string, attachments: AttachmentInfo[] = []): this {
    return this.add({ type: 'user.message', text, attachments }, 300).add({ type: 'turn.started', turnId: `${this.id}-turn${this.turns++}` }, 700)
  }
  /** The next event closes the thinking, so `seconds` is how long it shows as "Thought for". */
  think(text: string, seconds: number): this {
    return this.add({ type: 'thinking.delta', text }, seconds * 1000)
  }
  tool(kind: ToolKind, title: string, output = '', extra: { input?: string; diff?: typeof checkoutDiff; seconds?: number } = {}): this {
    const id = `${this.id}-t${this.tools++}`
    const run = (extra.seconds ?? 1.8) * 1000
    this.add({ type: 'tool.started', id, kind, title, input: extra.input }, run / 2)
    if (output) this.add({ type: 'tool.output', id, text: output }, run / 2)
    else this.at += run / 2
    return this.add({ type: 'tool.completed', id, ok: true, diff: extra.diff }, 400)
  }
  say(text: string): this {
    return this.add({ type: 'message.delta', text }, 1500)
  }
  done(): SampleEvent[] {
    this.add({ type: 'turn.completed', turnId: `${this.id}-turn${this.turns - 1}` })
    return this.events
  }
}

function buildErrorShot(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#0d1117"/>
  <rect width="960" height="38" fill="#161b22"/>
  <circle cx="22" cy="19" r="6" fill="#ff5f56"/><circle cx="44" cy="19" r="6" fill="#ffbd2e"/><circle cx="66" cy="19" r="6" fill="#27c93f"/>
  <text x="90" y="24" font-family="monospace" font-size="13" fill="#8b949e">build — pwsh</text>
  <g font-family="monospace" font-size="17">
    <text x="28" y="84" fill="#8b949e">&gt; npm run build</text>
    <text x="28" y="124" fill="#c9d1d9">vite v8.3.6 building for production...</text>
    <text x="28" y="152" fill="#c9d1d9">transforming (1204) src/features/orders/OrderTable.tsx</text>
    <text x="28" y="196" fill="#ff7b72">error during build:</text>
    <text x="28" y="224" fill="#ff7b72">src/features/orders/OrderTable.tsx:48:21 - error TS2339:</text>
    <text x="28" y="252" fill="#ff7b72">Property 'totalCents' does not exist on type 'Order'.</text>
    <text x="28" y="296" fill="#c9d1d9">  46 |   const rows = orders.map((o) =&gt; ({</text>
    <text x="28" y="324" fill="#c9d1d9">  47 |     id: o.id,</text>
    <text x="28" y="352" fill="#ffa657">&gt; 48 |     total: format(o.totalCents),</text>
    <text x="28" y="380" fill="#ff7b72">     |                     ^^^^^^^^^^</text>
    <text x="28" y="436" fill="#8b949e">Found 1 error in 1 file.</text>
  </g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function wfoSession(): SampleSession {
  const t = today(11, 19)
  const events = new Script('wfo', t)
    .user('Analyze the WFO logs from the last 24h and tell me what stands out.')
    .think('Pull the log window from Datadog, group errors by signature, then check what changed around the spikes.', 7)
    .tool('mcp', 'Datadog · search logs (service:wfo, last 24h)', '14,882 events\n  ERROR  1,204\n  WARN   3,917\n  INFO   9,761')
    .tool('read', 'Read wfo-service-2026-11-06.log')
    .tool('search', 'Searched for "KbInstallTimeout"', '212 matches in 3 files')
    .say(`## What stands out

Three things in the last 24 hours, in order of impact:

| # | Signal | Count | When |
|---|---|---|---|
| 1 | \`KbInstallTimeout\` on the install step | 212 | 02:10 – 03:40 |
| 2 | \`ServiceNotReady\` after reboot | 87 | right after each timeout |
| 3 | Slow \`ListInstalledKbs\` (> 8 s) | 41 | all day, worse after 14:00 |

**The timeouts and the "not ready" errors are one problem.** Every \`ServiceNotReady\` follows a \`KbInstallTimeout\` within about 90 seconds, which is the reboot the installer triggers. The install step waits 120 s for the service, but on the affected hosts it needs closer to 200 s.

\`\`\`text
02:14:09 ERROR KbInstallTimeout host=wfo-vm-17 kb=KB5041585 waited=120s
02:15:31 ERROR ServiceNotReady host=wfo-vm-17 state=Starting
\`\`\`

### Suggested next steps
1. Raise the wait for the service to 240 s on hosts with the slow disk profile.
2. Add a \`Wait for service\` step with a health probe instead of a fixed delay.
3. Look at why \`ListInstalledKbs\` slows down after 14:00. It correlates with the nightly scan job.

I can turn steps 1 and 2 into a workflow if you like.`)
    .done()
  return { id: 'seed-wfo', mode: 'chat', title: 'Analyze WFO logs', model: 'copilot-auto', effort: null, approval: 'auto', createdAt: t, events }
}

function checkoutSession(): SampleSession {
  const t = today(10, 5)
  const events = new Script('checkout', t)
    .user('The checkout totals test fails about one run in five. Find out why and fix it.')
    .think('A test that fails intermittently is usually a timing assumption. I will read the test and the code it exercises.', 9)
    .tool('read', 'Read src/checkout/__tests__/checkout.spec.ts', '', { input: 'src/checkout/__tests__/checkout.spec.ts' })
    .tool('read', 'Read src/checkout/pricing.ts', '', { input: 'src/checkout/pricing.ts' })
    .tool('search', 'Searched for "sleep(" in src', 'src/checkout/__tests__/checkout.spec.ts:34:    await sleep(50)\nsrc/cart/__tests__/cart.spec.ts:12:    await sleep(10)')
    .say('Found it. The test waits a fixed 50 ms for the pricing service to resolve, and on a busy machine that is sometimes not enough. I will make the test wait for the real condition instead.')
    .tool('edit', 'Edited 2 files', '', { diff: checkoutDiff })
    .tool(
      'shell',
      'npm test -- checkout',
      '> shop-web@2.4.0 test\n> vitest run checkout\n\n ✓ src/checkout/__tests__/checkout.spec.ts (14 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)\n   Duration  1.31s',
      { input: 'npm test -- checkout', seconds: 3 }
    )
    .tool('shell', 'npm test -- checkout (x20)', 'Ran the suite 20 times in a loop.\n20 passed, 0 failed', { input: 'for i in 1..20: npm test -- checkout', seconds: 16 })
    .say(`The flaky test is fixed. It was racing the pricing service.

**What changed**
- \`checkout.spec.ts\`: replaced the fixed \`sleep(50)\` with \`waitFor\` on the real condition.
- \`pricing.ts\`: added \`pending()\` so tests can see whether quotes are still resolving.

I ran the checkout suite 20 times in a row and all passed. \`cart.spec.ts\` has the same \`sleep(10)\` pattern, so it may flake the same way. Want me to fix that one too?`)
    .done()
  return {
    id: 'seed-checkout',
    mode: 'develop',
    title: 'Fix flaky checkout test',
    model: 'claude-sonnet',
    effort: 'medium',
    approval: 'auto',
    cwd: 'D:\\Work\\shop-web',
    branch: 'fix/flaky-checkout',
    createdAt: t,
    events
  }
}

function buildFailureSession(): SampleSession {
  const t = today(8, 27)
  const shot: AttachmentInfo = {
    id: 'seed-shot',
    name: 'build-error.png',
    mime: 'image/svg+xml',
    size: 184_320,
    url: buildErrorShot(),
    width: 960,
    height: 540
  }
  const events = new Script('build', t)
    .user('The build breaks on my machine after pulling main. Here is the output.', [shot])
    .think('The error is a missing property on the Order type. Check whether the field was renamed upstream.', 4)
    .tool('search', 'Searched for "totalCents"', 'src/features/orders/OrderTable.tsx:48\nsrc/api/orders.ts:22  (type Order = { ..., total: number })')
    .say(`The build fails because \`OrderTable.tsx\` still reads \`o.totalCents\`, but the API type was changed in \`src/api/orders.ts\`. The field is now \`total\`, in cents.

Change line 48 to \`format(o.total)\` and the build should pass. If other files break the same way, search for \`totalCents\`.`)
    .done()
  return { id: 'seed-build', mode: 'chat', title: 'Investigate build failure', model: 'copilot-auto', effort: null, approval: 'auto', createdAt: t, events }
}

function brief(id: string, title: string, at: number, question: string, answer: string, mode: SessionMode = 'chat', cwd?: string): SampleSession {
  const events = new Script(id, at).user(question).say(answer).done()
  return {
    id,
    mode,
    title,
    model: mode === 'develop' ? 'claude-sonnet' : 'copilot-auto',
    effort: mode === 'develop' ? 'medium' : null,
    approval: 'auto',
    cwd,
    branch: cwd ? 'main' : undefined,
    createdAt: at,
    events
  }
}

export function sampleSessions(): SampleSession[] {
  return [
    wfoSession(),
    brief('seed-kb', 'Plan KB update', today(9, 42), 'Plan the rollout of the November KB updates across the WFO servers.', 'Here is a staged plan.\n\n1. **Canary** — two hosts, install, wait for the service, check logs for 30 minutes.\n2. **Wave 1** — 20% of hosts, one hour apart.\n3. **Wave 2** — the rest, outside business hours.\n\nEach wave stops if more than one host reports `ServiceNotReady`.'),
    buildFailureSession(),
    brief('seed-react', 'React component review', daysAgo(1, 16, 20), 'Review the OrderTable component for accessibility.', 'Three issues: the sortable headers are `div`s with click handlers (use `button` inside `th`), the row selection has no keyboard path, and the empty state is not announced to screen readers.'),
    brief('seed-api', 'Design API flow', daysAgo(1, 13, 5), 'Sketch the API flow for exporting reports as CSV.', 'Use an asynchronous job: `POST /exports` returns an id, the client polls `GET /exports/{id}`, and a finished job returns a signed download URL that expires after 15 minutes.'),
    brief('seed-harness', 'Harness deployment issue', daysAgo(1, 9, 48), 'Why did the Harness pipeline skip the verify step?', 'The step has a conditional execution rule that checks `<+stage.variables.env>`. The variable is empty for the canary stage, so the condition evaluates false and the step is skipped.'),
    brief('seed-jira', 'Summarize Jira backlog', daysAgo(3, 15, 12), 'Summarize the open bugs in the SC project by theme.', 'Four themes: install timeouts (9), report exports (6), permission errors (4), and UI polish (11).'),
    brief('seed-notes', 'Draft release notes', daysAgo(4, 11, 30), 'Draft release notes for 2.4.0 from the merged pull requests.', '**2.4.0** adds CSV export, fixes the flaky checkout totals, and improves install reliability on slow disks.'),
    checkoutSession(),
    brief('seed-dark', 'Add dark mode toggle', today(8, 50), 'Add a dark mode toggle to the settings page.', 'Added a `ThemeToggle` to `SettingsPage` that stores the choice in `localStorage` and sets `data-theme` on `<html>`. It follows the system setting until you choose.', 'develop', 'D:\\Work\\shop-web'),
    brief('seed-auth', 'Refactor auth middleware', daysAgo(1, 14, 2), 'Split the auth middleware into token parsing and permission checks.', 'Split into `parseToken` and `requirePermission`. Routes now compose them, and the 11 existing tests pass unchanged.', 'develop', 'D:\\Work\\wfo-tools'),
    brief('seed-kbscan', 'Speed up KB scanner', daysAgo(2, 10, 15), 'The KB scanner takes four minutes per host. Make it faster.', 'Scanning installed updates one by one was the bottleneck. It now queries them in a single call and caches the result for 10 minutes: about 12 seconds per host.', 'develop', 'D:\\Work\\kb-scanner')
  ]
}
