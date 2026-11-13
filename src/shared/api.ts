// The typed API between the window and the Core process (database, sessions, settings).
// The window reaches it through `window.celeste.core` (see src/preload). Every method is a request that
// resolves with its result. Core also pushes changes (new events, updated sessions) as `CorePush` messages.

import type {
  AddFolderResult,
  DeviceActivity,
  DeviceFolder,
  DevicePatch,
  DeviceRecord,
  DirEntry,
  FolderMode,
  FoundDevice,
  NewDevice,
  TestResult
} from './devices'
import type { ProducedFile } from './produced'
import type { QueueAction, SendMode } from './queue'
import type { PhonePairRequest, PhoneStatus } from './phone'
import type { RunSummary, StoredRunEvent, WorkflowDefinition, WorkflowFull, WorkflowSummary } from './workflow'
import type {
  AgentEvent,
  ApprovalAnswer,
  ApprovalMode,
  AskAnswers,
  AttachmentInfo,
  ContextRef,
  Effort,
  FileDiff,
  ModelInfo,
  SessionMode,
  UserInput,
  VendorId
} from './agent'

export type SessionStatus = 'idle' | 'working' | 'waiting'
export type ThemePref = 'dark' | 'light' | 'system'

export interface AppSettings {
  theme: ThemePref
  userName: string
  wizardDone: boolean
  sidebarCollapsed: boolean
  /** How wide the session list is, in pixels. */
  sidebarWidth: number
  /** The assistant may ask to use this computer's mouse and keyboard. Off until the person switches it on. */
  desktopControl: boolean
  /** Programs, or words in a window's title, that desktop control never sees or touches (a password manager, a bank). */
  desktopNeverApps: string[]
  /** The assistant may use Celeste's browser (open pages, read, click, type). On unless the person switches it off. */
  browserTools: boolean
  /** The sites the person chose "Always allow" for, by host name. */
  browserAllowedSites: string[]
  /** Models the person pinned to the top of the model menu, in the order they were pinned. */
  pinnedModels: string[]
  defaults: { model: string; approval: ApprovalMode }
}
export type SettingsPatch = Partial<Omit<AppSettings, 'defaults'>> & { defaults?: Partial<AppSettings['defaults']> }

/** A connected vendor, without anything secret. Keys and tokens live in the main process only. */
export interface VendorRecord {
  account: string
  method: 'browser' | 'key'
}
export type VendorRecords = Partial<Record<VendorId, VendorRecord>>

export interface SessionSummary {
  id: string
  vendor: VendorId
  mode: SessionMode
  title: string
  model: string
  effort: Effort | null
  approval: ApprovalMode
  cwd?: string
  branch?: string
  /** The folder is a separate copy of a project that Celeste made for this session (a git worktree). */
  worktree?: boolean
  /** When the session was pinned to the top of the list. Null or absent when it is not pinned. */
  pinnedAt?: number | null
  status: SessionStatus
  createdAt: number
  updatedAt: number
  /** Sequence number of the newest event. A window that loaded the log up to here only needs later ones. */
  lastSeq: number
}

export interface CreateSessionInput {
  vendor: VendorId
  mode: SessionMode
  title: string
  model: string
  effort: Effort | null
  approval: ApprovalMode
  cwd?: string
  branch?: string
}

/** Whether an MCP server (an outside tool) could be reached, and what it offers. Looked at on demand, not kept between runs. */
export type McpStatus =
  | { state: 'unchecked' }
  | { state: 'checking' }
  | { state: 'ok'; tools: { name: string; description?: string }[]; at: number }
  | { state: 'failed'; message: string; at: number }

/** An MCP server as the window sees it: what it is, never the secret values (the names of the variables and headers only). */
export interface McpServerView {
  id: string
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  envNames: string[]
  headerNames: string[]
  enabled: boolean
  status: McpStatus
}

/** What the window sends to add or change a server. Secret values are stored by the window itself, under the main process's care. */
export interface McpServerInput {
  /** Absent for a new server. */
  id?: string
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  envNames: string[]
  headerNames: string[]
  enabled?: boolean
}

