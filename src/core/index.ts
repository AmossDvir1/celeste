// The Core process: database, sessions and the assistant. Started by the main process as a utility process,
// so a slow or crashing agent can never freeze or take down the window.
import { mkdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
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
import { copilotRuntime, createCopilotHost, createCopilotSession, createCopilotTitler, type CopilotHost } from './adapters/copilot'
import { OwnPrograms } from './adapters/own-copy'
import { OWN_CLAUDE } from './adapters/claude/program'
import { OWN_COPILOT } from './adapters/copilot/runtime'
import { createUnavailableSession } from './adapters/unavailable'
import { createProjectApi } from './project'
import { callTool, McpService } from './mcp'
import { serverKey } from '@shared/mcp'
import { createAgentStepRunner } from './workflows/agent-step'
import { draftWorkflow } from './workflows/draft'
import { WorkflowRunner } from './workflows/runner'
import { WorkflowService } from './workflows/service'
import { WorkflowTools } from './workflows/tools'
import type { AdapterFactory } from './adapters/types'
import { TerminalService } from './terminal'
import { Worktrees } from './worktrees'
import { SessionService } from './service'
import { VendorService } from './vendors'
import { SqliteStore } from './sqlite-store'

const parent = process.parentPort

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
const push = (p: CorePush) => ports.forEach((port) => send(port, { kind: 'push', push: p }))

let service: SessionService | undefined
let devices: DeviceService | undefined
let toolServer: DeviceToolServer | undefined
let copilot: CopilotHost | undefined
let claude: ClaudeHost | undefined
let api: CoreApi | undefined
let store: SqliteStore | undefined
let terminalsRef: TerminalService | undefined

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
    () => process.env['CELESTE_NO_OWN_PROGRAMS'] !== '1' && (db.settings().ownPrograms as boolean | undefined) !== false
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

  const worktrees = new Worktrees(join(dataDir, 'worktrees'))
  const mcp = new McpService(db, getSecret, undefined, () => push({ type: 'mcp' }))
  // The same adapters serve chats and the agent steps of workflows.
  const adapterFor: AdapterFactory = (ctx) =>
    ctx.vendor === 'copilot'
      ? createCopilotSession(host, ctx, (id) => servers.info(id), () => mcp.resolved())
      : ctx.vendor === 'claude'
        ? createClaudeSession(claudeHost, ctx, (id) => servers.info(id), () => mcp.resolved())
        : createUnavailableSession(ctx.vendor)
  const claudeTitle = createClaudeTitler(claudeHost)
  const copilotTitle = createCopilotTitler(host)

  service = new SessionService({
    store,
    files: new DiskFileStore(join(dataDir, 'attachments')),
    dataDir,
    // Copilot and Claude are real. OpenAI and Gemini have no adapter yet, and the window does not offer them.
    adapter: adapterFor,
    // Develop sessions save their project folder before each message, in a private copy under the data folder.
    snapshots: new GitSnapshots(join(dataDir, 'snapshots')),
    // A new session is named by a small model of its own vendor; the other vendors have no adapter yet.
    titler: {
      title: (vendor, text) => (vendor === 'claude' ? claudeTitle(text) : vendor === 'copilot' ? copilotTitle(text) : Promise.resolve(undefined))
    },
    onSessionStopped: (id) => tools.cancel(id),
    push,
    defaults: {
      ...DEFAULT_SETTINGS,
      userName: friendlyName(),
      defaults: { ...DEFAULT_SETTINGS.defaults, projectsFolder: join(homedir(), 'Projects') }
    },
  })
  service.init()
  // A run started from a conversation is written into it: when it starts, and how it ended, so the assistant can be told.
  const noted = new Set<string>()
  const runPush = (p: CorePush) => {
    push(p)
    if (p.type !== 'run' || !p.run.sessionId) return
    const { run } = p
    if (!noted.has(run.id)) {
      noted.add(run.id)
      ;(service as SessionService).recordWorkflow(run.sessionId as string, { type: 'workflow.started', runId: run.id, workflowId: run.workflowId, name: run.workflowName, startedBy: run.startedBy })
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      if (noted.has(`done:${run.id}`)) return
      noted.add(`done:${run.id}`)
      ;(service as SessionService).recordWorkflow(run.sessionId as string, {
        type: 'workflow.finished',
        runId: run.id,
        name: run.workflowName,
        startedBy: run.startedBy,
        status: run.status,
        ...(run.output !== undefined ? { output: run.output } : {}),
        ...(run.error ? { error: run.error } : {})
      })
    }
  }
  const agentSteps = createAgentStepRunner({
      adapter: adapterFor,
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
  // The workflows the person allowed the assistant to run are tools of Celeste's own tool server.
  servers.setExtraTools(new WorkflowTools(db, runner, (sessionId) => (service as SessionService).workFolder(sessionId)))
  const workflows = new WorkflowService(db, runner, undefined, () => push({ type: 'workflows' }), dataDir, async () => (await mcp.resolved()).map((s) => s.key), (sessionId) => (service as SessionService).workFolder(sessionId), (source) =>
    // The assistant only has to write; it is in plan mode, so anything it asks to do is refused, and it has three minutes.
    draftWorkflow(source.kind === 'text' ? source : { kind: 'conversation', transcript: (service as SessionService).transcriptOf(source.sessionId) }, {
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
  api = {
    ...service.api,
    // A removed session takes its shell with it.
    'sessions.remove': (id) => {
      terminalsRef?.close(id)
      return (service as SessionService).api['sessions.remove'](id)
    },
    'sessions.removeAll': () => {
      terminalsRef?.closeAll()
      return (service as SessionService).api['sessions.removeAll']()
    },
    ...devices.api,
    ...new VendorService({ copilot: host, claude: claudeHost }, push, ownPrograms).api,
    ...mcp.api,
    ...workflows.api,
    ...terminals.api,
    ...createProjectApi(worktrees, (path) => {
      const s = db.listSessions().find((x) => x.cwd === path)
      return s ? { id: s.id, title: s.title } : undefined
    }, (path) => (service as SessionService).stopWorkingIn(path)),
    'devices.toolServer': async (sessionId) => servers.info(sessionId)
  }
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
  if (message?.type === 'secret-reply' && typeof message.id === 'number') {
    waitingForSecret.get(message.id)?.(message.value ?? null)
    waitingForSecret.delete(message.id)
  } else if (message?.type === 'connect') {
    const port = event.ports[0]
    if (!port) return
    ports.add(port)
    port.on('message', (e) => onRequest(port, e.data))
    port.on('close', () => ports.delete(port))
    port.start()
  } else if (message?.type === 'shutdown') {
    service?.close()
    void (async () => {
      await devices?.close().catch(() => undefined)
      terminalsRef?.closeAll()
      await toolServer?.stop().catch(() => undefined)
      await copilot?.stop().catch(() => undefined)
      await claude?.stop().catch(() => undefined)
      store?.close()
      parent.postMessage({ type: 'closed' })
    })()
  }
})
