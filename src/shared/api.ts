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
import type {
  AgentEvent,
  ApprovalAnswer,
  ApprovalMode,
  AskAnswers,
  AttachmentInfo,
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
  /** Models the person pinned to the top of the model menu, in the order they were pinned. */
  pinnedModels: string[]
  defaults: { model: string; approval: ApprovalMode; projectsFolder: string }
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

export interface SessionPatch {
  title?: string
  model?: string
  effort?: Effort | null
  approval?: ApprovalMode
}

/**
 * What a session's log holds. The agent's events, plus the things the user did and one that Celeste recorded
 * itself. Replaying the log rebuilds the conversation exactly, with no vendor call.
 */
export type LogEvent =
  | AgentEvent
  | { type: 'user.message'; text: string; attachments: AttachmentInfo[] }
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
  /** The folder was put back as it was at checkpoint `id`. `undoId` goes back to how it was just before. */
  | { type: 'checkpoint.reverted'; id: string; restored: number; removed: number; undoId: string }

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
}

/** The methods of Core. Return types are what the caller receives, wrapped in a Promise by the transport. */
export interface CoreApi {
  'app.bootstrap': () => Bootstrap
  'settings.patch': (patch: SettingsPatch) => AppSettings
  'vendors.set': (id: VendorId, record: VendorRecord | null) => void

  /** Whether the vendor's agent is ready, without starting a sign-in. Starts its program if it is on this computer. */
  'vendor.status': (id: VendorId) => Promise<VendorConnection>
  /** Starts connecting: downloads the program if needed, then signs in. Answers at once; progress arrives as `vendor` pushes. */
  'vendor.signIn': (id: VendorId, method: 'web' | 'code') => Promise<void>
  'vendor.cancelSignIn': (id: VendorId) => Promise<void>
  /**
   * Makes sure the vendor's program is on this computer, downloading it if not. Progress arrives as `vendor` pushes; the call
   * answers when it is there (true) or when the download was cancelled or failed (false, and a `failed` push says why).
   */
  'vendor.prepare': (id: VendorId) => Promise<boolean>
  /** The models this account can use, with the effort levels each takes. Empty when the vendor is not ready. */
  'vendor.models': (id: VendorId) => Promise<ModelInfo[]>

  'sessions.create': (input: CreateSessionInput) => SessionSummary
  'sessions.get': (id: string) => { summary: SessionSummary; events: StoredEvent[] } | null
  'sessions.send': (id: string, input: UserInput) => void
  'sessions.interrupt': (id: string) => void
  'sessions.respondApproval': (id: string, requestId: string, answer: ApprovalAnswer) => void
  'sessions.respondAsk': (id: string, requestId: string, answers: AskAnswers) => void
  'sessions.update': (id: string, patch: SessionPatch) => SessionSummary
  /** What reverting to a checkpoint would change in the folder, as it would be after the revert. */
  'sessions.revertPreview': (id: string, checkpointId: string) => Promise<CheckpointChanges>
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
}

export type DeviceApi = { [K in keyof CoreApi as K extends `devices.${string}` ? K : never]: CoreApi[K] }
export type VendorLinkApi = { [K in keyof CoreApi as K extends `vendor.${string}` ? K : never]: CoreApi[K] }
export type ProjectApi = { [K in keyof CoreApi as K extends `project.${string}` ? K : never]: CoreApi[K] }
/** The methods the session service answers. The device service and the vendor service answer the rest. */
export type SessionApi = Omit<CoreApi, keyof DeviceApi | keyof VendorLinkApi | keyof ProjectApi>

export type CoreMethod = keyof CoreApi
export type CoreParams<M extends CoreMethod> = Parameters<CoreApi[M]>
export type CoreResult<M extends CoreMethod> = ReturnType<CoreApi[M]>

export type CorePush =
  | { type: 'devices' }
  | { type: 'vendor'; vendor: VendorId; progress: VendorProgress }
  | { type: 'event'; sessionId: string; stored: StoredEvent }
  | { type: 'summary'; session: SessionSummary }
  | { type: 'removed'; id: string }

/** Wire format over the message port between the window and Core. */
export type CoreRequest = { id: number; method: CoreMethod; params: unknown[] }
export type CoreResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
export type CoreMessage = { kind: 'response'; response: CoreResponse } | { kind: 'push'; push: CorePush }

export const UNDO_WINDOW_MS = 10_000