/** One separate copy of a project on this computer, made for a Develop session. */
export interface WorktreeInfo {
  path: string
  name: string
  branch: string
  /** The project's own folder, which the copy was made from. Empty if it has gone. */
  repo: string
  /** Files changed in the copy and not committed. */
  changed: number
  /** Commits on the copy's branch that are on no other branch: they are lost if the copy is removed. */
  ahead: number
  /** The session that works in it, if there is one. */
  session?: { id: string; title: string }
}

export interface SessionPatch {
  title?: string
  model?: string
  effort?: Effort | null
  approval?: ApprovalMode
  pinned?: boolean
}

/**
 * What a session's log holds. The agent's events, plus the things the user did and one that Celeste recorded
 * itself. Replaying the log rebuilds the conversation exactly, with no vendor call.
 */
export type LogEvent =
  | AgentEvent
  | { type: 'user.message'; text: string; attachments: AttachmentInfo[]; context?: ContextRef[] }
  | { type: 'approval.resolved'; requestId: string; allow: boolean }
  | { type: 'ask.answered'; requestId: string; answers: AskAnswers }
  /** Celeste was closed while a turn was running. Written the next time it starts. */
  | { type: 'turn.abandoned' }
  /** The project folder was saved just before the message above reached the agent. `id` is what to go back to. */
  | { type: 'checkpoint.created'; id: string }
  /** What the turn that began at checkpoint `id` changed in the folder, written when the turn ends. */
  | ({ type: 'checkpoint.summary'; id: string } & CheckpointChanges)
  /** Celeste could not save the folder before this message, so it cannot be reverted. */
  | { type: 'checkpoint.skipped'; reason: string }
  /** A workflow was started from this conversation (the `/` menu, or the assistant). The run's own log is read with `runs.get`. */
  | { type: 'workflow.started'; runId: string; workflowId: string; name: string; startedBy?: 'you' | 'menu' | 'assistant' }
  /** That run ended. `output` is its result, which the assistant is told with the person's next message. */
  | { type: 'workflow.finished'; runId: string; name: string; status: 'completed' | 'failed' | 'cancelled'; output?: string; error?: string; startedBy?: 'you' | 'menu' | 'assistant' }
  /** The assistant was allowed to use this computer's mouse and keyboard (see docs/DESKTOP_CONTROL_PLAN.md). `until` is when it ends unless extended. */
  | { type: 'desktop.started'; grantId: string; reason: string; until: number; /** Control of the paired phone, not of this computer. */ where?: 'phone' }
  /** One thing it did, or was refused (`ok` false). */
  | { type: 'desktop.action'; grantId: string; text: string; ok: boolean; /** A fact rather than an action: the person paused it, or let it carry on. */ note?: boolean; /** Set when the action was more time: when control now ends. */ until?: number }
  /** Control ended, and why. */
  | { type: 'desktop.ended'; grantId: string; why: string; actions: number }
  /** Chat: files the agent wrote in its private folder during the turn that just ended. `more` is how many further files are not listed. */
  | { type: 'files.produced'; files: ProducedFile[]; more: number }
  /** The folder was put back as it was at checkpoint `id`. `undoId` goes back to how it was just before. */
  | { type: 'checkpoint.reverted'; id: string; restored: number; removed: number; undoId: string }
  /** A message typed while the assistant was working. It waits here, and is sent when the turn ends (see docs/QUEUE_AND_USAGE_PLAN.md). */
  | { type: 'queue.added'; id: string; text: string; attachments: AttachmentInfo[]; context?: ContextRef[]; model?: string; effort?: Effort | null }
  | { type: 'queue.edited'; id: string; text: string }
  | { type: 'queue.removed'; id: string }
  /** The waiting message was handed to the agent; a `user.message` follows. */
  | { type: 'queue.sent'; id: string }
  /** The person stopped the turn, it failed, or Celeste restarted: waiting messages are held until `queue.resumed`. */
  | { type: 'queue.paused' }
  | { type: 'queue.resumed' }

/** One file that a turn changed, or that a revert would change. */
export interface CheckpointFile {
  path: string
  status: 'modified' | 'added' | 'deleted'
  added: number
  removed: number
}
export interface CheckpointChanges {
  files: CheckpointFile[]
  /** How many more files changed than are listed. */
  more: number
}

/** One thing in a project folder, as the file tree lists it. */
export interface FileEntry {
  name: string
  kind: 'file' | 'dir'
  size?: number
}
export interface FileListing {
  entries: FileEntry[]
  /** How many more there are than are listed. */
  more: number
}
/** What a file looks like for a preview. */
export type FilePreview =
  | { kind: 'text'; text: string; size: number; lines: number }
  | { kind: 'binary'; size: number }
  | { kind: 'large'; size: number }
  | { kind: 'missing' }

