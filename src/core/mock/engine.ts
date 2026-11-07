import type {
  AgentError,
  AgentEvent,
  AgentSession,
  ApprovalAnswer,
  ApprovalMode,
  AskAnswers,
  Effort,
  FileDiff,
  Question,
  SessionMode,
  ToolKind,
  UserInput
} from '@shared/agent'
import type { CallHooks, ToolOutput } from '../devices/tools'
import { EventQueue } from '../adapters/event-queue'
import { validationDiff } from './diffs'

/*
 * The mock agent. It plays scripted scenarios through the same AgentEvent stream real vendors will use,
 * so the screens approved in Phase 1 are the screens real adapters plug into later.
 */

export type ScenarioId = 'auto' | 'ask' | 'error' | 'stuck-thinking' | 'stuck-tool' | 'devices'

/** The device tools, bound to this session. They apply the access levels and ask for approval themselves. */
export interface DevicePort {
  call(name: string, args: Record<string, unknown>, hooks?: CallHooks): Promise<ToolOutput>
}

class Aborted extends Error {}
class Failure extends Error {
  constructor(public readonly error: AgentError) {
    super(error.message)
  }
}

let uid = 0
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`

interface ToolSpec {
  kind: ToolKind
  title: string
  input?: string
  /** Lines streamed into the output while the tool runs. */
  output?: string[]
  diff?: FileDiff[]
  ms?: number
  fails?: boolean
}

interface Ctx {
  input: UserInput
  mode: SessionMode
  approval: () => ApprovalMode
  say: (text: string) => Promise<void>
  think: (text: string) => Promise<void>
  /** Runs a tool. Asks first when the approval mode requires it. False when the user said no or nothing ran. */
  tool: (spec: ToolSpec) => Promise<boolean>
  ask: (questions: Question[]) => Promise<AskAnswers>
  sleep: (ms: number) => Promise<void>
  fail: (error: AgentError) => never
  emit: (e: AgentEvent) => void
  /** True while a tool is never going to finish (the "tool running" demo). */
  hang: () => Promise<never>
  /** Calls a device tool and shows it as a tool card. The tool itself decides whether the user must approve. */
  device: (name: string, args: Record<string, unknown>, title: string, kind: ToolKind) => Promise<ToolOutput>
  hasDevices: boolean
}

function needsApproval(kind: ToolKind, mode: ApprovalMode): boolean {
  if (mode === 'auto' || mode === 'plan') return false
  if (kind === 'read' || kind === 'search') return false
  if (mode === 'edits') return kind === 'shell' || kind === 'web' || kind === 'mcp' || kind === 'agent'
  return true // 'ask'
}

const short = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)

async function chatScenario(c: Ctx): Promise<void> {
  const text = c.input.text
  const lower = text.toLowerCase()

  await c.think(`The request is: “${short(text, 90)}”. I will gather what I need, then answer plainly.`)

  for (const a of c.input.attachments) {
    await c.tool({ kind: 'read', title: `Read ${a.name}`, input: a.name, ms: 900 })
  }

  if (/pr\s*#?\d+|pull request/.test(lower)) {
    const n = /#?(\d{3,})/.exec(text)?.[1] ?? '3421'
    await c.tool({ kind: 'mcp', title: `GitHub · get pull request #${n}`, output: ['title: Retry installs when the service is slow', 'files changed: 6   +142 −38'], ms: 1100 })
    await c.tool({ kind: 'mcp', title: 'GitHub · list review comments', output: ['2 open threads'], ms: 800 })
    await c.say(`## Review of #${n}

**Overall:** good change, one real concern and two small ones.

1. **Retry loop has no upper bound** (\`installer.ts\`). A host that never recovers retries forever. Cap it, for example at 5 attempts with backoff.
2. The new \`waitForService\` default of 240 s is documented in the code but not in \`README\`.
3. A test covers the happy path only. Add one where the service never becomes ready.

I would approve once the retry cap is in.`)
    return
  }

  if (/jira|sc-\d+/.test(lower)) {
    const key = /sc-\d+/i.exec(text)?.[0].toUpperCase() ?? 'SC-1234'
    await c.tool({ kind: 'mcp', title: `Atlassian · get issue ${key}`, output: ['status: In Progress', 'assignee: you', 'linked: 3 issues'], ms: 1000 })
    await c.say(`## ${key}: summary

**Problem:** installs time out on hosts with slow disks.

**Status:** in progress, 3 linked issues. Two are duplicates of the same timeout.

**What is missing:** a decision on the wait time. The ticket proposes a fixed 240 s, but a health check would remove the guesswork.

Want me to draft a comment for the ticket?`)
    return
  }

  if (/workflow|deploy|automate/.test(lower)) {
    await c.tool({ kind: 'search', title: 'Searched for deployment steps in the repo', output: ['3 matches'], ms: 900 })
    await c.say(`Here is a deployment workflow that fits what is in the repository:

1. **Build** the service image.
2. **Run tests**, stop on failure.
3. **Deploy to staging** and wait for the health check.
4. **Ask you** to approve the production rollout.
5. **Deploy to production**, then post a summary.

Open the **Workflows** tab to build this as a workflow with a Tool step for each stage and an Agent step for the summary.`)
    return
  }

  if (/search|latest|news|price|compare/.test(lower)) {
    await c.tool({ kind: 'web', title: `Searched the web for “${short(text, 40)}”`, output: ['6 results'], ms: 1500 })
    await c.tool({ kind: 'web', title: 'Read a web page', output: ['2,140 words'], ms: 1200 })
  }

  await c.say(`Here is how I would approach this.

**Short answer:** it can be done in three steps, and the first one is the only one with risk.

| Step | What happens | Risk |
|---|---|---|
| 1 | Gather the current state | none |
| 2 | Make the change in a copy | low |
| 3 | Verify, then switch over | medium |

I can start on step 1 right now. Tell me if you would rather go through the plan first.`)
}

