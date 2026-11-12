import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Calendar,
  Check,
  ChevronRight,
  Code2,
  FileText,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Globe,
  LoaderCircle,
  Eye,
  MonitorSmartphone,
  Pencil,
  Plug,
  Search,
  Square,
  Terminal,
  Workflow,
  X,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { AskAnswers, ContextRef, Question, ToolKind } from '@shared/agent'
import type { QueueAction, QueueState, SendMode } from '@shared/queue'
import { describeDuration } from '@shared/desktop'
import type { PhoneModelChoice, PhoneNewSession, PhoneProject } from '@shared/phone'
import type { TimelineItem } from '@/stores/types'
import { formatDuration } from '@/lib/format'
import { groupLabel, toBlocks, type ThinkingItem, type ToolItem } from '@/features/chat/blocks'
import { useApp } from '../store'
import { Arc, Shimmer, buzz, greeting, rise } from '../ui'
import { ModelChip } from '../ModelPicker'
import { AttachButton, Chips, PasteChip, ProjectFiles, pastedFiles, useAttachments } from '../Attach'
import { ShareButton } from '../Share'
import { WatchScreen } from '../Watch'

const TOOL_ICON: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  write: Pencil,
  shell: Terminal,
  web: Globe,
  search: Search,
  mcp: Plug,
  agent: Bot,
  other: Workflow
}

export function Chat({ id }: { id: string }) {
  const s = useApp((st) => st.sessions[id])
  const online = useApp((st) => st.linkState === 'connected')
  const computer = useApp((st) => st.pairing?.computer.name ?? 'your computer')
  const go = useApp((st) => st.go)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [watching, setWatching] = useState(false)

  const blocks = useMemo(() => toBlocks(s?.items ?? [], s?.mode ?? 'chat'), [s?.items, s?.mode])

  // Follow the conversation as it grows, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [s?.items, s?.activity])

  if (!s) {
    return (
      <>
        <Head title="Chat" sub={computer} onBack={() => go({ name: 'home', tab: 'chats' }, 'back')} live={online} />
        <div className="empty">This chat is no longer on {computer}.</div>
      </>
    )
  }
  const working = s.status === 'working' || s.status === 'waiting'
  const where = s.mode === 'develop' ? (s.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? 'Develop') : 'Chat'
  // While Celeste waits on a card, the box answers it (a question with one part), or what is typed waits in the queue.
  const pendingAsk = [...s.items].reverse().find((it): it is Extract<TimelineItem, { kind: 'ask' }> => it.kind === 'ask' && it.status === 'pending')
  const pendingApproval = s.items.some((it) => it.kind === 'approval' && it.status === 'pending')
  const answerable = pendingAsk && pendingAsk.questions.length === 1 ? pendingAsk : null
  const last = s.items[s.items.length - 1]
  // The computer is under Celeste's control right now: its screen can be watched.
  const liveDesktop = [...s.items].reverse().find((it): it is Extract<TimelineItem, { kind: 'desktop' }> => it.kind === 'desktop' && it.where !== 'phone')
  const usingComputer = liveDesktop && !liveDesktop.ended ? liveDesktop : null
  // What Celeste is doing, shown right under the newest message, as on the computer.
  const showActivity = s.activity && !(last?.kind === 'thinking' && last.endedAt === undefined) && !(s.activity.working === false && (pendingAsk || pendingApproval))
  const placeholder = answerable ? 'Type your answer' : pendingApproval || pendingAsk ? 'Answer above, or type a message to send after' : working ? 'Type a message to send after this answer' : 'Message Celeste'

  return (
    <>
      <Head title={s.title || 'New chat'} sub={`${where} · on ${computer}`} onBack={() => go({ name: 'home', tab: 'chats' }, 'back')} live={online} />
            {usingComputer && (
              <div className="usebar">
                <span className="dot live" style={{ width: 8, height: 8 }} />
                <div className="grow">
                  <div className="a">Celeste is using your computer</div>
                  <div className="b">{usingComputer.actions.length} {usingComputer.actions.length === 1 ? 'action' : 'actions'} so far</div>
                </div>
                <button className="btn sm tonal" aria-label="Watch the computer’s screen" onClick={() => setWatching(true)}>
                  <Eye size={15} /> Watch
                </button>
              </div>
            )}
            {watching && usingComputer && <WatchScreen onClose={() => setWatching(false)} />}
            <div
              className="content"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {!s.loaded ? (
          <div className="empty">
            <Shimmer>Opening the chat</Shimmer>
          </div>
        ) : (
          <div className="msgs">
            {blocks.map((b) =>
              b.kind === 'group' ? (
                <ActivityGroup key={b.id} items={b.items} detailed={s.mode === 'develop'} />
              ) : (
                <Item key={b.item.id} it={b.item} sessionId={id} detailed={s.mode === 'develop'} />
              )
            )}
            {s.items.length === 0 && <div className="notice">Nothing here yet.</div>}
            {showActivity && s.activity && (
              <div className="thinking fresh" key={s.activity.label}>
                {s.activity.working ? <Shimmer>{s.activity.label}</Shimmer> : s.activity.label}
              </div>
            )}
          </div>
        )}
      </div>
      <QueueBar sessionId={id} queue={s.queue} working={working} />
      <Composer
        disabled={!online}
        working={working && !answerable}
        placeholder={placeholder}
        canAttach={!answerable}
        projectSession={s.mode === 'develop' && !answerable ? id : undefined}
        extra={<ModelChip value={{ model: s.model, effort: s.effort }} vendor={s.vendor} only={s.vendor} onChange={(c) => void useApp.getState().setModel(id, c)} />}
        onStop={() => {
          buzz(10)
          void useApp.getState().stop(id)
        }}
        onSend={(text, attachments, context, mode) => {
          if (answerable) {
            const q = answerable.questions[0] as Question
            return useApp.getState().answer(id, answerable.requestId, { [q.question]: q.multiSelect ? [text] : text })
          }
          return useApp.getState().send(id, text, attachments, context, mode)
        }}
      />
      {answerable && working && (
        <button className="btn text sm stop-under" onClick={() => void useApp.getState().stop(id)}>
          Stop instead
        </button>
      )}
    </>
  )
}

