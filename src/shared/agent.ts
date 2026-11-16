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

/**
 * A card that shows something Celeste's assistant wants to add (a workflow to save, a plugin to install) and has its own buttons. It is an
 * approval card with a payload, not a new event. The payload is built in Core from validated arguments, never from the model's wording,
 * and holds what the card draws; what is saved on Allow is what Core itself kept, not what comes back in the answer.
 */
export type ApprovalProposal =
  | {
      kind: 'workflow'
      payload: {
        name: string
        description: string
        /** One line per step, in order. */
        steps: { name: string; summary: string }[]
        inputs: { name: string; type: string; required?: boolean }[]
        notes: string[]
      }
      /** The words on the button that saves it. */
      accept: string
      /** The words on the button that asks for another try. The answer carries what the person typed. */
      retry?: string
      /** A change to a workflow the person already has (not a new one): the card says so, and Save keeps a new version of it. */
      edit?: true
    }
  | {
      kind: 'plugin'
      payload: {
        server: { name: string; type: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; envNames: string[]; headerNames: string[] }
        /** Where the assistant says it found it. */
        source?: string
      }
      accept: string
      /** The names of the secrets the person types on the card before it can be installed. Never their values. */
      secrets?: string[]
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
  /** A proposal's "try again": what the person wants different, with `allow` false. */
  again?: string
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
  | { type: 'approval.requested'; requestId: string; kind: ToolKind; title: string; detail?: string; choices?: ApprovalChoices; slider?: ApprovalSlider; proposal?: ApprovalProposal }
  | { type: 'ask_user.requested'; requestId: string; questions: Question[] }
  | { type: 'usage.updated'; usage: Usage }
  /** A command the agent started and did not wait for (Claude's background shell). It goes on after the turn ends. */
  | { type: 'background.started'; taskId: string; title: string; command?: string }
  /** The background command ended. The agent may start a turn of its own to deal with the result. */
  | { type: 'background.finished'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string; outputFile?: string }
  /** Where a background command's output is being written (the program's own file), so the card can show it. */
  | { type: 'background.output'; taskId: string; outputFile: string }
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
  /**
   * Hands a message to the turn that is running, to be read at its next step, without starting a turn of its own. When no turn is running it
   * is the same as `send`. Only an assistant that can do this has it (see `canSteer` in shared/queue.ts).
   */
  steer?(input: UserInput): void
  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void
  setModel(model: string, effort?: Effort): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  interrupt(): Promise<void>
  /** Stops one command that goes on after the turn (see `background.started`), and nothing else. Only an assistant that has such commands offers it. */
  stopBackground?(taskId: string): Promise<void>
  close(): Promise<void>
}
