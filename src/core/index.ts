// The Core process: database, sessions and the assistant. Started by the main process as a utility process,
// so a slow or crashing agent can never freeze or take down the window.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { VendorId } from '@shared/agent'
import type { CoreApi, CoreMessage, CorePush, CoreRequest } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DiskFileStore } from './disk-files'
import { AdbPairing } from './devices/adb-pairing'
import { findAdb } from './devices/adb-connector'
import { connectorsForApp } from './devices/connectors'
import { DeviceService } from './devices/device-service'
import { discoverAll } from './devices/discovery'
import { DeviceToolServer } from './devices/mcp-server'
import { nodeFileOps } from './devices/node-fs'
import { DeviceTools } from './devices/tools'
import { GitSnapshots } from './snapshots'
import { createClaudeHost, createClaudeSession, createClaudeTitler, type ClaudeHost } from './adapters/claude'
import { createOpenAiHost, createOpenAiSession, type OpenAiHost } from './adapters/openai'
import { createGeminiHost, createGeminiSession, type GeminiHost } from './adapters/gemini'
import { copilotRuntime, createCopilotHost, createCopilotSession, createCopilotTitler, type CopilotHost } from './adapters/copilot'
import { OwnPrograms } from './adapters/own-copy'
import { checkForUpdate } from './update'
import { OWN_CLAUDE } from './adapters/claude/program'
import { OWN_COPILOT } from './adapters/copilot/runtime'
import { createUnavailableSession } from './adapters/unavailable'
import { createProjectApi } from './project'
import { callTool, McpService } from './mcp'
import { serverKey } from '@shared/mcp'
import { Attention, scheduleNotice } from './attention'
import { claudeUsageFrom, copilotUsageFrom, UsageService, type ClaudeUsageAnswer, type CopilotQuotaSnapshot } from './usage'
import { limitReset } from '@shared/usage'
import type { VendorUsage } from '@shared/usage'
import { AppTools } from './app/tools'
import { SubAgents } from './agents/subagents'
import { AgentTools } from './agents/tools'
import { Moons } from './moons/moons'
import { createAgentStepRunner } from './workflows/agent-step'
import { draftWorkflow } from './workflows/draft'
import { WorkflowRunner } from './workflows/runner'
import { ScheduleService } from './workflows/schedule-service'
import { Scheduler } from './workflows/scheduler'
import { WorkflowService } from './workflows/service'
import { CombinedTools, WorkflowTools } from './workflows/tools'
import { DesktopControl } from './desktop/control'
import { MainDesktopHost } from './desktop/main-host'
import { MainBrowserHost } from './browser/main-host'
import { BrowserTools } from './browser/tools'
import type { AdapterFactory } from './adapters/types'
import { TerminalService } from './terminal'
import { Worktrees } from './worktrees'
import { SessionService } from './service'
import { VendorService } from './vendors'
import { SqliteStore } from './sqlite-store'
import { PhoneBridge } from './phone/bridge'
import { phoneCalls } from './phone/calls'
import { checkNetwork } from './phone/network'
import { cachedApk, fetchReleasedApk } from './phone/apk'
import { PhoneTools } from './phone/tools'
import { PHONE_PROTOCOL, PHONE_SERVICE } from '@shared/phone'

const parent = process.parentPort

/** The Android app to hand out to phones: a copy put next to the data, the one shipped with Celeste, or a development build. */
function findPhoneApk(dataDir: string): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    process.env['CELESTE_PHONE_APK'],
    // The one fetched from this version's GitHub release (src/core/phone/apk.ts).
    cachedApk(dataDir, process.env['CELESTE_VERSION'] ?? '0.0.0'),
    join(dataDir, 'phone', 'celeste.apk'),
    resources ? join(resources, 'phone', 'celeste.apk') : undefined,
    join(process.cwd(), 'phone', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    join(process.cwd(), 'phone', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  ]
  return candidates.find((f): f is string => !!f && existsSync(f)) ?? null
}

/** Announces `_celeste._tcp` on the local network, so the phone app finds this computer without an address. */
async function announcePhone(port: number, name: string, id: string): Promise<() => Promise<void>> {
  const { Bonjour } = await import('bonjour-service')
  const bonjour = new Bonjour()
  bonjour.publish({ name: `Celeste on ${name}`, type: PHONE_SERVICE, port, txt: { id, v: String(PHONE_PROTOCOL) } })
  return () => new Promise<void>((resolve) => bonjour.unpublishAll(() => bonjour.destroy(() => resolve())))
}

/** The first name for the greeting: the operating system's user name, capitalised. */
function friendlyName(): string {
  try {
    const name = userInfo().username
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'there'
  } catch {
    return 'there'
  }
}