function Head({ title, sub, onBack, live }: { title: string; sub: string; onBack: () => void; live: boolean }) {
  return (
    <div className="chathead">
      <button className="iconbtn" aria-label="Back" onClick={onBack}>
        <ArrowLeft size={22} />
      </button>
      <div className="ttl">
        <div className="a">{title}</div>
        <div className="b">
          <span className={`dot live${live ? '' : ' off'}`} style={{ width: 6, height: 6 }} />
          {sub}
        </div>
      </div>
    </div>
  )
}

/** How much of a thought still being written shows, as on the computer. */
const TAIL = 240

const ThinkingRow = memo(function ThinkingRow({ it }: { it: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const streaming = it.endedAt === undefined
  const text = it.text.trim()
  const shown = open || !streaming || text.length <= TAIL ? text : `…${text.slice(-TAIL)}`
  return (
    <div className="think">
      <button type="button" className="think-h" aria-expanded={open} disabled={!text} onClick={() => setOpen(!open)}>
        {streaming ? <Shimmer>Thinking</Shimmer> : `Thought for ${formatDuration((it.endedAt ?? it.startedAt) - it.startedAt)}`}
      </button>
      {text && (open || streaming) && <div className="think-t">{shown}</div>}
    </div>
  )
})

const ToolCard = memo(function ToolCard({ it, detailed }: { it: ToolItem; detailed: boolean }) {
  // In Develop a change or a running command opens by itself; everything else is a tap away.
  const [open, setOpen] = useState(detailed && (!!it.diff?.length || it.status === 'running'))
  const Icon = TOOL_ICON[it.tool] ?? Workflow
  const detail = it.input ?? (it.diff?.length ? `${it.diff.length} ${it.diff.length === 1 ? 'file' : 'files'} changed` : '')
  return (
    <div>
      <button className={`m-tool ${it.status}${it.output ? ' tap' : ''}`} onClick={() => it.output && setOpen(!open)}>
        <Icon size={17} />
        <div className="grow">
          <div className="l">{it.title}</div>
          {detail && <div className="d mono">{detail}</div>}
        </div>
        <span className="st">{it.status === 'running' ? <LoaderCircle size={16} /> : it.status === 'ok' ? <Check size={16} /> : <X size={16} />}</span>
      </button>
      {open && it.output && <pre className="tool-out">{(it.status === 'running' ? it.output.split('\n').slice(-8).join('\n') : it.output).slice(-6000)}</pre>}
    </div>
  )
})

const sameItems = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** A run of thinking and tool calls folded into one line, closed until opened, exactly as the computer folds it. */
const ActivityGroup = memo(
  function ActivityGroup({ items, detailed }: { items: (ToolItem | ThinkingItem)[]; detailed: boolean }) {
    const [open, setOpen] = useState(false)
    const { running, text } = groupLabel(items, formatDuration)
    return (
      <div className="agroup">
        <button type="button" className="agroup-h" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={15} className={open ? 'open' : ''} />
          {running ? <Shimmer>{text}</Shimmer> : text}
        </button>
        {open && (
          <div className="agroup-b">
            {items.map((i) => (i.kind === 'tool' ? <ToolCard key={i.id} it={i} detailed={detailed} /> : <ThinkingRow key={i.id} it={i} />))}
          </div>
        )}
      </div>
    )
  },
  (a, b) => a.detailed === b.detailed && sameItems(a.items, b.items)
)

/** The assistant using the computer or this phone. Watching the computer is offered by the bar under the header, which stays in view. */
function DesktopRow({ it }: { it: Extract<TimelineItem, { kind: 'desktop' }> }) {
  return (
    <div className="m-tool">
      <MonitorSmartphone size={17} />
      <div className="grow">
        <div className="l">
          {it.where === 'phone' ? 'Used this phone' : 'Used the computer'}: {it.reason}
        </div>
        <div className="d">{it.ended ? `${it.ended.actions} actions · ${it.ended.why}` : `${it.actions.length} actions so far`}</div>
      </div>
      {it.where === 'phone' && !it.ended && <ShareButton />}
    </div>
  )
}

const Item = memo(function Item({ it, sessionId, detailed }: { it: TimelineItem; sessionId: string; detailed: boolean }) {
  switch (it.kind) {
    case 'user':
      return (
        <div className="m-user">
          {it.text}
          {it.attachments.length > 0 && (
            <div className="small faint">{it.attachments.map((a) => a.name).join(', ')}</div>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className="m-ai">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
            {it.text}
          </ReactMarkdown>
        </div>
      )
    case 'thinking':
      return <ThinkingRow it={it} />
    case 'tool':
      return <ToolCard it={it} detailed={detailed} />
    case 'approval':
      return <Approval it={it} sessionId={sessionId} />
    case 'ask':
      return <Ask it={it} sessionId={sessionId} />
    case 'error':
      return <div className="errcard">{it.error.message}</div>
    case 'notice':
      return <div className="notice">{it.text}</div>
    case 'workflow':
      return (
        <div className="m-tool">
          <Workflow size={17} />
          <div className="grow">
            <div className="l">Workflow: {it.name}</div>
            <div className="d">Follow it on the computer</div>
          </div>
        </div>
      )
    case 'files':
      return (
        <div className="m-tool">
          <FileText size={17} />
          <div className="grow">
            <div className="l">
              Made {it.files.length + it.more} {it.files.length + it.more === 1 ? 'file' : 'files'}
            </div>
            <div className="d">{it.files.map((f) => f.path.split(/[\\/]/).pop()).join(', ')}</div>
          </div>
        </div>
      )
    case 'desktop':
      return <DesktopRow it={it} />
    case 'reverted':
      return <div className="notice">The folder was put back ({it.restored} restored, {it.removed} removed).</div>
  }
})

function Approval({ it, sessionId }: { it: Extract<TimelineItem, { kind: 'approval' }>; sessionId: string }) {
  const Icon = TOOL_ICON[it.tool] ?? Workflow
  const pending = it.status === 'pending'
  const slider = it.slider
  // How long, for a card that asks (taking control of a computer): the slider, or "Until I stop it", as on the computer.
  const [minutes, setMinutes] = useState(slider?.value ?? 0)
  const [untilStopped, setUntilStopped] = useState(false)
  const howLong = untilStopped ? 'Until I stop it' : `For ${describeDuration(minutes * 60_000)}`
  return (
    <div className={`approval ${pending ? 'pending' : 'done'}`}>
      <div className="hd">
        <Icon size={18} /> {it.title}
        {pending && <span className="faint">Needs you</span>}
      </div>
      {it.detail && <pre className="mono">{it.detail}</pre>}
      {pending && slider && (
        <div className="duration">
          <label htmlFor={`minutes-${it.requestId}`} className="how">
            {howLong}
          </label>
          <input
            id={`minutes-${it.requestId}`}
            type="range"
            aria-label={`How long: ${howLong.toLowerCase()}`}
            min={slider.min}
            max={slider.max}
            step={slider.step}
            value={minutes}
            disabled={untilStopped}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
          {slider.until !== undefined && (
            <button type="button" role="checkbox" aria-checked={untilStopped} className="until" onClick={() => setUntilStopped(!untilStopped)}>
              <span className={`box${untilStopped ? ' on' : ''}`}>{untilStopped && <Check size={14} />}</span>
              <span>
                Until I stop it
                <span className="faint"> (ends by itself after 5 minutes with nothing done, or 12 hours)</span>
              </span>
            </button>
          )}
        </div>
      )}
      {pending ? (
        <div className="acts">
          <button
            className="btn tonal"
            onClick={() => {
              buzz(6)
              void useApp.getState().approve(sessionId, it.requestId, false)
            }}
          >
            Deny
          </button>
          <button
            className="btn primary"
            onClick={() => {
              buzz(12)
              const answer = slider ? (untilStopped && slider.until !== undefined ? slider.until : minutes) : undefined
              void useApp.getState().approve(sessionId, it.requestId, true, answer)
            }}
          >
            {it.choices?.allow ?? 'Approve'}
          </button>
        </div>
      ) : (
        <div className="res" style={{ color: it.status === 'allowed' ? 'var(--c-success)' : 'var(--c-ink-faint)' }}>
          {it.status === 'allowed' ? <Check size={16} className="draw" /> : <X size={16} />} {it.status === 'allowed' ? 'Approved' : 'Denied'}
        </div>
      )}
    </div>
  )
}

function Ask({ it, sessionId }: { it: Extract<TimelineItem, { kind: 'ask' }>; sessionId: string }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  if (it.status === 'answered') {
    return (
      <div className="approval done ask">
        {it.questions.map((q) => (
          <div key={q.question} className="small">
            <span className="faint">{q.question}</span>
            <br />
            {[it.answers?.[q.question] ?? ''].flat().join(', ') || '—'}
          </div>
        ))}
      </div>
    )
  }
  const otherOf = (q: Question) => (other[q.question] ?? '').trim()
  const complete = it.questions.every((q) => (picked[q.question] ?? []).length > 0 || otherOf(q).length > 0)
  return (
    <div className="approval pending ask">
      {it.questions.map((q) => (
        <div key={q.question}>
          <div className="overline" style={{ fontSize: 10 }}>
            {q.header}
          </div>
          <div className="q">{q.question}</div>
          {q.options.map((o) => {
            const on = (picked[q.question] ?? []).includes(o.label)
            return (
              <button
                key={o.label}
                className={`opt${on ? ' on' : ''}`}
                onClick={() => {
                  buzz(5)
                  setPicked((p) => {
                    const cur = p[q.question] ?? []
                    return { ...p, [q.question]: q.multiSelect ? (on ? cur.filter((l) => l !== o.label) : [...cur, o.label]) : [o.label] }
                  })
                  if (!q.multiSelect) setOther((x) => ({ ...x, [q.question]: '' }))
                }}
              >
                <span className="box">{on && <Check size={14} />}</span>
                <span>
                  {o.label}
                  {o.description && <div className="ds">{o.description}</div>}
                </span>
              </button>
            )
          })}
          {/* Any answer of the person's own, as on the computer. */}
          <input
            className={`opt other${otherOf(q) ? ' on' : ''}`}
            placeholder={q.options.length ? 'Something else' : 'Your answer'}
            value={other[q.question] ?? ''}
            onChange={(e) => {
              const v = e.target.value
              setOther((x) => ({ ...x, [q.question]: v }))
              if (!q.multiSelect && v) setPicked((p) => ({ ...p, [q.question]: [] }))
            }}
          />
        </div>
      ))}
      <button
        className="btn primary block"
        disabled={!complete}
        onClick={() => {
          const answers: AskAnswers = {}
          for (const q of it.questions) {
            const all = [...(picked[q.question] ?? []), ...(otherOf(q) ? [otherOf(q)] : [])]
            answers[q.question] = q.multiSelect ? all : (all[0] ?? '')
          }
          buzz(12)
          void useApp.getState().answer(sessionId, it.requestId, answers)
        }}
      >
        Send answer
      </button>
    </div>
  )
}

function Composer({
  disabled,
  working,
  onSend,
  onStop,
  placeholder = 'Message Celeste',
  canAttach = true,
  projectSession,
  extra
}: {
  disabled: boolean
  /** A turn is running, so a message waits its turn (or stops it and goes now). */
  working: boolean
  onSend: (text: string, attachments: string[], context: ContextRef[], mode: SendMode) => Promise<void>
  onStop?: () => void
  placeholder?: string
  /** Files can be added to what is sent (not when the box answers a question). */
  canAttach?: boolean
  /** A Develop session: its project's files can be added too. */
  projectSession?: string
  /** Shown above the box: the model. */
  extra?: ReactNode
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [context, setContext] = useState<ContextRef[]>([])
  const [picking, setPicking] = useState(false)
  const att = useAttachments()
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '42px'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])
  const ready = (!!text.trim() || att.ids.length > 0 || context.length > 0) && !att.sending
  const send = async (mode: SendMode = 'queue') => {
    if (!ready || sending) return
    buzz(mode === 'stop' ? 12 : 6)
    setSending(true)
    try {
      await onSend(text.trim(), att.ids, context, mode)
      setText('')
      setContext([])
      att.clear()
    } catch {
      // The store said why; the text stays so nothing is lost.
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="composer-wrap" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      {(extra || projectSession) && (
        <div className="modelbar">
          {extra}
          {projectSession && canAttach && (
            <button type="button" className="mchip" aria-label="Add project files" onClick={() => setPicking(true)}>
              <FolderGit2 size={14} />
              <span className="nm">Project files</span>
            </button>
          )}
        </div>
      )}
      <Chips files={att.files} context={context} onRemoveFile={att.remove} onRemoveContext={(p) => setContext((c) => c.filter((x) => x.path !== p))} />
      {canAttach && <PasteChip onPick={att.add} />}
      <div className="composer">
        {canAttach && <AttachButton onPick={att.add} />}
        <textarea ref={ta} rows={1} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onPaste={canAttach ? (e) => pastedFiles(e, att.add) : undefined} />
        {working && ready ? (
          <>
            <button className="sendbtn now" aria-label="Stop and send now" disabled={sending} onClick={() => void send('stop')}>
              <Zap size={18} />
            </button>
            <button className="sendbtn ready" aria-label="Add to queue" disabled={sending} onClick={() => void send('queue')}>
              {sending ? <LoaderCircle size={20} className="spin" /> : <ArrowUp size={20} />}
            </button>
          </>
        ) : working && onStop ? (
          <button className="sendbtn stop" aria-label="Stop" onClick={onStop}>
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button className={`sendbtn${ready ? ' ready' : ''}`} aria-label="Send" disabled={sending} onClick={() => void send()}>
            {sending ? <LoaderCircle size={20} className="spin" /> : <ArrowUp size={20} />}
          </button>
        )}
      </div>
      {working && ready && onStop && (
        <button className="btn text sm stop-under" onClick={onStop}>
          Stop
        </button>
      )}
      {picking && projectSession && <ProjectFiles sessionId={projectSession} picked={context} onChange={setContext} onClose={() => setPicking(false)} />}
    </div>
  )
}

/** The messages typed while Celeste works, above the box: tap one to send it now (stopping the answer), change it or remove it. */
function QueueBar({ sessionId, queue, working }: { sessionId: string; queue: QueueState; working: boolean }) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  if (queue.items.length === 0) return null
  const act = (a: QueueAction) => void useApp.getState().queueAction(sessionId, a)
  const save = () => {
    const was = queue.items.find((m) => m.id === editing?.id)
    if (editing && was && editing.text.trim() && editing.text !== was.text) act({ type: 'edit', queueId: editing.id, text: editing.text })
    setEditing(null)
  }
  return (
    <div className="qbar" role="list" aria-label="Messages waiting">
      {queue.paused && (
        <div className="qpaused">
          <span>Paused{working ? '' : ', so nothing is sent by itself'}.</span>
          <button type="button" onClick={() => act({ type: 'resume' })}>
            Send {queue.items.length === 1 ? 'it' : 'them'}
          </button>
          <button type="button" className="mute" onClick={() => act({ type: 'clear' })}>
            Clear
          </button>
        </div>
      )}
      {queue.items.map((m) => {
        const mine = editing?.id === m.id
        const files = m.attachments.length + (m.context?.length ?? 0)
        return (
          <div className="qrow" role="listitem" key={m.id}>
            {mine ? (
              <input autoFocus value={editing.text} aria-label="Edit the waiting message" onChange={(e) => setEditing({ id: m.id, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
            ) : (
              <span className="qt">{m.text.trim() || (files === 1 ? '1 file' : `${files} files`)}</span>
            )}
            {mine ? (
              <>
                <button aria-label="Save" onClick={save}>
                  <Check size={18} />
                </button>
                <button aria-label="Cancel" onClick={() => setEditing(null)}>
                  <X size={18} />
                </button>
              </>
            ) : (
              <>
                <button aria-label={working ? 'Stop and send this now' : 'Send now'} onClick={() => act({ type: 'now', queueId: m.id })}>
                  <Zap size={18} />
                </button>
                <button aria-label="Edit" onClick={() => setEditing({ id: m.id, text: m.text })}>
                  <Pencil size={18} />
                </button>
                <button aria-label="Remove" onClick={() => act({ type: 'remove', queueId: m.id })}>
                  <X size={18} />
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SUGGESTIONS: [LucideIcon, string][] = [
  [Calendar, 'Plan my afternoon around my meetings'],
  [Search, 'Find the notes I wrote about the release'],
  [Pencil, 'Help me write a short reply to an email']
]

/**
 * A new session: the desktop's greeting, Chat or Develop, and the box. It starts on the computer with the person's usual
 * assistant. Develop works in a project the person already used on the computer, optionally in a separate copy.
 */
export function NewChat() {
  const go = useApp((s) => s.go)
  const online = useApp((s) => s.linkState === 'connected')
  const boot = useApp((s) => s.boot)
  const link = useApp((s) => s.link)
  const computer = useApp((s) => s.pairing?.computer.name ?? 'your computer')
  const [draft, setDraft] = useState<string | null>(null)
  // Text shared from another app becomes the message, ready to send (also when New chat is already open).
  const shared = useApp((s) => s.shared)
  useEffect(() => {
    if (shared === null) return
    setDraft(shared)
    useApp.setState({ shared: null })
  }, [shared])
  const [mode, setMode] = useState<'chat' | 'develop'>('chat')
  const [projects, setProjects] = useState<PhoneProject[] | null>(null)
  const [project, setProject] = useState<string | null>(null)
  const [copy, setCopy] = useState(false)
  // The model starts as the computer would pick it (the newest session of the same kind) until the person chooses one.
  const [choice, setChoice] = useState<PhoneModelChoice | null>(null)
  const sessions = useApp((s) => s.sessions)
  const usual = (() => {
    const all = Object.values(sessions).sort((x, y) => y.updatedAt - x.updatedAt)
    const like = all.find((x) => x.mode === mode) ?? all[0]
    return like ? { model: like.model, effort: like.effort, vendor: like.vendor } : null
  })()
  const shown = choice?.model ? { model: choice.model, effort: choice.effort ?? null } : usual
  useEffect(() => {
    if (mode !== 'develop' || projects || !link) return
    void link.call<PhoneProject[]>('phone.projects').then(
      (list) => {
        setProjects(list)
        setProject((p) => p ?? list[0]?.path ?? null)
      },
      () => setProjects([])
    )
  }, [mode, projects, link])
  const how: PhoneNewSession = { ...(mode === 'develop' && project ? { mode: 'develop' as const, project, copy } : { mode: 'chat' as const }), ...(choice ?? {}) }
  const chip = shown ? (
    <ModelChip value={shown} vendor={choice ? undefined : usual?.vendor} onChange={setChoice} />
  ) : (
    <ModelChip value={{ model: 'Choose a model', effort: null }} onChange={setChoice} />
  )
  return (
    <>
      <Head title={mode === 'develop' ? 'New Develop session' : 'New chat'} sub={`on ${computer}`} onBack={() => go({ name: 'home', tab: 'chats' }, 'back')} live={online} />
      <div className="content">
        <div className="newchat">
          <Arc soft />
          <div className="overline above" {...rise(0)}>
            Your AI workbench
          </div>
          <h1 className="greet above" {...rise(1)}>
            {greeting()}, <span className="grad">{boot?.userName || 'there'}.</span>
          </h1>
          <p className="subline above" {...rise(2)}>
            {mode === 'develop' ? 'Which project are we working on?' : 'What would you like to work on?'}
          </p>
        </div>
        <div className="seg above" data-rise style={{ margin: '4px 16px 0', ['--i' as string]: 3 }}>
          <button className={mode === 'chat' ? 'on' : ''} onClick={() => setMode('chat')}>
            <MessageSquare size={15} /> Chat
          </button>
          <button className={mode === 'develop' ? 'on' : ''} onClick={() => setMode('develop')}>
            <Code2 size={15} /> Develop
          </button>
        </div>
        {mode === 'chat' ? (
          <div className="suggest above">
            {SUGGESTIONS.map(([Icon, s], i) => (
              <button key={s} {...rise(i + 4)} onClick={() => setDraft(s)}>
                <Icon size={18} />
                <span>{s}</span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="above" style={{ padding: '14px 16px' }}>
            {projects === null ? (
              <div className="empty" style={{ padding: 20 }}>
                <Shimmer>Looking at your projects</Shimmer>
              </div>
            ) : projects.length === 0 ? (
              <div className="empty" style={{ padding: 20 }}>
                No projects yet. Start a Develop session on the computer once, and its project shows here.
              </div>
            ) : (
              <>
                <div className="card">
                  {projects.map((p) => (
                    <button key={p.path} className="row tap" style={{ width: '100%', textAlign: 'left' }} onClick={() => setProject(p.path)}>
                      <span className={`ibox${project === p.path ? ' accent' : ''}`}>
                        <FolderGit2 size={18} />
                      </span>
                      <div className="grow">
                        <div className="t">{p.name}</div>
                        <div className="s mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.branch ? `${p.branch} · ` : ''}
                          {p.path}
                        </div>
                      </div>
                      {project === p.path && <Check size={18} className="pick" />}
                    </button>
                  ))}
                </div>
                <button className="card row tap" style={{ width: '100%', textAlign: 'left', marginTop: 12 }} onClick={() => setCopy(!copy)}>
                  <span className="ibox">
                    <GitBranch size={18} />
                  </span>
                  <div className="grow">
                    <div className="t">Work in a separate copy</div>
                    <div className="s">A new branch in its own folder, so your project stays as it is</div>
                  </div>
                  <span className={`switch${copy ? ' on' : ''}`} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <SeededComposer key={draft ?? ''} seed={draft ?? ''} disabled={!online || (mode === 'develop' && !project)} how={how} extra={chip} />
    </>
  )
}

function SeededComposer({ seed, disabled, how, extra }: { seed: string; disabled: boolean; how: PhoneNewSession; extra?: ReactNode }) {
  const [text, setText] = useState(seed)
  const [sending, setSending] = useState(false)
  const att = useAttachments()
  const ready = (!!text.trim() || att.ids.length > 0) && !att.sending
  return (
    <div className="composer-wrap" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      {extra && <div className="modelbar">{extra}</div>}
      <Chips files={att.files} context={[]} onRemoveFile={att.remove} onRemoveContext={() => undefined} />
      <PasteChip onPick={att.add} />
      <div className="composer">
        <AttachButton onPick={att.add} />
        <textarea rows={1} autoFocus={!!seed} placeholder="Message Celeste" value={text} onChange={(e) => setText(e.target.value)} onPaste={(e) => pastedFiles(e, att.add)} />
        <button
          className={`sendbtn${ready ? ' ready' : ''}`}
          aria-label="Send"
          disabled={sending}
          onClick={async () => {
            if (!ready) return
            buzz(6)
            setSending(true)
            try {
              await useApp.getState().newChat(text.trim(), how, att.ids)
              att.clear()
            } catch {
              setSending(false)
            }
          }}
        >
          {sending ? <LoaderCircle size={20} /> : <ArrowUp size={20} />}
        </button>
      </div>
    </div>
  )
}