/** The files that changed between two points in a session, with the lines of each. */
export interface CheckpointReview {
  files: FileDiff[]
  /** How many more files changed than are listed. */
  more: number
}

export interface StoredEvent {
  seq: number
  at: number
  event: LogEvent
}

export interface DraftState {
  text: string
  attachments: AttachmentInfo[]
  context?: ContextRef[]
}

export interface SearchHit {
  sessionId: string
  title: string
  mode: SessionMode
  updatedAt: number
  /** A short piece of the matching message, when the match was in the conversation rather than the title. */
  snippet?: string
}

export interface NewAttachment {
  name: string
  mime: string
  data: ArrayBuffer
  width?: number
  height?: number
}

/** Whether a vendor's agent can be used from this computer right now. */
export type VendorConnection =
  | { state: 'signed-in'; account: string }
  | { state: 'signed-out' }
  /** The vendor's program has not been downloaded yet. Connecting downloads it. */
  | { state: 'runtime-missing' }
  | { state: 'unavailable'; message: string }
  /** Celeste has no adapter for this vendor yet. */
  | { state: 'unsupported' }

/** What a terminal that was opened holds already: the end of what it printed, for a window that was away. */
export interface TerminalOpened {
  output: string
  running: boolean
}

/** Which copy of a vendor's program is in use. */
export interface VendorProgram {
  /** 'yours' is the person's own installed copy, 'celeste' the one Celeste downloads, 'none' that neither is on this computer yet. */
  using: 'yours' | 'celeste' | 'none'
  version?: string
  /** Why a copy that was found is not used. */
  why?: string
  /** The switch for using the person's own copy. */
  allowed: boolean
}

/** What the person is asked to do to finish signing in. */
export type SignInStep =
  | { kind: 'open-url'; url: string }
  | { kind: 'device-code'; url: string; code: string; expiresIn: number }

/** How a connection that was started with `vendor.signIn` is going. Arrives as `CorePush` messages. */
export type VendorProgress =
  | { state: 'downloading'; progress: number }
  | { state: 'step'; step: SignInStep }
  | { state: 'done'; account: string }
  | { state: 'failed'; message: string }

export interface Bootstrap {
  settings: AppSettings
  /** False on the very first start, so a window can import settings an earlier build kept in the browser. */
  settingsStored: boolean
  vendors: VendorRecords
  sessions: SessionSummary[]
  drafts: Record<string, DraftState>
  dataDir: string
  /** The version of Celeste that is running. */
  version: string
}

export interface UpdateInfo {
  current: string
  /** The newest release, when there is one. */
  latest?: string
  /** Where to download it. */
  url?: string
  newer: boolean
}

/** One time the assistant had control of the screen, for the list in Settings. */
export interface DesktopGrantRecord {
  /** When it started, in milliseconds since 1970. */
  at: number
  sessionId: string
  reason: string
  /** What it could use, in words. */
  scope: string
  /** How long it lasted. */
  ms: number
  actions: number
  /** How it ended. */
  why: string
}

/** The methods of Core. Return types are what the caller receives, wrapped in a Promise by the transport. */
export interface CoreApi {
  'app.bootstrap': () => Bootstrap
  /** Asks GitHub which release is newest. Only when the person asks: Celeste never looks by itself. */
  'app.checkUpdate': () => Promise<UpdateInfo>
  'settings.get': () => AppSettings
  'settings.patch': (patch: SettingsPatch) => AppSettings
  /** The last times the assistant had the screen, newest first. */
  'desktop.grants': () => DesktopGrantRecord[]
  'vendors.set': (id: VendorId, record: VendorRecord | null) => void