async function developScenario(c: Ctx): Promise<void> {
  await c.think(`The request is: “${short(c.input.text, 90)}”. I will read the code first, then change as little as possible.`)
  await c.tool({ kind: 'read', title: 'Read src/auth/LoginForm.tsx', input: 'src/auth/LoginForm.tsx', ms: 900 })
  await c.tool({ kind: 'search', title: 'Searched for "validate" in src', output: ['src/auth/LoginForm.tsx:21', 'src/signup/SignupForm.tsx:34'], ms: 1000 })

  if (c.approval() === 'plan') {
    await c.say(`I looked at the code and have a plan. Nothing was changed.

1. Add \`validateLogin\` in \`src/auth/validateLogin.ts\` (email format, minimum password length).
2. Call it from \`LoginForm\` before submitting and show the errors under each field.
3. Add tests for the valid and invalid cases.
4. Run the suite.

Switch to **Auto-approve** or **Ask first** and say go, and I will do it.`)
    return
  }

  await c.say('The form submits without checking anything. I will add a small validator and show the errors inline.')
  const edited = await c.tool({ kind: 'edit', title: 'Edited 2 files', diff: validationDiff, ms: 1400 })
  if (!edited) {
    await c.say('Understood, I did not change any files. Tell me what you would like to do instead.')
    return
  }
  const ran = await c.tool({
    kind: 'shell',
    title: 'npm test -- auth',
    input: 'npm test -- auth',
    output: ['> shop-web@2.4.0 test', '> vitest run auth', '', ' ✓ src/auth/validateLogin.spec.ts (6 tests) 38ms', ' ✓ src/auth/LoginForm.spec.tsx (9 tests) 211ms', '', ' Test Files  2 passed (2)', '      Tests  15 passed (15)'],
    ms: 2600
  })
  await c.say(
    ran
      ? `Done. The login form now validates before submitting.

- \`validateLogin.ts\` checks the email format and a minimum password length of 8.
- \`LoginForm.tsx\` shows the message under the field that failed.

All 15 auth tests pass. The signup form has the same gap. Want me to apply the validator there too?`
      : 'I made the changes but did not run the tests. Run `npm test -- auth` when you are ready.'
  )
}

async function askScenario(c: Ctx): Promise<void> {
  await c.think('Two choices change the result a lot. I should ask instead of guessing.')
  await c.say('Before I start, two quick questions.')
  const answers = await c.ask([
    {
      header: 'Scope',
      question: 'Which hosts should this run on?',
      multiSelect: false,
      options: [
        { label: 'Canary only', description: 'Two hosts, safest first step.' },
        { label: 'Staging', description: 'All staging hosts, about 20.' },
        { label: 'Production', description: 'Everything. Needs your approval at the end.' }
      ]
    },
    {
      header: 'Checks',
      question: 'Which checks should run afterwards?',
      multiSelect: true,
      options: [
        { label: 'Service health', description: 'Wait until the service reports ready.' },
        { label: 'Log scan', description: 'Search the last 30 minutes for errors.' },
        { label: 'Disk space', description: 'Fail if less than 10% is free.' }
      ]
    }
  ])
  const scope = answers['Which hosts should this run on?']
  const checks = answers['Which checks should run afterwards?']
  const list = Array.isArray(checks) ? checks.join(', ') : String(checks ?? 'none')
  await c.tool({ kind: 'shell', title: 'wfo-cli plan --dry-run', output: ['planned 2 steps', 'no changes made'], ms: 1500 })
  await c.say(`Got it. I will run on **${String(scope)}** and check: **${list || 'nothing extra'}**.\n\nI did a dry run first and nothing was changed. Say go to run it for real.`)
}

