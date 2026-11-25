import type {
  AgentError,
  ApprovalChoices,
  ApprovalProposal,
  ApprovalSlider,
  AskAnswers,
  AttachmentInfo,
  ContextRef,
  FileDiff,
  Question,
  ToolKind,
  VendorId
} from '@shared/agent'
import type { CheckpointFile, SessionStatus, SessionSummary } from '@shared/api'
import type { Finding, MoonStep, Seat } from '@shared/moons'
import type { QueueState } from '@shared/queue'
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
      /** Written by the assistant that started this helper (the task or a follow-up), not by the person. */
      from?: 'parent'
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
      /** Set when the card shows something to add (a workflow, a plugin) with its own buttons. `detail` says the same in words. */
      proposal?: ApprovalProposal
      /** `retried`: a proposal answered with "Try again". */
      status: 'pending' | 'allowed' | 'denied' | 'retried'
    }
  | { kind: 'ask'; id: string; requestId: string; questions: Question[]; answers?: AskAnswers; status: 'pending' | 'answered' | 'skipped' }
  /** A command the agent started in the background. It goes on after the turn ends; the card follows it to its end. */
  | { kind: 'background'; id: string; taskId: string; title: string; command?: string; status: 'running' | 'completed' | 'failed' | 'stopped'; summary?: string; outputFile?: string; startedAt: number; endedAt?: number }
  | { kind: 'error'; id: string; error: AgentError }
  | { kind: 'notice'; id: string; text: string }
  /** A workflow started from this conversation. The card reads the run itself, so it shows steps as they happen and the result after. */
  | { kind: 'workflow'; id: string; runId: string; workflowId: string; name: string }
  /** Chat: files the agent wrote during the turn, offered to open. */
  | { kind: 'files'; id: string; files: ProducedFile[]; more: number }
  /** The assistant was allowed to use this computer's mouse and keyboard: what it did, and how it ended. */
  | { kind: 'desktop'; id: string; grantId: string; reason: string; until: number; /** The paired phone, not this computer. */ where?: 'phone'; actions: { text: string; ok: boolean; note?: boolean }[]; ended?: { why: string; actions: number } }
  /**
   * The assistant started a helper (one card for each helper; more work for it adds a line, not a card). `finished` is how the current assignment
   * ended. `told`: the assistant has since been told of it with a message, which the card says in a quiet line.
   */
  | {
      kind: 'helper'
      id: string
      childId: string
      title: string
      vendor: VendorId
      model: string
      folder: 'same' | 'copy'
      /** The task, then the follow-ups. */
      tasks: string[]
      wait: boolean
      startedAt: number
      finished?: { status: 'done' | 'failed' | 'stopped' | 'abandoned' | 'deleted'; result?: string; error?: string; delivered: 'tool' | 'note' | 'none'; endedAt: number }
      told?: boolean
    }
  /** In a helper: the line at the top that says whose helper it is. */
  | { kind: 'spawned'; id: string; parentId: string; parentTitle: string }
  /** The folder was put back to a checkpoint. `undoId` goes back to how it was just before. */
  | { kind: 'reverted'; id: string; restored: number; removed: number; undoId: string }
  /** Two Moons: one moon handed work to the other. */
  | { kind: 'moonsHand'; id: string; from: Seat; to: Seat; what: string; at: number }
  /** Two Moons: what the moons said, one block until another item comes between. */
  | { kind: 'moonsTalk'; id: string; messages: MoonsMessage[] }
  /** Two Moons: the plan the Planner wrote. `agreed`: the person agreed to it. */
  | { kind: 'moonsPlan'; id: string; planId: string; say: string; steps: string[]; agreed?: true }
  /** Two Moons: what two reviews found, what both found first. */
  | { kind: 'moonsCompare'; id: string; both: Finding[]; first: Finding[]; second: Finding[] }
  /** Two Moons: how a run ended, when that is worth a line (a run that ended well and has nothing to add draws nothing). */
  | { kind: 'moonsEnded'; id: string; why: 'agreed' | 'nothing' | 'rounds' | 'declined' | 'stopped' | 'failed' | 'unread'; note?: string; left?: number }

/** One thing a moon said, in the conversation block of a Two Moons chat. `fixed`: the other moon agreed that this note was dealt with. */
export interface MoonsMessage {
  id: string
  seat: Seat
  text: string
  file?: string
  line?: number
  code?: string
  finding?: true
  fixed?: true
  to?: 'person'
  at: number
}

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
  /** Messages typed while the assistant was working, waiting for their turn. Kept in the log, so it is the same on every window and the phone. */
  queue: QueueState
  /** Two Moons: whose turn it is and what it is doing, while a run goes on. Absent otherwise. */
  moonsTurn?: { seat: Seat; step: MoonStep } | null
}
