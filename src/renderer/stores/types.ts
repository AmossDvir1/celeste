import type {
  AgentError,
  ApprovalChoices,
  ApprovalSlider,
  AskAnswers,
  AttachmentInfo,
  ContextRef,
  FileDiff,
  Question,
  ToolKind
} from '@shared/agent'
import type { CheckpointFile, SessionStatus, SessionSummary } from '@shared/api'
import type { ProducedFile } from '@shared/produced'

export type { SessionStatus }

/** What the conversation shows, built by replaying the session's log of events. */
export type TimelineItem =
  | {
      kind: 'user'
      id: string
      text: string
      attachments: AttachmentInfo[]
      /** Files and folders of the project that were added to the message. */
      context?: ContextRef[]
      at: number
      /** Develop: the folder was saved just before this message. `files` is what the turn changed, known once it ends. */
      checkpoint?: { id: string; files?: CheckpointFile[]; more?: number }
    }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; startedAt: number; endedAt?: number }
  | {
      kind: 'tool'
      id: string
      tool: ToolKind
      title: string
      input?: string
      output: string
      status: 'running' | 'ok' | 'failed'
      diff?: FileDiff[]
      startedAt: number
      endedAt?: number
    }
  | {
      kind: 'approval'
      id: string
      requestId: string
      tool: ToolKind
      title: string
      detail?: string
      /** Set when the question can be answered for now or for good: the words for each. */
      choices?: ApprovalChoices
      /** Set when the question asks for how long: the slider's range and where it starts. */
      slider?: ApprovalSlider
      status: 'pending' | 'allowed' | 'denied'
    }
  | { kind: 'ask'; id: string; requestId: string; questions: Question[]; answers?: AskAnswers; status: 'pending' | 'answered' }
  | { kind: 'error'; id: string; error: AgentError }
  | { kind: 'notice'; id: string; text: string }
  /** A workflow started from this conversation. The card reads the run itself, so it shows steps as they happen and the result after. */
  | { kind: 'workflow'; id: string; runId: string; workflowId: string; name: string }
  /** Chat: files the agent wrote during the turn, offered to open. */
  | { kind: 'files'; id: string; files: ProducedFile[]; more: number }
  /** The assistant was allowed to use this computer's mouse and keyboard: what it did, and how it ended. */
  | { kind: 'desktop'; id: string; grantId: string; reason: string; until: number; /** The paired phone, not this computer. */ where?: 'phone'; actions: { text: string; ok: boolean; note?: boolean }[]; ended?: { why: string; actions: number } }
  /** The folder was put back to a checkpoint. `undoId` goes back to how it was just before. */
  | { kind: 'reverted'; id: string; restored: number; removed: number; undoId: string }

/** The line shown under the conversation while the agent works. */
export interface Activity {
  label: string
  /** False when nothing is working, for example while waiting for the user. */
  working: boolean
}

/**
 * A session in the window: its summary from Core, plus the conversation once it is loaded. Sessions that have
 * not been opened are only a summary, so the sidebar can list thousands without reading their logs.
 */
export interface Session extends SessionSummary {
  items: TimelineItem[]
  activity: Activity | null
  /** False until the session's log has been loaded and replayed. */
  loaded: boolean
  /** The newest log entry already replayed into `items`. */
  foldedSeq: number
}