const ports = new Set<MessagePortMain>()
const send = (port: MessagePortMain, message: CoreMessage) => port.postMessage(message)
let phoneRef: PhoneBridge | undefined
let attention: Attention | undefined
let usageRef: UsageService | undefined
let schedulerRef: Scheduler | undefined
let schedulesRef: ScheduleService | undefined
let tellSchedulesRef: (() => void) | undefined
let subAgentsRef: SubAgents | undefined
let moonsRef: Moons | undefined
const push = (p: CorePush) => {
  ports.forEach((port) => send(port, { kind: 'push', push: p }))
  phoneRef?.broadcast(p)
  attention?.observe(p)
  // A helper's turn ended, or a helper was deleted: whoever waits for its answer is told.
  subAgentsRef?.observe(p)
  // The same for the two moons of a chat: the other moon's turn ended, or the pen's failed.
  moonsRef?.observe(p)
  // A turn ended: that vendor's usage has changed.
  if (p.type === 'event' && p.stored.event.type === 'turn.completed') {
    const vendor = store?.listSessions().find((s) => s.id === p.sessionId)?.vendor
    if (vendor) usageRef?.afterTurn(vendor)
  }
}

let service: SessionService | undefined
let devices: DeviceService | undefined
let toolServer: DeviceToolServer | undefined
let copilot: CopilotHost | undefined
let claude: ClaudeHost | undefined
let openai: OpenAiHost | undefined
let gemini: GeminiHost | undefined
let api: CoreApi | undefined
let store: SqliteStore | undefined
let terminalsRef: TerminalService | undefined
let desktopRef: DesktopControl | undefined
const desktopHost = new MainDesktopHost((message) => parent.postMessage(message))
const browserHost = new MainBrowserHost((message) => parent.postMessage(message))
let browserToolsRef: BrowserTools | undefined

// Passwords and key passphrases live in the main process. Core asks for one only when it is about to connect.
let nextSecretId = 0
const waitingForSecret = new Map<number, (value: string | null) => void>()
function getSecret(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const id = ++nextSecretId
    const timer = setTimeout(() => {
      waitingForSecret.delete(id)
      resolve(null)
    }, 10_000)
    waitingForSecret.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    parent.postMessage({ type: 'secret-request', id, name })
  })
}

/** Removes a secret Core made itself (the ChatGPT sign-in, when the person signs out). True when it is gone. */
function removeSecret(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = ++nextSecretId
    const timer = setTimeout(() => {
      waitingForSecret.delete(id)
      resolve(false)
    }, 10_000)
    waitingForSecret.set(id, (value) => {
      clearTimeout(timer)
      resolve(value === 'ok')
    })
    parent.postMessage({ type: 'secret-remove', id, name })
  })
}

/** Stores a secret Core made itself (the phone bridge's key, and the ChatGPT sign-in). True when the system's secret store took it. */
function storeSecret(name: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = ++nextSecretId
    const timer = setTimeout(() => {
      waitingForSecret.delete(id)
      resolve(false)
    }, 10_000)
    waitingForSecret.set(id, (value) => {
      clearTimeout(timer)
      resolve(value === 'ok')
    })
    parent.postMessage({ type: 'secret-store', id, name, value })
  })
}

