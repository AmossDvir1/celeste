import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Calendar,
  Check,
  Code2,
  FileText,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Globe,
  LoaderCircle,
  MonitorSmartphone,
  Pencil,
  Plug,
  Search,
  Square,
  Terminal,
  Workflow,
  X,
  type LucideIcon
} from 'lucide-react'
import type { AskAnswers, Question, ToolKind } from '@shared/agent'
import type { PhoneModelChoice, PhoneNewSession, PhoneProject } from '@shared/phone'
import type { TimelineItem } from '@/stores/types'
import { useApp } from '../store'
import { Arc, Shimmer, buzz, greeting, rise } from '../ui'
import { ModelChip } from '../ModelPicker'

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
  // While Celeste waits on a card, the box answers it (a question with one part) or says to use the card: a message sent
  // now would only queue behind the question, as the desktop never allows.
  const pendingAsk = [...s.items].reverse().find((it): it is Extract<TimelineItem, { kind: 'ask' }> => it.kind === 'ask' && it.status === 'pending')
  const pendingApproval = s.items.some((it) => it.kind === 'approval' && it.status === 'pending')
  const answerable = pendingAsk && pendingAsk.questions.length === 1 ? pendingAsk : null
  const last = s.items[s.items.length - 1]
  // What Celeste is doing, shown right under the newest message, as on the computer.
  const showActivity = s.activity && !(last?.kind === 'thinking' && last.endedAt === undefined) && !(s.activity.working === false && (pendingAsk || pendingApproval))

  return (
    <>
      <Head title={s.title || 'New chat'} sub={`${where} · on ${computer}`} onBack={() => go({ name: 'home', tab: 'chats' }, 'back')} live={online} />
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
            {s.items.map((it) => (
              <Item key={it.id} it={it} sessionId={id} />
            ))}
            {s.items.length === 0 && <div className="notice">Nothing here yet.</div>}
            {showActivity && s.activity && (
              <div className="thinking fresh" key={s.activity.label}>
                {s.activity.working ? <Shimmer>{s.activity.label}</Shimmer> : s.activity.label}
              </div>
            )}
          </div>
        )}
      </div>
      <Composer
        disabled={!online}
        working={working && !answerable}
        placeholder={answerable ? 'Type your answer' : pendingApproval ? 'Approve or deny above first' : 'Message Celeste'}
        locked={!answerable && (pendingApproval || !!pendingAsk)}
        extra={<ModelChip value={{ model: s.model, effort: s.effort }} vendor={s.vendor} only={s.vendor} onChange={(c) => void useApp.getState().setModel(id, c)} />}
        onStop={() => {
          buzz(10)
          void useApp.getState().stop(id)
        }}
        onSend={(text) => {
          if (answerable) {
            const q = answerable.questions[0] as Question
            return useApp.getState().answer(id, answerable.requestId, { [q.question]: q.multiSelect ? [text] : text })
          }
          return useApp.getState().send(id, text)
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

const Item = memo(function Item({ it, sessionId }: { it: TimelineItem; sessionId: string }) {
  const [open, setOpen] = useState(false)
  switch (it.kind) {
    case 'user':
      return (
        <div className="m-user">
          {it.text}
          {it.attachments.length > 0 && <div className="small faint">{it.attachments.length === 1 ? '1 attachment' : `${it.attachments.length} attachments`}</div>}
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
      return it.endedAt === undefined ? (
        <div className="thinking">
          <Shimmer>Thinking</Shimmer>
        </div>
      ) : (
        <div className="thinking">Thought for {Math.max(1, Math.round((it.endedAt - it.startedAt) / 1000))} s</div>
      )
    case 'tool': {
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
          {open && it.output && <pre className="tool-out">{it.output.slice(-6000)}</pre>}
        </div>
      )
    }
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
      return (
        <div className="m-tool">
          <MonitorSmartphone size={17} />
          <div className="grow">
            <div className="l">
              {it.where === 'phone' ? 'Used this phone' : 'Used the computer'}: {it.reason}
            </div>
            <div className="d">{it.ended ? `${it.ended.actions} actions · ${it.ended.why}` : `${it.actions.length} actions so far`}</div>
          </div>
        </div>
      )
    case 'reverted':
      return <div className="notice">The folder was put back ({it.restored} restored, {it.removed} removed).</div>
  }
})

function Approval({ it, sessionId }: { it: Extract<TimelineItem, { kind: 'approval' }>; sessionId: string }) {
  const Icon = TOOL_ICON[it.tool] ?? Workflow
  const pending = it.status === 'pending'
  return (
    <div className={`approval ${pending ? 'pending' : 'done'}`}>
      <div className="hd">
        <Icon size={18} /> {it.title}
        {pending && <span className="faint">Needs you</span>}
      </div>
      {it.detail && <pre className="mono">{it.detail}</pre>}
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
              void useApp.getState().approve(sessionId, it.requestId, true)
            }}
          >
            Approve
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
  locked = false,
  extra
}: {
  disabled: boolean
  working: boolean
  onSend: (text: string) => Promise<void>
  onStop?: () => void
  placeholder?: string
  /** Celeste waits on a card that the box cannot answer: nothing can be typed until it is answered. */
  locked?: boolean
  /** Shown above the box: the model. */
  extra?: ReactNode
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '42px'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])
  const send = async () => {
    const t = text.trim()
    if (!t || sending) return
    buzz(6)
    setSending(true)
    try {
      await onSend(t)
      setText('')
    } catch {
      // The store said why; the text stays so nothing is lost.
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="composer-wrap" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      {extra && <div className="modelbar">{extra}</div>}
      <div className="composer">
        <textarea ref={ta} rows={1} placeholder={placeholder} value={text} disabled={locked} onChange={(e) => setText(e.target.value)} />
        {working && onStop ? (
          <button className="sendbtn stop" aria-label="Stop" onClick={onStop}>
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button className={`sendbtn${text.trim() ? ' ready' : ''}`} aria-label="Send" disabled={sending} onClick={() => void send()}>
            {sending ? <LoaderCircle size={20} className="spin" /> : <ArrowUp size={20} />}
          </button>
        )}
      </div>
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
  return (
    <div className="composer-wrap" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      {extra && <div className="modelbar">{extra}</div>}
      <div className="composer">
        <textarea rows={1} autoFocus={!!seed} placeholder="Message Celeste" value={text} onChange={(e) => setText(e.target.value)} />
        <button
          className={`sendbtn${text.trim() ? ' ready' : ''}`}
          aria-label="Send"
          disabled={sending}
          onClick={async () => {
            const t = text.trim()
            if (!t) return
            buzz(6)
            setSending(true)
            try {
              await useApp.getState().newChat(t, how)
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
