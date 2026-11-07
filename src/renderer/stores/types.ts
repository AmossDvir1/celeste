import type {
  AgentError,
  AskAnswers,
  AttachmentInfo,
  FileDiff,
  Question,
  ToolKind
} from '@shared/agent'
import type { SessionStatus, SessionSummary } from '@shared/api'

export type { SessionStatus }

/** What the conversation shows, built by replaying the session's log of events. */
export type TimelineItem =
  | { kind: 'user'; id: string; text: string; attachments: AttachmentInfo[]; at: number }
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
      status: 'pending' | 'allowed' | 'denied'
    }
  | { kind: 'ask'; id: string; requestId: string; questions: Question[]; answers?: AskAnswers; status: 'pending' | 'answered' }
  | { kind: 'error'; id: string; error: AgentError }
  | { kind: 'notice'; id: string; text: string }

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