async function start(): Promise<void> {
  const dataDir = process.env['CELESTE_DATA_DIR']
  if (!dataDir) throw new Error('CELESTE_DATA_DIR is not set')
  mkdirSync(dataDir, { recursive: true })
  store = new SqliteStore(join(dataDir, 'celeste.db'))
  const db = store

  devices = new DeviceService({
    store: db,
    dataDir,
    getSecret,
    connectorFor: connectorsForApp(),
    push,
    fs: nodeFileOps,
    discover: () => discoverAll(),
    pairing: (() => {
      const pairing = new AdbPairing(() => findAdb())
      return { pairByCode: (a, c) => pairing.pairByCode(a, c), startQr: (n, ok, fail) => pairing.startQr(n, ok, fail) }
    })()
  })
  const tools = new DeviceTools(db, devices, { requestApproval: (...a) => (service as SessionService).requestApproval(...a) }, nodeFileOps, dataDir)
  toolServer = new DeviceToolServer(tools)
  await toolServer.start()
  const servers = toolServer
  // Copilot's program is beside the SDK when developing, and in the data folder once it has been downloaded.
  // CELESTE_COPILOT_ISOLATED=1 gives Copilot a data folder of its own that knows no one, so the sign-in screens can be tried
  // without touching the GitHub sign-in on this computer. For app checks.
  // Programs the person already has are used when they pass a check (see adapters/own-copy.ts). CELESTE_NO_OWN_PROGRAMS=1 turns that
  // off, so the app checks always run the same program.
  const ownPrograms = new OwnPrograms(
    { claude: OWN_CLAUDE, copilot: OWN_COPILOT },
    () => process.env['CELESTE_NO_OWN_PROGRAMS'] !== '1'
  )
  void ownPrograms.refresh().catch(() => undefined)
  const host = createCopilotHost(
    copilotRuntime(dataDir, require.resolve.paths('@github/copilot-sdk') ?? [], () => ownPrograms.file('copilot')),
    process.env['CELESTE_COPILOT_ISOLATED'] === '1' ? { isolatedDir: join(dataDir, 'copilot-isolated') } : {}
  )
  copilot = host
  // Claude Code keeps its settings in a folder of Celeste's own, so signing in here never touches the `claude` in a terminal.
  // CELESTE_CLAUDE_USER_LOGIN=1 uses the person's own sign-in instead, subscription included. For development and app checks only.
  const ownLogin = process.env['CELESTE_CLAUDE_USER_LOGIN'] === '1'
  const claudeHost = createClaudeHost({
    // Claude Code's program is beside the SDK when developing, and in the data folder once it has been downloaded.
    // CELESTE_NPM_REGISTRY points the download at another npm registry (a company mirror; a stand-in for the app checks).
    installedAt: process.env['CELESTE_CLAUDE_NO_INSTALLED'] === '1' ? [] : (require.resolve.paths('@anthropic-ai/claude-agent-sdk') ?? []),
    dataDir,
    own: () => ownPrograms.file('claude'),
    ...(process.env['CELESTE_NPM_REGISTRY'] ? { registry: process.env['CELESTE_NPM_REGISTRY'] } : {}),
    getKey: () => getSecret('vendor.claude.key'),
    ...(ownLogin ? { allowSubscription: true } : { configDir: join(dataDir, 'claude-config') })
  })
  claude = claudeHost
  // OpenAI's Codex runs with a settings folder of Celeste's own too. The ChatGPT sign-in is kept in the main process's secret store,
  // as is a pasted key; Codex is only ever handed the credential, as an environment variable.
  const openaiHost = createOpenAiHost({
    dataDir,
    tokens: {
      get: () => getSecret('vendor.openai.tokens'),
      set: (value) => storeSecret('vendor.openai.tokens', value),
      remove: async () => void (await removeSecret('vendor.openai.tokens'))
    },
    getKey: () => getSecret('vendor.openai.key'),
    ...(process.env['CELESTE_NPM_REGISTRY'] ? { registry: process.env['CELESTE_NPM_REGISTRY'] } : {})
  })
  openai = openaiHost
  // Gemini's CLI runs with a settings folder of Celeste's own, and is handed the pasted key in an environment variable.
  const geminiHost = createGeminiHost({
    dataDir,
    getKey: () => getSecret('vendor.gemini.key'),
    ...(process.env['CELESTE_NPM_REGISTRY'] ? { registry: process.env['CELESTE_NPM_REGISTRY'] } : {})
  })
  gemini = geminiHost

  const worktrees = new Worktrees(join(dataDir, 'worktrees'))
  // What a notification calls a chat. A helper names the chat that started it, so "Reviewer" is not mistaken for a chat of the person's.
  const chatLabel = (sessionId: string): string | undefined => {
    const row = db.getSession(sessionId)
    if (!row) return undefined
    const parentTitle = row.spawn ? db.getSession(row.spawn.parentId)?.title : undefined
    return parentTitle ? `${row.title} (${row.spawn?.moon ? 'in' : 'helper in'} ${parentTitle})` : row.title
  }
  const mcp = new McpService(db, getSecret, undefined, () => push({ type: 'mcp' }))
  // The same adapters serve chats and the agent steps of workflows.
  const adapterFor: AdapterFactory = (ctx) =>
    ctx.vendor === 'copilot'
      ? createCopilotSession(host, ctx, (id) => servers.info(id), () => mcp.resolved())
      : ctx.vendor === 'claude'
        ? createClaudeSession(claudeHost, ctx, (id) => servers.info(id), () => mcp.resolved())
        : ctx.vendor === 'openai'
          ? createOpenAiSession(openaiHost, ctx, (id) => servers.info(id), () => mcp.resolved(), process.env['CELESTE_VERSION'])
          : ctx.vendor === 'gemini'
            ? createGeminiSession(geminiHost, ctx, (id) => servers.info(id), () => mcp.resolved(), process.env['CELESTE_VERSION'])
            : createUnavailableSession(ctx.vendor)
  const vendorApi = new VendorService({ copilot: host, claude: claudeHost, openai: openaiHost, gemini: geminiHost }, push, ownPrograms).api
  const claudeTitle = createClaudeTitler(claudeHost)
  const copilotTitle = createCopilotTitler(host)

  service = new SessionService({
    store,
    files: new DiskFileStore(join(dataDir, 'attachments')),
    dataDir,
    version: process.env['CELESTE_VERSION'],
    // Copilot and Claude are real. OpenAI and Gemini have no adapter yet, and the window does not offer them.
    adapter: adapterFor,
    // Develop sessions save their project folder before each message, in a private copy under the data folder.
    snapshots: new GitSnapshots(join(dataDir, 'snapshots')),
    // A new session is named by a small model of its own vendor; the other vendors have no adapter yet.
    titler: {
      title: (vendor, text) => (vendor === 'claude' ? claudeTitle(text) : vendor === 'copilot' ? copilotTitle(text) : Promise.resolve(undefined))
    },
    // A vendor said it is at its limit: its usage is read again, and the meter that ran out says when it comes back (null when it cannot say).
    limit: async (vendor) => {
      const all = await usageRef?.refresh(vendor)
      return limitReset(all?.find((u) => u.vendor === vendor), Date.now())
    },
    onSessionStopped: (id) => {
      tools.cancel(id)
      desktopRef?.sessionGone(id)
      browserToolsRef?.sessionGone(id)
      phoneRef?.cancel(id)
      // The helpers a chat was running or waiting on stop with it.
      subAgentsRef?.parentStopped(id)
      // A run of two moons ends when its chat is stopped or deleted, or fails when the other moon is.
      moonsRef?.stopped(id)
    },
    // A turn ended and nothing follows from the queue: an assistant with a helper's answer waiting is told now.
    onIdle: (id, type) => subAgentsRef?.onIdle(id, type),
    // Two Moons chats (src/core/moons): who gets a person's message, what the pen is told with it, and what follows the pen's turn.
    moons: {
      takes: (id, input) => moonsRef?.takes(id, input) ?? false,
      lineFor: (id) => moonsRef?.lineFor(id) ?? '',
      penDone: (id) => moonsRef?.penDone(id) ?? false,
      notSent: (id) => moonsRef?.notSent(id)
    },
    push,
    defaults: {
      ...DEFAULT_SETTINGS,
      userName: friendlyName()
    },
  })
  service.init()
  // A run started from a conversation is written into it: when it starts, and how it ended, so the assistant can be told.
  const noted = new Set<string>()
  const runPush = (p: CorePush) => {
    push(p)
    // Every run, so a schedule hears how its runs end and which of them wait for a person.
    if (p.type === 'run') schedulerRef?.onRun(p.run)
    if (p.type !== 'run' || !p.run.sessionId) return
    const { run } = p
    // A run a schedule started has no conversation, so it never gets here; the log's words for who started one do not have 'schedule'.
    const startedBy = run.startedBy === 'schedule' ? 'you' : run.startedBy
    if (!noted.has(run.id)) {
      noted.add(run.id)
      ;(service as SessionService).recordWorkflow(run.sessionId as string, { type: 'workflow.started', runId: run.id, workflowId: run.workflowId, name: run.workflowName, startedBy })
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      if (noted.has(`done:${run.id}`)) return
      noted.add(`done:${run.id}`)
      ;(service as SessionService).recordWorkflow(run.sessionId as string, {
        type: 'workflow.finished',
        runId: run.id,
        name: run.workflowName,
        startedBy,
        status: run.status,
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.error ? { error: run.error } : {})
      })
    }
  }
  // A workflow step has no chat to show a card in, so what desktop control asks it asks in the run, while the step is going.
  // The phone shows its own cards, and names the workflow and step on them.
  const stepAsk = new Map<string, (title: string, detail?: string) => Promise<boolean>>()
  const stepLabels = new Map<string, string>()
  const agentSteps = createAgentStepRunner({
      adapter: adapterFor,
      desktop: {
        register: (sessionId, ask, label) => {
          stepAsk.set(sessionId, ask)
          if (label) stepLabels.set(sessionId, label)
        },
        unregister: (sessionId) => {
          stepAsk.delete(sessionId)
          stepLabels.delete(sessionId)
          desktopRef?.sessionGone(sessionId, 'The workflow step ended.')
          phoneTools.ended(sessionId)
        }
      },
      // A step that names no model uses the first vendor that is ready, with the model that vendor calls automatic or lists first.
      defaults: async () => {
        for (const vendor of ['copilot', 'claude'] as const) {
          const h = vendor === 'copilot' ? host : claudeHost
          if ((await h.status().catch(() => undefined))?.state !== 'signed-in') continue
          const models = await h.models().catch(() => [])
          const pick = models.find((m) => m.id === 'auto' || m.id === 'copilot-auto') ?? models[0]
          if (pick) return { vendor, model: pick.id }
        }
        throw new Error('No assistant is connected. Connect one in Settings, AI vendors.')
      }
    })
  const runner = new WorkflowRunner({
    store: db,
    push: runPush,
    agent: agentSteps,
    desktop: { enabled: () => db.settings().desktopControl === true },
    phone: {
      problem: () => {
        const b = phoneRef
        if (!b?.enabled) return 'phones are switched off. Switch them on in Settings, Phone.'
        if (!b.phones().length) return 'no phone is paired with Celeste. Connect one in Settings, Phone.'
        if (!b.reachable().length) return 'the phone is not connected. Open Celeste on it, or switch on “Stay connected” in its This phone tab.'
        return null
      }
    },
    mcp: {
      find: async (name) => (await mcp.resolved()).find((s) => s.key === serverKey(name) || s.key === name),
      call: (server, tool, args, timeoutMs, signal) => callTool(server, tool, args, timeoutMs, signal)
    },
    devices: {
      get: (id) => db.getDevice(id),
      run: async (device, command, { timeoutMs, signal }) => {
        const connector = await (devices as DeviceService).connector(device)
        const r = await connector.run(command, { timeoutMs, maxBytes: 200_000, signal })
        const known = devices as DeviceService
        known.record(device.id, null, 'workflow', command, r.exitCode === 0, Buffer.byteLength(r.output))
        return { output: r.output, exitCode: r.exitCode, timedOut: r.timedOut, cancelled: r.cancelled }
      }
    }
  })
  runner.markAbandoned()
  // The schedules (docs/plans/SCHEDULING_PLAN.md): the person approved each when they made it, so its runs start with no card. Looked at every
  // half minute, when Celeste starts, and when the computer wakes. CELESTE_SCHEDULER_TICK_MS is for the app checks.
  const schedulesPaused = () => db.settings()['schedulesPaused'] === true
  // The window looks again, and the main process (the tray's "Pause all schedules" item) hears how many there are and whether they are paused.
  const tellSchedules = () => parent.postMessage({ type: 'schedules-state', paused: schedulesPaused(), count: db.listSchedules().length })
  const schedulesChanged = () => {
    push({ type: 'schedules' })
    tellSchedules()
  }
  tellSchedulesRef = tellSchedules
  const scheduler = new Scheduler({
    store: db,
    runner,
    paused: schedulesPaused,
    changed: schedulesChanged,
    // A scheduled run that failed (or finished, when asked), or a schedule that paused itself: the computer's notification, and the phones'.
    notify: (n) => {
      const message = scheduleNotice(n, Date.now())
      parent.postMessage(message)
      phoneRef?.tell({ id: message.id, title: message.title, text: message.text, ...(n.runId ? { runId: n.runId } : {}) })
    },
    ...(Number(process.env['CELESTE_SCHEDULER_TICK_MS']) > 0 ? { tickMs: Number(process.env['CELESTE_SCHEDULER_TICK_MS']) } : {})
  })
  schedulerRef = scheduler
  const schedules = new ScheduleService(db, runner, { dataDir, changed: schedulesChanged, paused: schedulesPaused, setPaused: (on) => db.setSetting('schedulesPaused', on) })
  schedulesRef = schedules
  scheduler.start()
  // The workflows the person allowed the assistant to run are tools of Celeste's own tool server.
  // The assistant's use of the mouse and keyboard is off until switched on in Settings, and always asks first on a card of Celeste's own.
  const desktopControl = new DesktopControl({
    enabled: () => db.settings().desktopControl === true,
    host: desktopHost,
    askConsent: (sessionId, request) => {
      // A step of a workflow asks in its run. One that is gone, or that is not in a run any more, is a no.
      if (sessionId.startsWith('wf-')) return stepAsk.get(sessionId)?.(request.title, request.detail) ?? Promise.resolve(false)
      return (service as SessionService).requestApproval(sessionId, { kind: 'other', ...request })
    },
    // The slider is only on a chat's card: a step of a workflow gets the usual time.
    askDuration: async (sessionId, request) => {
      if (sessionId.startsWith('wf-')) return (await (stepAsk.get(sessionId)?.(request.title, request.detail) ?? Promise.resolve(false))) ? request.slider.value : null
      return (service as SessionService).requestTimed(sessionId, { kind: 'other', ...request })
    },
    never: () => (db.settings().desktopNeverApps as string[] | undefined) ?? [],
    logGrant: (entry) => db.setSetting('desktopGrants', [...((db.settings().desktopGrants as unknown[] | undefined) ?? []), entry].slice(-20)),
    pendingApprovals: (sessionId) => (service as SessionService).pendingApprovals(sessionId),
    record: (sessionId, event) => (service as SessionService).recordDesktop(sessionId, event),
    // One mouse and keyboard for the whole computer: a helper asks the assistant that started it.
    isHelper: (sessionId) => !!db.getSession(sessionId)?.spawn
  })
  desktopRef = desktopControl
  // The phone's abilities, listed only while a phone is paired; each asks on the phone (src/core/phone/tools.ts).
  const phoneTools = new PhoneTools(
    () => phoneRef,
    (sessionId) => stepLabels.get(sessionId) ?? db.listSessions().find((s) => s.id === sessionId)?.title ?? 'a chat',
    () => join(dataDir, 'phone', 'received'),
    // Only a workflow step's session is remembered: a chat's requests end with Stop, not with the step.
    (sessionId) => stepAsk.has(sessionId),
    // Phone control is written into the chat as the same card desktop control uses, marked as the phone's.
    (sessionId, event) => (service as SessionService).recordDesktop(sessionId, event),
    // One phone for the whole computer: a helper asks the assistant that started it.
    (sessionId) => !!db.getSession(sessionId)?.spawn
  )
  // The assistant's use of Celeste's browser: Playwright, connected to the browser's own DevTools endpoint (docs/BROWSER_PLAN.md).
  const browserTools = new BrowserTools({
    enabled: () => db.settings().browserTools !== false,
    host: browserHost,
    workFolder: (sessionId) => (service as SessionService).workFolder(sessionId),
    approvalMode: (sessionId) => (service as SessionService).approvalOf(sessionId),
    allowedSites: () => (db.settings().browserAllowedSites as string[] | undefined) ?? [],
    allowSite: (site) => db.setSetting('browserAllowedSites', [...new Set([...((db.settings().browserAllowedSites as string[] | undefined) ?? []), site])].slice(0, 200)),
    ask: (sessionId, request) =>
      (service as SessionService).requestChoice(sessionId, {
        kind: 'web',
        title: request.title,
        detail: request.detail,
        choices: { allow: 'Allow for this chat', always: `Always allow ${request.site}` }
      }),
    // Where a file is opened with no question: the chat's own folder (the project in Develop) and the files attached in chats.
    fileRoots: (sessionId) => [(service as SessionService).workFolder(sessionId) ?? '', join(dataDir, 'attachments')],
    askFile: (sessionId, request) => (service as SessionService).requestApproval(sessionId, { kind: 'read', title: request.title, detail: request.detail })
  })
  browserToolsRef = browserTools
  // Nobody can answer a card in a workflow step, so the tools that need one are refused there.
  const where = { step: (sessionId: string) => sessionId.startsWith('wf-') || stepAsk.has(sessionId) }
  // The assistant's tools for operating Celeste itself (docs/plans/INNER_TOOLS_PLAN.md): four that read, two that propose on a card.
  const appTools = new AppTools({
    where,
    plugins: () => mcp.api['mcp.list'](),
    settings: () => (service as SessionService).api['settings.get'](),
    workflows: () => workflows.api['workflows.list'](),
    workflow: (id) => workflows.api['workflows.get'](id),
    runs: (workflowId) => workflows.api['runs.list'](workflowId),
    run: (id) => workflows.api['runs.get'](id),
    // The two tools that need a card: it is raised in the chat, and nothing is saved until the person presses its button.
    propose: (sessionId, request) => (service as SessionService).requestProposal(sessionId, request),
    draft: (text) => workflows.api['workflows.draft']({ kind: 'text', text }),
    draftEdit: (workflowId, text) => workflows.api['workflows.draft']({ kind: 'edit', workflowId, text }),
    saveWorkflow: (input) => workflows.api['workflows.save'](input),
    // The light tools: the same change the window makes, then the window is told (a theme changes where the person is looking).
    changeSettings: (patch) => {
      const next = (api as CoreApi)['settings.patch'](patch)
      push({ type: 'settings', settings: next })
      return next
    },
    note: (sessionId, text) => (service as SessionService).noteChange(sessionId, text),
    confirm: (sessionId, request) => (service as SessionService).requestApproval(sessionId, { kind: 'other', ...request }),
    mcp: {
      check: (input) => mcp.check(input),
      save: (input) => mcp.api['mcp.save'](input),
      test: (id) => mcp.api['mcp.test'](id),
      setEnabled: (id, enabled) => {
        const server = mcp.api['mcp.setEnabled'](id, enabled)
        push({ type: 'mcp' })
        return server
      },
      hasSecret: async (name) => !!(await getSecret(name).catch(() => null)),
      remove: (id) => {
        mcp.api['mcp.remove'](id)
        push({ type: 'mcp' })
      },
      removeSecret: async (name) => void (await removeSecret(name))
    }
  })
  // Helpers (docs/plans/SUB_AGENTS_PLAN.md): the assistant of a chat starts other sessions for pieces of work, and gets their answers back.
  const subAgents = new SubAgents({
    service: service as SessionService,
    store: db,
    vendors: {
      ready: async (vendor) => (await vendorApi['vendor.status'](vendor).catch(() => undefined))?.state === 'signed-in',
      models: (vendor) => vendorApi['vendor.models'](vendor)
    },
    defaultModel: () => (service as SessionService).api['settings.get']().defaults.model,
    worktrees
  })
  subAgentsRef = subAgents
  // Two Moons (docs/plans/TWO_MOONS_PLAN.md): Celeste gives the two agents of such a chat their turns.
  moonsRef = new Moons({ service: service as SessionService, store: db })
  const agentTools = new AgentTools({ where, agents: subAgents })
  servers.setExtraTools(new CombinedTools([new WorkflowTools(db, runner, (sessionId) => (service as SessionService).workFolder(sessionId)), appTools, agentTools, desktopControl, phoneTools, browserTools]))
  const workflows = new WorkflowService(db, runner, undefined, () => push({ type: 'workflows' }), dataDir, async () => (await mcp.resolved()).map((s) => s.key), (sessionId) => (service as SessionService).workFolder(sessionId), (source) =>
    // The assistant only has to write; it is in plan mode, so anything it asks to do is refused, and it has three minutes.
    draftWorkflow(source.kind === 'conversation' ? { kind: 'conversation', transcript: (service as SessionService).transcriptOf(source.sessionId) } : source, {
      tools: async () => (await mcp.resolved()).map((s) => s.key),
      ask: (prompt) => {
        const stop = new AbortController()
        const timer = setTimeout(() => stop.abort(), 180_000)
        return agentSteps.run({ prompt, approval: 'plan', cwd: dataDir, signal: stop.signal, askApproval: async () => false, askQuestions: async () => ({}) }).finally(() => clearTimeout(timer))
      }
    })
  )
  const terminals = new TerminalService({ folderOf: (id) => (service as SessionService).projectFolder(id), push })
  terminalsRef = terminals
  // Phones on the same Wi-Fi, when Settings → Phone is on. They reach a short list of methods only (src/shared/phone.ts).
  const phone = new PhoneBridge({
    store: db,
    call: phoneCalls(() => api as CoreApi, () => hostname()),
    computerName: () => hostname(),
    version: process.env['CELESTE_VERSION'] ?? '0.0.0',
    apkFile: () => findPhoneApk(dataDir),
    onStatus: () => push({ type: 'phone' }),
    onPairing: (request) => push({ type: 'phonePairing', request }),
    onControl: (_phoneId, report) => phoneTools.controlReport(report),
    networkWarning: (address) => checkNetwork(address),
    keyStore: { get: () => getSecret('phone.key'), set: (value) => storeSecret('phone.key', value) },
    announce: announcePhone,
    // The computer's screen as video, for a phone the person allowed, only while the assistant has the computer.
    watch: {
      start: (phoneId, offer, servers) => {
        if (!desktopControl.active()) return Promise.reject(new Error('The assistant is not using the computer now.'))
        return desktopHost.watchStart(phoneId, offer, servers)
      },
      stop: (phoneId) => desktopHost.watchStop(phoneId)
    },
    chatTitle: (sessionId) => chatLabel(sessionId) ?? 'Celeste'
  })
  phoneRef = phone
  // A released Celeste has no APK of its own until the first time phones are switched on: it is fetched then, from the
  // GitHub release of this version, and the install page offers it (Settings, Phone updates when it arrives).
  const ensureApk = () => {
    if (!phone.enabled || findPhoneApk(dataDir)) return
    void fetchReleasedApk(dataDir, process.env['CELESTE_VERSION'] ?? '0.0.0').then((file) => file && push({ type: 'phone' }))
  }
  ensureApk()
  // How much of each connected vendor's allowance is used (docs/QUEUE_AND_USAGE_PLAN.md, Part 2). Claude has plan limits only on a
  // subscription login, which a release does not offer, so for an API key it has nothing to show; Copilot's premium requests are the real use.
  // CELESTE_USAGE_FILE is for the app checks: a file that says what each vendor reports ({"copilot": {...}, "claude": null, "fail": ["copilot"]}),
  // read in place of the vendors, so every state of the strip can be shown with no account.
  const usageFile = process.env['CELESTE_USAGE_FILE']
  const fromFile = (vendor: VendorId) => async (): Promise<VendorUsage | null> => {
    const all = JSON.parse(readFileSync(usageFile as string, 'utf8')) as Record<string, unknown>
    if (Array.isArray(all['fail']) && (all['fail'] as string[]).includes(vendor)) throw new Error('The stand-in was told to fail.')
    const entry = all[vendor] as Partial<VendorUsage> | null | undefined
    return entry ? ({ ...entry, vendor, windows: entry.windows ?? [], at: entry.at ?? Date.now() } as VendorUsage) : null
  }
  const usage = new UsageService({
    readers: usageFile
      ? { claude: fromFile('claude'), copilot: fromFile('copilot') }
      : {
          claude: async () => claudeUsageFrom((await claudeHost.usage()) as ClaudeUsageAnswer | null, Date.now()),
          copilot: async () => copilotUsageFrom((await host.quota()) as Record<string, CopilotQuotaSnapshot | undefined>, Date.now())
        },
    connected: () => (Object.keys((service as SessionService).api['app.bootstrap']().vendors) as VendorId[]),
    load: () => (db.settings()['usage'] as VendorUsage[] | undefined) ?? [],
    save: (all) => db.setSetting('usage', all),
    changed: () => push({ type: 'usage' })
  })
  usageRef = usage
  api = {
    'usage.get': () => usage.get(),
    'usage.refresh': (vendor) => usage.refresh(vendor),
    'phone.status': () => {
      // Settings, Phone was opened: a good moment to look at the network again (at most once a minute).
      phone.checkNetwork()
      return phone.status()
    },
    'phone.setEnabled': async (on) => {
      const status = await phone.setEnabled(on)
      ensureApk()
      return status
    },
    'phone.remove': (id) => phone.remove(id),
    'phone.setWatch': (id, on) => phone.setWatch(id, on === true),
    'phone.answer': (pairId, allow) => phone.answer(pairId, allow),
    ...service.api,
    // The main process decides what closing the window does, so it is told when that setting changes.
    'settings.patch': (patch) => {
      const next = (service as SessionService).api['settings.patch'](patch)
      parent.postMessage({ type: 'app-settings', closeToTray: next.closeToTray })
      return next
    },
    'app.checkUpdate': () => checkForUpdate(process.env['CELESTE_VERSION'] ?? '0.0.0'),
    // A removed session takes its shell with it.
    'sessions.remove': (id) => {
      terminalsRef?.close(id)
      for (const child of db.listChildren(id)) terminalsRef?.close(child.id)
      return (service as SessionService).api['sessions.remove'](id)
    },
    'sessions.removeAll': () => {
      terminalsRef?.closeAll()
      return (service as SessionService).api['sessions.removeAll']()
    },
    ...devices.api,
    ...vendorApi,
    ...mcp.api,
    ...workflows.api,
    // A change to a workflow's steps pauses the schedules that were approved for the old ones, at once and not at their next time.
    'workflows.save': (input) => {
      const saved = workflows.api['workflows.save'](input)
      scheduler.onWorkflowSaved(saved.id)
      return saved
    },
    ...schedules.api,
    ...terminals.api,
    ...createProjectApi(worktrees, (path) => {
      const s = db.listSessions().find((x) => x.cwd === path)
      return s ? { id: s.id, title: s.title } : undefined
    }, (path) => (service as SessionService).stopWorkingIn(path)),
    'devices.toolServer': async (sessionId) => servers.info(sessionId)
  }
  void phone.start().then(() => push({ type: 'phone' }))
  // The main process shows the tray, and notifications while no window is open, from these two kinds of message.
  attention = new Attention((message) => parent.postMessage(message), (sessionId) => chatLabel(sessionId))
  parent.postMessage({ type: 'app-settings', closeToTray: (service as SessionService).api['settings.get']().closeToTray })
  tellSchedulesRef?.()
  parent.postMessage({ type: 'ready' })
}

