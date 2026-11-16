import type { CorePush } from '@shared/api'
import type { RunStatus } from '@shared/workflow'

/*
 * What the main process needs to know while no window is open: how many chats and runs are working or waiting for the person (for the
 * tray's tooltip and the question before quitting), and the moments something starts waiting (to show a notification). Core already
 * sees every push, so it works this out and tells the main process in two small messages.
 */

export type AttentionMessage =
  /** A command the assistant started in the background has ended (not one the person stopped). */
  | { type: 'finished'; id: string; target: string; title: string; text: string }
  | { type: 'attention'; working: number; waiting: number }
  /** `target` is the chat's id, or the run's. `text` is what it asks. */
  | { type: 'needs-you'; id: string; kind: 'chat' | 'run'; target: string; title: string; text: string }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export class Attention {
  private readonly sessions = new Map<string, 'idle' | 'working' | 'waiting'>()
  private readonly runs = new Map<string, RunStatus>()
  /** The commands each chat has going in the background. They count as working, whatever the chat itself is doing. */
  private readonly background = new Map<string, Set<string>>()
  /** What was last reported. Nothing going on is the starting point, so it is not reported. */
  private last = '0:0'

  constructor(
    private readonly emit: (message: AttentionMessage) => void,
    /** The title of a chat, for the notification. */
    private readonly titleOf: (sessionId: string) => string | undefined = () => undefined
  ) {}

  observe(push: CorePush): void {
    switch (push.type) {
      case 'summary':
        this.sessions.set(push.session.id, push.session.status)
        break
      case 'removed':
        this.sessions.delete(push.id)
        this.background.delete(push.id)
        break
      case 'run': {
        const was = this.runs.get(push.run.id)
        if (push.run.status === 'running' || push.run.status === 'waiting') this.runs.set(push.run.id, push.run.status)
        else this.runs.delete(push.run.id)
        if (push.run.status === 'waiting' && was !== 'waiting') {
          this.emit({ type: 'needs-you', id: `run-${push.run.id}`, kind: 'run', target: push.run.id, title: clip(push.run.workflowName, 120), text: 'This workflow is waiting for your answer.' })
        }
        break
      }
      case 'event': {
        const e = push.stored.event
        if (e.type === 'background.started') {
          const tasks = this.background.get(push.sessionId) ?? new Set<string>()
          tasks.add(e.taskId)
          this.background.set(push.sessionId, tasks)
        } else if (e.type === 'background.finished') {
          const tasks = this.background.get(push.sessionId)
          const was = tasks?.delete(e.taskId) ?? false
          if (tasks?.size === 0) this.background.delete(push.sessionId)
          // Said once, and not for one the person stopped.
          if (was && e.status !== 'stopped') {
            this.emit({ type: 'finished', id: `bg-${push.sessionId}-${e.taskId}`, target: push.sessionId, title: clip(this.titleOf(push.sessionId) ?? 'Celeste', 120), text: clip(e.summary, 300) })
          }
        } else if (e.type === 'approval.requested') {
          this.emit({ type: 'needs-you', id: e.requestId, kind: 'chat', target: push.sessionId, title: clip(this.titleOf(push.sessionId) ?? 'Celeste', 120), text: clip(`${e.title}${e.detail ? `: ${e.detail}` : ''}`, 300) })
        } else if (e.type === 'ask_user.requested') {
          this.emit({ type: 'needs-you', id: e.requestId, kind: 'chat', target: push.sessionId, title: clip(this.titleOf(push.sessionId) ?? 'Celeste', 120), text: clip(e.questions[0]?.question ?? 'Celeste has a question for you.', 300) })
        }
        break
      }
      default:
        return
    }
    this.report()
  }

  /** Tells the main process the counts, but only when they changed. */
  private report(): void {
    let working = 0
    let waiting = 0
    for (const s of this.sessions.values()) {
      if (s === 'working') working++
      else if (s === 'waiting') waiting++
    }
    for (const tasks of this.background.values()) working += tasks.size
    for (const r of this.runs.values()) {
      if (r === 'running') working++
      else waiting++
    }
    const key = `${working}:${waiting}`
    if (key === this.last) return
    this.last = key
    this.emit({ type: 'attention', working, waiting })
  }
}