  /** Whether the vendor's agent is ready, without starting a sign-in. Starts its program if it is on this computer. */
  'vendor.status': (id: VendorId) => Promise<VendorConnection>
  /** Starts connecting: downloads the program if needed, then signs in. Answers at once; progress arrives as `vendor` pushes. */
  'vendor.signIn': (id: VendorId, method: 'web' | 'code') => Promise<void>
  'vendor.cancelSignIn': (id: VendorId) => Promise<void>
  /** Which copy of the vendor's program Celeste uses, and why not the person's own when it does not. Looks again at what is installed. */
  'vendor.program': (id: VendorId) => Promise<VendorProgram>
  /**
   * Makes sure the vendor's program is on this computer, downloading it if not. Progress arrives as `vendor` pushes; the call
   * answers when it is there (true) or when the download was cancelled or failed (false, and a `failed` push says why).
   */
  'vendor.prepare': (id: VendorId) => Promise<boolean>
  /** The models this account can use, with the effort levels each takes. Empty when the vendor is not ready. */
  'vendor.models': (id: VendorId) => Promise<ModelInfo[]>

  'sessions.create': (input: CreateSessionInput) => SessionSummary
  'sessions.get': (id: string) => { summary: SessionSummary; events: StoredEvent[] } | null
  /** While the assistant works, `mode` decides: 'queue' makes the message wait its turn, 'stop' stops the turn and sends it now. */
  'sessions.send': (id: string, input: UserInput, mode?: SendMode) => void
  /** Edit, remove, send now, resume or clear the messages waiting behind the running turn. */
  'sessions.queue': (id: string, action: QueueAction) => void
  'sessions.interrupt': (id: string) => void
  'sessions.respondApproval': (id: string, requestId: string, answer: ApprovalAnswer) => void
  'sessions.respondAsk': (id: string, requestId: string, answers: AskAnswers) => void
  'sessions.update': (id: string, patch: SessionPatch) => SessionSummary
  /** What reverting to a checkpoint would change in the folder, as it would be after the revert. */
  'sessions.revertPreview': (id: string, checkpointId: string) => Promise<CheckpointChanges>
  /** Every file that differs now from how the folder was before the session's first message, without the lines. Empty when nothing was saved. */
  'sessions.netChanges': (id: string) => Promise<CheckpointChanges>
  /** Opens the session's terminal (a shell in its project folder), or picks up the one that is already running. Output then arrives as `terminal` pushes. */
  'terminal.open': (sessionId: string, cols: number, rows: number) => Promise<TerminalOpened>
  'terminal.write': (sessionId: string, data: string) => Promise<void>
  'terminal.resize': (sessionId: string, cols: number, rows: number) => Promise<void>
  /** Ends the session's shell. */
  'terminal.close': (sessionId: string) => Promise<void>
  'workflows.list': () => WorkflowSummary[]
  'workflows.get': (id: string) => WorkflowFull | null
  /** Saves a workflow: a new one when `id` is absent. A change to the steps makes a new version. Throws a sentence when it is not valid. */
  'workflows.save': (input: { id?: string; name: string; description?: string; definition: WorkflowDefinition }) => WorkflowFull
  /** The workflow as a file to share, and what was left out of it (secrets, devices). */
  'workflows.export': (id: string) => { filename: string; text: string; notes: string[] }
  /** Reads a shared file into a workflow that is not saved yet. Throws a sentence when it is not one, or is not valid. */
  'workflows.import': (text: string) => Promise<{ name: string; description: string; definition: WorkflowDefinition; notes: string[] }>
  /** Asks an assistant to draft a workflow, from a description or from a conversation. Not saved: it opens for the person to look over. */
  'workflows.draft': (source: { kind: 'text'; text: string } | { kind: 'conversation'; sessionId: string }) => Promise<{ name: string; description: string; definition: WorkflowDefinition; notes: string[] }>
  /** Lets the assistant start this workflow (after Celeste asks), or stops it. */
  'workflows.setAssistant': (id: string, allow: boolean) => WorkflowSummary
  /** Deletes the workflow, its versions and its runs. A run in progress is stopped first. */
  'workflows.remove': (id: string) => Promise<void>
  'workflows.versions': (id: string) => { version: number; createdAt: number }[]
  'workflows.version': (id: string, version: number) => WorkflowDefinition | null
  /** Starts a run in a folder of the person's choosing (an empty one: a private folder for the workflow) and answers at once; the run reports through `run` and `runEvent` pushes. */
  'workflows.run': (id: string, inputs: Record<string, unknown>, where: { folder: string; sessionId?: string; startedBy?: 'you' | 'menu' }) => Promise<RunSummary>
  'runs.list': (workflowId?: string) => RunSummary[]
  'runs.get': (id: string) => { summary: RunSummary; events: StoredRunEvent[] } | null
  'runs.cancel': (id: string) => Promise<void>
  'runs.respondApproval': (runId: string, requestId: string, allow: boolean) => void
  'runs.respondAsk': (runId: string, requestId: string, answers: AskAnswers) => void
  /** The tools (MCP servers) the person has added, shared by every vendor. */
  'mcp.list': () => McpServerView[]
  /** Adds a server, or changes the one with `id`. It is looked at straight after. */
  'mcp.save': (input: McpServerInput) => Promise<McpServerView>
  'mcp.remove': (id: string) => void
  'mcp.setEnabled': (id: string, enabled: boolean) => McpServerView
  /** Connects to the server, asks what tools it has, and disconnects. */
  'mcp.test': (id: string) => Promise<McpStatus>
  /** Makes a separate copy (a git worktree) of the project in Celeste's data folder, on a new branch from its last commit. */
  'project.createWorktree': (repo: string, hint: string) => Promise<{ path: string; branch: string }>
  /** The separate copies on this computer, with what would be lost if one were removed. */
  'project.worktrees': () => Promise<WorktreeInfo[]>
  /** Removes a separate copy and its branch. Only one that Celeste made. */
  'project.removeWorktree': (path: string) => Promise<void>
  /** What is in a folder of the session's project (`path` is relative to the project, empty for the top). Develop sessions only. */
  'sessions.listFiles': (id: string, path: string) => Promise<FileListing>
  /** A file of the session's project, for a preview. Nothing outside the project folder, and nothing inside its `.git`. */
  'sessions.readFile': (id: string, path: string) => Promise<FilePreview>
  /** The files that changed between two checkpoints of a session (`to` null: up to now), with their lines, for review. */
  'sessions.review': (id: string, from: string, to: string | null) => Promise<CheckpointReview>
  /** Puts only these files back as they were at the checkpoint, after saving how things are now so it can be undone. */
  'sessions.discardFiles': (id: string, checkpointId: string, paths: string[]) => Promise<{ restored: number; removed: number; undoId: string }>
  /** Puts the folder back as it was at the checkpoint, after saving how it is now so the revert can be undone. */
  'sessions.revert': (id: string, checkpointId: string) => Promise<{ restored: number; removed: number; undoId: string }>
  /** Hides the session. It is deleted for good a few seconds later, unless `restore` comes first. */
  'sessions.remove': (id: string) => void
  'sessions.restore': (id: string) => SessionSummary | null
  /** Deletes every session at once, with no undo. Returns the ids. */
  'sessions.removeAll': () => string[]
  'sessions.search': (query: string) => SearchHit[]