start().catch((err) => {
  // Typically a database made by a newer Celeste. The main process tells the user and quits.
  parent.postMessage({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })
})

function onRequest(port: MessagePortMain, data: unknown): void {
  const req = data as Partial<CoreRequest> | null
  if (!api || typeof req?.id !== 'number' || typeof req.method !== 'string' || !Array.isArray(req.params)) return
  const id = req.id
  const methods = api
  if (!Object.hasOwn(methods, req.method)) {
    send(port, { kind: 'response', response: { id, ok: false, error: `Unknown method ${req.method}` } })
    return
  }
  const method = methods[req.method as keyof typeof methods] as (...args: unknown[]) => unknown
  const params = req.params
  Promise.resolve()
    .then(() => method(...params))
    .then(
      (result) => send(port, { kind: 'response', response: { id, ok: true, result } }),
      (err: unknown) => send(port, { kind: 'response', response: { id, ok: false, error: err instanceof Error ? err.message : String(err) } })
    )
}

parent.on('message', (event) => {
  const message = event.data as { type?: string; id?: number; value?: string | null } | null
  if (message?.type === 'desktop-reply') {
    desktopHost.reply(message as { id?: number; ok?: boolean; result?: unknown; error?: string })
  } else if (message?.type === 'browser-reply') {
    browserHost.reply(message as { id?: number; ok?: boolean; result?: unknown; error?: string })
  } else if (message?.type === 'desktop-stop') {
    desktopRef?.stop(typeof (message as { why?: string }).why === 'string' ? ((message as { why: string }).why) : 'You pressed Stop.')
  } else if (message?.type === 'desktop-extend') {
    desktopRef?.extend()
  } else if (message?.type === 'desktop-resume') {
    desktopRef?.resume()
  } else if (message?.type === 'power-resume') {
    // The computer woke up: what came due while it slept is looked at now, not at the next half minute.
    void schedulerRef?.tick()
  } else if (message?.type === 'schedules-pause') {
    // The tray's "Pause all schedules". Nothing new starts while it is on; runs that are going carry on.
    schedulesRef?.api['schedules.pauseAll']((message as { on?: unknown }).on === true)
  } else if (message?.type === 'secret-reply' && typeof message.id === 'number') {
    waitingForSecret.get(message.id)?.(message.value ?? null)
    waitingForSecret.delete(message.id)
  } else if (message?.type === 'secret-stored' && typeof message.id === 'number') {
    waitingForSecret.get(message.id)?.((message as { value?: unknown }).value === true ? 'ok' : null)
    waitingForSecret.delete(message.id)
  } else if (message?.type === 'connect') {
    const port = event.ports[0]
    if (!port) return
    ports.add(port)
    port.on('message', (e) => onRequest(port, e.data))
    port.on('close', () => ports.delete(port))
    port.start()
  } else if (message?.type === 'shutdown') {
    desktopRef?.stop('Celeste closed.')
    schedulerRef?.stop()
    subAgentsRef?.close()
    moonsRef?.close()
    service?.close()
    void (async () => {
      await browserToolsRef?.close().catch(() => undefined)
      await phoneRef?.stop().catch(() => undefined)
      await devices?.close().catch(() => undefined)
      terminalsRef?.closeAll()
      await toolServer?.stop().catch(() => undefined)
      await copilot?.stop().catch(() => undefined)
      await claude?.stop().catch(() => undefined)
      await openai?.stop().catch(() => undefined)
      await gemini?.stop().catch(() => undefined)
      store?.close()
      parent.postMessage({ type: 'closed' })
    })()
  }
})
