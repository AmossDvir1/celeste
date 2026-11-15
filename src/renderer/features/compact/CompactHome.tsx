import { useMemo } from 'react'
import { ChevronRight, Code, MessageSquare } from 'lucide-react'
import type { SessionMode, UserInput } from '@shared/agent'
import { cn } from '@/lib/cn'
import { greetingFor } from '@/lib/format'
import { Button } from '@/components/ui'
import { Composer } from '@/features/chat/Composer'
import { useAttachments } from '@/features/chat/attachments'
import { ProjectBar } from '@/features/develop/ProjectBar'
import { useDrafts } from '@/stores/drafts'
import { needsYou, useSessions } from '@/stores/sessions'
import { useSettings } from '@/stores/settings'
import type { Session } from '@/stores/types'
import { useUi } from '@/stores/ui'

/** The chats and sessions of the sidebar, for a window too small to have one: what is waiting for you, a place to type, and the recent ones. */

const RECENT = 6

/** The approval a session is waiting on, when it is a plain yes or no (not a question with choices or a time) and the log is loaded. */
function plainApproval(s: Session): { requestId: string; title: string } | null {
  if (!s.loaded) return null
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]
    if (it?.kind === 'approval' && it.status === 'pending') return it.choices || it.slider ? null : { requestId: it.requestId, title: it.title }
  }
  return null
}

function open(s: Session): void {
  useUi.getState().setMode(s.mode)
  useSessions.getState().open(s.id)
}

/** What needs you, from any mode, with Allow and Deny when the question is a plain one. */
function NeedsYou({ sessions }: { sessions: Session[] }) {
  const respond = useSessions((s) => s.respondApproval)
  if (sessions.length === 0) return null
  return (
    <section aria-label="Needs you" className="space-y-1.5">
      {sessions.map((s) => {
        const ask = plainApproval(s)
        return (
          <div key={s.id} className="rounded-xl border border-accent-edge bg-accent-soft/40 p-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{s.title}</span>
              <button type="button" onClick={() => open(s)} className="shrink-0 text-xs text-accent-text hover:underline">
                Open
              </button>
            </div>
            <p className="mt-1 text-[13px] text-ink-soft">{ask ? ask.title : 'Waiting for you.'}</p>
            {ask && (
              <div className="mt-2 flex gap-2">
                <Button variant="primary" onClick={() => respond(s.id, ask.requestId, true)}>
                  Allow
                </Button>
                <Button variant="secondary" onClick={() => respond(s.id, ask.requestId, false)}>
                  Deny
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}

function Row({ s, label }: { s: Session; label?: string }) {
  const waiting = needsYou(s)
  const working = s.status === 'working'
  return (
    <li>
      <button type="button" onClick={() => open(s)} className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover">
        <span className="min-w-0 flex-1">
          {label && <span className="block text-[11px] tracking-wide text-ink-faint uppercase">{label}</span>}
          <span className="block truncate text-[14px] text-ink">{s.title}</span>
        </span>
        {waiting ? <span className="shrink-0 text-xs text-accent-text">Needs you</span> : working ? <span className="shrink-0 text-xs text-accent-text">Working…</span> : null}
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" />
      </button>
    </li>
  )
}

export function CompactHome({ mode }: { mode: SessionMode }) {
  const userName = useSettings((s) => s.userName)
  const sessions = useSessions((s) => s.sessions)
  const send = useSessions((s) => s.send)
  const draft = useUi((s) => s.draft)
  const setDraft = useUi((s) => s.setDraft)
  const setCompact = useUi((s) => s.setCompact)
  // Unsent text is saved as a draft under the same key as the full window's home, so it is the same box on both sides.
  const draftKey = `home:${mode}`
  const attachments = useAttachments(draftKey)
  const text = useDrafts((s) => s.drafts[draftKey]?.text ?? '')
  const setText = (t: string) => useDrafts.getState().setText(draftKey, t)

  const waiting = useMemo(() => Object.values(sessions).filter(needsYou), [sessions])
  const mine = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.mode === mode)
        .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt),
    [sessions, mode]
  )
  const pinned = mine.filter((s) => s.pinnedAt != null)
  const others = mine.filter((s) => s.pinnedAt == null)
  const last = others[0]
  const rest = [...pinned, ...others.slice(1)].slice(0, RECENT)
  const Icon = mode === 'develop' ? Code : MessageSquare

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-3 py-3">
      <div className="space-y-3">
        <h1 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
          <Icon className="h-[18px] w-[18px] text-accent-text" />
          {greetingFor()}, {userName}.
        </h1>

        <NeedsYou sessions={waiting} />

        {mode === 'develop' && <ProjectBar />}

        <Composer
          variant="dock"
          compact
          mode={mode}
          text={text}
          onText={setText}
          prefs={draft}
          onPrefs={setDraft}
          attachments={attachments}
          onSend={(input: UserInput) => send(mode, input)}
          autoFocus
          placeholder={mode === 'develop' ? 'What should we work on?' : 'Ask Celeste…'}
        />
      </div>

      <section aria-label={mode === 'develop' ? 'Recent sessions' : 'Recent chats'} className={cn('mt-5 min-h-0', mine.length === 0 && 'hidden')}>
        <h2 className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-ink-faint uppercase">{mode === 'develop' ? 'Recent sessions' : 'Recent chats'}</h2>
        <ul>
          {last && <Row s={last} label="Continue" />}
          {rest.map((s) => (
            <Row key={s.id} s={s} />
          ))}
        </ul>
        {mine.length > RECENT + 1 && (
          <button type="button" onClick={() => setCompact(false)} className="mt-1 px-2.5 text-xs text-accent-text hover:underline">
            Show all in the full view
          </button>
        )}
      </section>
    </div>
  )
}
