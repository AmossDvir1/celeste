import type { LogEvent, SessionStatus } from './api'

/**
 * Whether an event moves a session to the top of the list: the person's message, and the way a turn ends. Tokens, thinking and tool
 * calls do not. If they did, two sessions answering at once would trade places with every word, and the list would never hold still.
 * (Claude and ChatGPT order their lists the same way: by the last message, not by what is being written now.)
 */
export function movesSession(e: LogEvent): boolean {
  switch (e.type) {
    case 'user.message':
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
    case 'turn.abandoned':
    case 'checkpoint.reverted':
      return true
    default:
      return false
  }
}

/**
 * A session's status after one more event. Core uses it to keep the sidebar's status current without
 * replaying the log, and a test checks it against the window's reducer so the two cannot drift apart.
 */
export function nextStatus(prev: SessionStatus, e: LogEvent): SessionStatus {
  switch (e.type) {
    case 'turn.started':
    case 'thinking.delta':
    case 'message.delta':
    case 'tool.started':
    case 'approval.resolved':
    case 'ask.answered':
      return 'working'
    case 'approval.requested':
    case 'ask_user.requested':
      return 'waiting'
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
    case 'turn.abandoned':
      return 'idle'
    default:
      return prev
  }
}
