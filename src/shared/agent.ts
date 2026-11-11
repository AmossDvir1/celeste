// The vendor boundary. The UI knows only these types, never a vendor's own format.
// Each vendor's adapter turns that vendor's own format into these (src/core/adapters).

export type VendorId = 'copilot' | 'claude' | 'openai' | 'gemini'
export type SessionMode = 'chat' | 'develop'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** The words on the two buttons of a question that can be answered for just now, or for good (Celeste's own questions, such as the browser's). */
export interface ApprovalChoices {
  /** Yes, for now: for this chat. */
  allow: string
  /** Yes, and do not ask again. */
  always: string
}

/** A slider on a question that asks for how long (minutes): where it starts, and its range. Desktop control's card has one. */
export interface ApprovalSlider {
  min: number
  max: number
  step: number
  value: number
  /** When set, the card also offers "Until I stop it", which answers with this many minutes. */
  until?: number
}

export type ApprovalMode = 'auto' | 'edits' | 'ask' | 'plan'
export type ToolKind = 'read' | 'edit' | 'write' | 'shell' | 'web' | 'search' | 'mcp' | 'agent' | 'other'

export interface ModelInfo {
  id: string
  vendor: VendorId
  label: string
  /** Empty when the model has no effort setting: the slider is shown disabled, not hidden. */
  efforts: Effort[]
  defaultEffort?: Effort
  /** False when the model cannot read images: the composer says so on attach. */
  images: boolean
}

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
  oldNo?: number
  newNo?: number
}
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export interface FileDiff {
  path: string
  status: 'modified' | 'added' | 'deleted'
  added: number
  removed: number
  hunks: DiffHunk[]
  /** The file is not text, so there are no lines to show. */
  binary?: boolean
  /** The change is too large to show here, so there are no lines to show. */
  truncated?: boolean
}

export interface QuestionOption {
  label: string
  description?: string
}
export interface Question {
  header: string
  question: string
  options: QuestionOption[]
  multiSelect: boolean
}
export type AskAnswers = Record<string, string | string[]>
export interface ApprovalAnswer {
  allow: boolean
  always?: boolean
  /** Where the slider of the card was left, when it had one. */
  minutes?: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface AgentError {
  code: 'auth' | 'rate_limit' | 'network' | 'tool' | 'unknown'
  message: string
  retryable: boolean
}

export interface AttachmentInfo {
  id: string
  name: string
  mime: string
  size: number
  /** Object or data URL for display. Real sessions copy the file into app data on send. */
  url?: string
  width?: number
  height?: number
}

/** A file or folder of the project that the person dragged into a message so the agent looks at it. The path is relative to the project. */
export interface ContextRef {
  path: string
  kind: 'file' | 'dir'
}

export interface UserInput {
  text: string
  attachments: AttachmentInfo[]
  /** Develop only. Core turns these into what the agent is told; the agent's own adapter never sees this field. */
  context?: ContextRef[]
}

export type AgentEvent =
  | { type: 'turn.started'; turnId: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'message.delta'; text: string }
  | { type: 'tool.started'; id: string; kind: ToolKind; title: string; input?: unknown }
  | { type: 'tool.output'; id: string; text: string }
  | { type: 'tool.completed'; id: string; ok: boolean; result?: string; diff?: FileDiff[] }
  | { type: 'approval.requested'; requestId: string; kind: ToolKind; title: string; detail?: string; choices?: ApprovalChoices; slider?: ApprovalSlider }
  | { type: 'ask_user.requested'; requestId: string; questions: Question[] }
  | { type: 'usage.updated'; usage: Usage }
  | { type: 'turn.completed'; turnId: string }
  | { type: 'turn.interrupted'; turnId: string }
  | { type: 'turn.failed'; turnId: string; error: AgentError }

export interface SessionOptions {
  mode: SessionMode
  model: string
  effort?: Effort
  approval: ApprovalMode
  cwd?: string
  vendorSessionId?: string
}

export interface AgentSession {
  readonly vendorSessionId: string
  readonly events: AsyncIterable<AgentEvent>
  send(input: UserInput): void
  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void
  setModel(model: string, effort?: Effort): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  interrupt(): Promise<void>
  close(): Promise<void>
}