  'drafts.set': (key: string, draft: DraftState | null) => void

  'attachments.save': (file: NewAttachment) => AttachmentInfo
  /** Removes an attachment that was never sent. Sent ones belong to their session. */
  'attachments.discard': (id: string) => void

  'devices.list': () => Promise<DeviceRecord[]>
  /** Adds an unverified device. Store its password with `window.celeste.secrets`, then call `devices.test`. */
  'devices.create': (input: NewDevice) => Promise<DeviceRecord>
  'devices.update': (id: string, patch: DevicePatch) => Promise<DeviceRecord>
  'devices.remove': (id: string) => Promise<void>
  /** Connects, learns the operating system, and checks the pinned host key. */
  'devices.test': (id: string) => Promise<TestResult>
  /** Pins the host key the person confirmed. */
  'devices.trustKey': (id: string, fingerprint: string) => Promise<DeviceRecord>
  'devices.discover': () => Promise<FoundDevice[]>
  /** Android: pairs with the address and six-digit code the phone shows, connects, and adds the device. */
  'devices.pairByCode': (address: string, code: string, name: string) => Promise<DeviceRecord>
  /** Android: returns the text for a QR code to scan on the phone, then waits for it and adds the device. */
  'devices.startQrPairing': (name: string) => Promise<{ payload: string }>
  'devices.cancelQrPairing': () => Promise<void>
  'devices.attach': (sessionId: string, deviceId: string, on: boolean) => Promise<string[]>
  'devices.attached': (sessionId: string) => Promise<string[]>
  'devices.browse': (deviceId: string, path: string) => Promise<DirEntry[]>
  'devices.folders': () => Promise<DeviceFolder[]>
  'devices.addFolder': (deviceId: string, path: string, mode: FolderMode, confirm?: boolean) => Promise<AddFolderResult>
  'devices.refreshFolder': (folderId: string) => Promise<AddFolderResult>
  'devices.removeFolder': (folderId: string) => Promise<void>
  'devices.activity': (deviceId: string) => Promise<DeviceActivity[]>
  /** The loopback address and token an agent uses to reach this session's device tools. */
  'devices.toolServer': (sessionId: string) => Promise<{ url: string; token: string } | null>