async function errorScenario(c: Ctx): Promise<void> {
  await c.think('Check the status page first, then summarize.')
  await c.tool({ kind: 'web', title: 'Fetched status.example.com', output: ['GET https://status.example.com/api/summary', '429 Too Many Requests'], fails: true, ms: 1200 })
  c.fail({ code: 'rate_limit', message: 'The vendor’s rate limit was reached. Try again in about a minute.', retryable: true })
}

async function stuckThinking(c: Ctx): Promise<void> {
  await c.think('Working through the options for this one. ')
  return c.hang()
}

async function stuckTool(c: Ctx): Promise<void> {
  await c.think('This needs a build first.')
  const id = nextId('t')
  c.emit({ type: 'tool.started', id, kind: 'shell', title: 'npm run build', input: 'npm run build' })
  const lines = ['> shop-web@2.4.0 build', '> vite build', 'vite v8.3.6 building for production...', 'transforming (412) src/features/orders/OrderTable.tsx', 'transforming (860) src/features/reports/ExportButton.tsx']
  for (const line of lines) {
    c.emit({ type: 'tool.output', id, text: `${line}\n` })
    await c.sleep(700)
  }
  return c.hang()
}

/** Looks at the first attached device: reads a folder if it is read only, or runs a command if it may. */
async function devicesScenario(c: Ctx): Promise<void> {
  await c.think('This is about a device. I should see which ones are attached to this chat before doing anything.')
  const list = await c.device('devices_list', {}, 'Devices · list attached devices', 'mcp')
  const first = /^- ([^:\n]+): (\w+)\./m.exec(list.text)
  if (!first) {
    await c.say('No device is attached to this chat yet. Open **Tools & Integrations**, switch a device on, and ask again.')
    return
  }
  const [, name, os] = first
  const line = list.text.split('\n').find((l) => l.startsWith(`- ${name}:`)) ?? ''
  const readOnly = /Access: read only/.test(line)
  const home = os === 'Windows' ? 'C:/Users' : os === 'Android' ? '/sdcard' : '/'

  if (readOnly) {
    await c.think(`${name} is read only, so I can look but not run anything.`)
    const dir = await c.device('device_list_dir', { device: name, path: home }, `List ${home} on ${name}`, 'read')
    await c.say(
      dir.isError
        ? `I could not look at ${name}: ${dir.text}`
        : `${name} is read only, so I only looked. In \`${home}\` there is:\n\n\`\`\`text\n${dir.text}\n\`\`\`\n\nSet the device to **Ask first** in Settings, Devices, if you want me to run commands on it.`
    )
    return
  }

  const command = os === 'Windows' ? 'Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize' : os === 'Android' ? 'df /data' : 'uname -a; df -h /'
  await c.think(`${name} allows commands. Disk space is a safe thing to check first.`)
  const out = await c.device('device_run', { device: name, command }, `Run on ${name}`, 'shell')
  await c.say(
    out.isError
      ? `That did not run on ${name}: ${out.text}`
      : `Here is what \`${name}\` reported:\n\n\`\`\`text\n${out.text}\n\`\`\`\n\nNothing was changed. Want me to look at anything else on it?`
  )
}

const SCENARIOS: Record<Exclude<ScenarioId, 'auto'>, (c: Ctx) => Promise<void>> = {
  devices: devicesScenario,
  ask: askScenario,
  error: errorScenario,
  'stuck-thinking': stuckThinking,
  'stuck-tool': stuckTool
}

export const isScenario = (s: string | undefined): s is ScenarioId => s === 'auto' || (s !== undefined && s in SCENARIOS)

function pick(mode: SessionMode, text: string, forced: string | undefined, hasDevices: boolean): (c: Ctx) => Promise<void> {
  if (isScenario(forced) && forced !== 'auto') return SCENARIOS[forced]
  if (hasDevices && /\b(devices?|vm|phone|my (server|machine)|disk space on)\b/i.test(text)) return devicesScenario
  if (/\b(ask me|ask_user|clarify)\b/i.test(text)) return askScenario
  if (/\b(simulate error|error demo)\b/i.test(text)) return errorScenario
  return mode === 'develop' ? developScenario : chatScenario
}

export interface MockOptions {
  mode: SessionMode
  /** The device tools for this session. Without them the devices scenario says so. */
  devices?: DevicePort
  getApproval: () => ApprovalMode
  /** Dev menu: force a scenario for the next message. */
  takeForcedScenario?: () => string | undefined
}

