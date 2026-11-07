import type { LogEvent, SessionStatus } from './api'

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