  /** Whether a folder exists, and which git branch it is on. For Develop's project picker. */
  'project.inspect': (path: string) => Promise<{ exists: boolean; branch: string | null }>

  /** Settings → Phone: whether phones may connect, the address for the QR code, and the paired phones (docs/PHONE_PLAN.md). */
  'phone.status': () => PhoneStatus
  /** Starts or stops listening for phones on the local network. */
  'phone.setEnabled': (on: boolean) => Promise<PhoneStatus>
  /** Forgets a phone. It is cut off at once and must pair again. */
  'phone.remove': (phoneId: string) => PhoneStatus
  /** Allow or stop a phone watching the computer's screen while the assistant uses it (docs/PHONE_PLAN.md 7.3). */
  'phone.setWatch': (phoneId: string, on: boolean) => PhoneStatus
  /** The person's answer to a phone asking to connect, after comparing the three pictures. */
  'phone.answer': (pairId: string, allow: boolean) => PhoneStatus
}

export type DeviceApi = { [K in keyof CoreApi as K extends `devices.${string}` ? K : never]: CoreApi[K] }
export type WorkflowApi = { [K in keyof CoreApi as K extends `workflows.${string}` | `runs.${string}` ? K : never]: CoreApi[K] }
export type TerminalApi = { [K in keyof CoreApi as K extends `terminal.${string}` ? K : never]: CoreApi[K] }
export type McpApi = { [K in keyof CoreApi as K extends `mcp.${string}` ? K : never]: CoreApi[K] }
export type VendorLinkApi = { [K in keyof CoreApi as K extends `vendor.${string}` ? K : never]: CoreApi[K] }
export type ProjectApi = { [K in keyof CoreApi as K extends `project.${string}` ? K : never]: CoreApi[K] }
export type PhoneApi = { [K in keyof CoreApi as K extends `phone.${string}` ? K : never]: CoreApi[K] }
/** The methods the session service answers. The device service and the vendor service answer the rest. */
export type SessionApi = Omit<CoreApi, keyof DeviceApi | keyof VendorLinkApi | keyof ProjectApi | keyof McpApi | keyof TerminalApi | keyof WorkflowApi | keyof PhoneApi | 'app.checkUpdate'>

export type CoreMethod = keyof CoreApi
export type CoreParams<M extends CoreMethod> = Parameters<CoreApi[M]>
export type CoreResult<M extends CoreMethod> = ReturnType<CoreApi[M]>

export type CorePush =
  | { type: 'devices' }
  | { type: 'mcp' }
  /** The list of workflows changed. */
  | { type: 'workflows' }
  /** A workflow run was created or changed. */
  | { type: 'run'; run: RunSummary }
  /** Something happened in a run; `stored` is its place in the run's log. */
  | { type: 'runEvent'; runId: string; stored: StoredRunEvent }
  /** Output from a session's shell; `exited` is set once, when the shell ends. */
  | { type: 'terminal'; sessionId: string; data: string; exited?: number }
  | { type: 'vendor'; vendor: VendorId; progress: VendorProgress }
  | { type: 'event'; sessionId: string; stored: StoredEvent }
  | { type: 'summary'; session: SessionSummary }
  | { type: 'removed'; id: string }
  /** Settings → Phone changed: a phone was added, removed or seen, or listening started or stopped. */
  | { type: 'phone' }
  /** A phone is asking to connect (the person compares the pictures and answers), or no longer is (null). */
  | { type: 'phonePairing'; request: PhonePairRequest | null }

/** Wire format over the message port between the window and Core. */
export type CoreRequest = { id: number; method: CoreMethod; params: unknown[] }
export type CoreResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
export type CoreMessage = { kind: 'response'; response: CoreResponse } | { kind: 'push'; push: CorePush }

export const UNDO_WINDOW_MS = 10_000