export function createMockSession(opts: MockOptions): AgentSession {
  const queue = new EventQueue<AgentEvent>()
  const pending = new Map<string, { resolve: (v: never) => void; reject: (e: Error) => void }>()
  const sleepers = new Set<(e: Error) => void>()
  let aborted = false
  let running = false
  let hung = false

  const emit = (e: AgentEvent) => queue.push(e)

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (aborted) return reject(new Aborted())
      const t = setTimeout(() => {
        sleepers.delete(fail)
        resolve()
      }, ms)
      const fail = (e: Error) => {
        clearTimeout(t)
        reject(e)
      }
      sleepers.add(fail)
    })

  const waitFor = <T,>(requestId: string) =>
    new Promise<T>((resolve, reject) => {
      if (aborted) return reject(new Aborted())
      pending.set(requestId, { resolve: resolve as (v: never) => void, reject })
    })

  async function stream(kind: 'message.delta' | 'thinking.delta', text: string, chunk: number, delay: number): Promise<void> {
    for (let i = 0; i < text.length; i += chunk) {
      emit({ type: kind, text: text.slice(i, i + chunk) })
      await sleep(delay + Math.random() * delay * 0.6)
    }
  }

  async function run(input: UserInput): Promise<void> {
    const turnId = nextId('turn')
    running = true
    aborted = false
    emit({ type: 'turn.started', turnId })
    const ctx: Ctx = {
      input,
      mode: opts.mode,
      approval: opts.getApproval,
      emit,
      sleep,
      say: (text) => stream('message.delta', text, 6, 12),
      think: (text) => stream('thinking.delta', text, 4, 18),
      fail: (error) => {
        throw new Failure(error)
      },
      hang: () => {
        hung = true
        return new Promise<never>(() => undefined)
      },
      hasDevices: !!opts.devices,
      device: async (name, args, title, kind) => {
        if (!opts.devices) return { text: 'Devices are not available in this session.', isError: true }
        const id = nextId('t')
        let started = false
        const begin = () => {
          if (started) return
          started = true
          const input = typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : undefined
          emit({ type: 'tool.started', id, kind, title, input })
        }
        // The tool shows the card after any approval, so a declined command never looks as if it ran.
        const out = await opts.devices.call(name, args, { started: begin })
        begin()
        emit({ type: 'tool.output', id, text: out.text.endsWith('\n') ? out.text : `${out.text}\n` })
        emit({ type: 'tool.completed', id, ok: !out.isError })
        return out
      },
      ask: async (questions) => {
        const requestId = nextId('ask')
        emit({ type: 'ask_user.requested', requestId, questions })
        return waitFor<AskAnswers>(requestId)
      },
      tool: async (spec) => {
        const mode = opts.getApproval()
        if (mode === 'plan' && (spec.kind === 'edit' || spec.kind === 'write' || spec.kind === 'shell')) return false
        if (needsApproval(spec.kind, mode)) {
          const requestId = nextId('req')
          emit({
            type: 'approval.requested',
            requestId,
            kind: spec.kind,
            title: spec.title,
            detail: spec.input ?? spec.diff?.map((d) => d.path).join('\n')
          })
          const answer = await waitFor<ApprovalAnswer>(requestId)
          if (!answer.allow) return false
        }
        const id = nextId('t')
        emit({ type: 'tool.started', id, kind: spec.kind, title: spec.title, input: spec.input })
        const lines = spec.output ?? []
        const step = (spec.ms ?? 1000) / Math.max(1, lines.length + 1)
        for (const line of lines) {
          await sleep(step)
          emit({ type: 'tool.output', id, text: `${line}\n` })
        }
        await sleep(step)
        emit({ type: 'tool.completed', id, ok: !spec.fails, diff: spec.diff })
        return !spec.fails
      }
    }

    try {
      await pick(opts.mode, input.text, opts.takeForcedScenario?.(), !!opts.devices)(ctx)
      emit({ type: 'turn.completed', turnId })
    } catch (err) {
      if (err instanceof Aborted) emit({ type: 'turn.interrupted', turnId })
      else if (err instanceof Failure) emit({ type: 'turn.failed', turnId, error: err.error })
      else throw err
    } finally {
      running = false
    }
  }

  const vendorSessionId = nextId('mock-')

  return {
    vendorSessionId,
    events: queue,
    send: (input) => {
      if (!running) void run(input)
    },
    respond: (requestId, answer) => {
      const p = pending.get(requestId)
      if (!p) return
      pending.delete(requestId)
      p.resolve(answer as never)
    },
    setModel: async (_model: string, _effort?: Effort) => undefined,
    setApprovalMode: async () => undefined,
    interrupt: async () => {
      aborted = true
      const err = new Aborted()
      sleepers.forEach((f) => f(err))
      sleepers.clear()
      pending.forEach((p) => p.reject(err))
      pending.clear()
      // A hung scenario never settles on its own, so finish the turn here.
      if (running && hung) {
        emit({ type: 'turn.interrupted', turnId: 'stopped' })
        running = false
        hung = false
      }
    },
    close: async () => queue.close()
  }
}

