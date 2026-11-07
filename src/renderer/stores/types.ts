import type {
  AgentError,
  ApprovalMode,
  AskAnswers,
  AttachmentInfo,
  Effort,
  FileDiff,
  Question,
  SessionMode,
  ToolKind
} from '@shared/agent'

/** What the conversation shows, built by reducing AgentEvents. Saved with the session in Phase 2. */
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

export type SessionStatus = 'idle' | 'working' | 'waiting'

export interface Session {
  id: string
  mode: SessionMode
  title: string
  model: string
  effort: Effort | null
  approval: ApprovalMode
  cwd?: string
  branch?: string
  items: TimelineItem[]
  status: SessionStatus
  activity: Activity | null
  createdAt: number
  updatedAt: number
}
