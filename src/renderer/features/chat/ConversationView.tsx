import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, FileDiff, Folder, FolderTree, GitBranch, Plug, SquareTerminal } from 'lucide-react'
import type { ContextRef, UserInput } from '@shared/agent'
import { cn } from '@/lib/cn'
import { basename } from '@/lib/format'
import { Badge, IconButton } from '@/components/ui'
import { GlowArc } from '@/glow/GlowArc'
import { lookupModel, useModels } from '@/stores/models'
import { useDrafts } from '@/stores/drafts'
import { useChanges } from '@/stores/changes'
import { useSessions } from '@/stores/sessions'
import { useUi, type RightPanel } from '@/stores/ui'
import { useVendors } from '@/stores/vendors'
import { DeviceGlyph } from '@/features/devices/parts'
import { useDevices } from '@/stores/devices'
import { Composer } from './Composer'
import { Timeline } from './Timeline'
import { DropZone, useAttachments } from './attachments'

const NO_CONTEXT: ContextRef[] = []

function PanelToggle({ panel, label, icon: Icon, badge }: { panel: Exclude<RightPanel, null>; label: string; icon: typeof Plug; badge?: number }) {
  const current = useUi((s) => s.rightPanel)
  const toggle = useUi((s) => s.toggleRight)
  return (
    <span className="relative">
      <IconButton label={label} active={current === panel} onClick={() => toggle(panel)} aria-pressed={current === panel}>
        <Icon className="h-[18px] w-[18px]" />
      </IconButton>
      {badge ? (
        <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
          {badge}
        </span>
      ) : null}
    </span>
  )
}

export function ConversationView({ sessionId }: { sessionId: string }) {
  const session = useSessions((s) => s.sessions[sessionId])
  const send = useSessions((s) => s.send)
  const stop = useSessions((s) => s.stop)
  const setPrefs = useSessions((s) => s.setPrefs)
  const respondApproval = useSessions((s) => s.respondApproval)
  const respondAsk = useSessions((s) => s.respondAsk)
  const vendors = useVendors((s) => s.vendors)
  const byId = useModels((s) => s.byId)
  const attachments = useAttachments(sessionId)
  // Unsent text belongs to the session, and is saved with it.
  const text = useDrafts((s) => s.drafts[sessionId]?.text ?? '')
  const context = useDrafts((s) => s.drafts[sessionId]?.context ?? NO_CONTEXT)
  const pushToast = useUi((s) => s.pushToast)
  const setText = (t: string) => useDrafts.getState().setText(sessionId, t)
  const scroller = useRef<HTMLDivElement>(null)
  const attachedIds = useDevices((s) => s.attached[sessionId])
  const allDevices = useDevices((s) => s.devices)
  const loadAttached = useDevices((s) => s.loadAttached)
  useEffect(() => {
    void loadAttached(sessionId)
  }, [sessionId, loadAttached])
  const [following, setFollowing] = useState(true)

  // What differs now from before the first message. It is looked at when the session opens and whenever an answer ends, so the
  // badge, the Changes panel and the file tree all show the same net result.
  const net = useChanges((s) => s.net[sessionId])
  const refreshNet = useChanges((s) => s.refresh)
  const saved = session?.mode === 'develop' && (session.items.some((i) => i.kind === 'user' && i.checkpoint) ?? false)
  const status = session?.status
  useEffect(() => {
    if (saved && status === 'idle') void refreshNet(sessionId)
  }, [saved, status, sessionId, refreshNet])
  const changedFiles = useMemo(() => {
    // A session from before folders were saved has no net result: it counts what the agent reported.
    if (saved) return net ? net.files.length + net.more : 0
    const paths = new Set<string>()
    for (const it of session?.items ?? []) if (it.kind === 'tool') it.diff?.forEach((d) => paths.add(d.path))
    return paths.size
  }, [saved, net, session?.items])

  // Start at the end when a session opens.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }, [sessionId])

  // Follow new content, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [session?.items, session?.activity, following])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }, [])

  if (!session) return null
  const model = lookupModel(byId, session.model, session.vendor)
  const busy = session.status !== 'idle'
  const lastUser = [...session.items].reverse().find((i) => i.kind === 'user')
  const develop = session.mode === 'develop'
  const onChatGptPlan = model?.vendor === 'openai' && vendors.openai.status === 'connected' && vendors.openai.method === 'browser'

  const retry = () => {
    if (lastUser?.kind === 'user') send(session.mode, { text: lastUser.text, attachments: lastUser.attachments, ...(lastUser.context ? { context: lastUser.context } : {}) })
  }

  return (
    <DropZone
      onFiles={(f) => void attachments.add(f)}
      onProject={
        develop
          ? (refs) => {
              const left = useDrafts.getState().addContext(sessionId, refs)
              if (left > 0) pushToast({ text: 'A message can carry up to 20 files and folders.' })
            }
          : undefined
      }
      className="h-full"
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <GlowArc className="opacity-35" />

        <header className="relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-edge/70 px-5">
          <h1 className="min-w-0 truncate text-[15px] font-medium text-ink">{session.title}</h1>
          {model && <Badge className="shrink-0">{model.label}</Badge>}
          {session.worktree && (
            <span className="shrink-0" title={`A separate copy of the project, made for this session: ${session.cwd}`}>
              <Badge tone="accent">Separate copy</Badge>
            </span>
          )}
          {attachedIds?.map((id) => {
            const d = allDevices.find((x) => x.id === id)
            return d ? (
              <Badge key={id} tone={d.accessLevel === 'full' ? 'warning' : 'neutral'} className="shrink-0">
                <DeviceGlyph kind={d.kind} className="h-3 w-3" /> {d.name}
                {d.accessLevel === 'full' && ' · full access'}
              </Badge>
            ) : null
          })}
          {develop && session.cwd && (
            <span className="hidden min-w-0 items-center gap-3 text-[13px] text-ink-muted md:flex" title={session.cwd}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{basename(session.cwd)}</span>
              </span>
              {session.branch && (
                <span className="flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5" />
                  {session.branch}
                </span>
              )}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {develop && (
              <>
                <PanelToggle panel="files" label="Files" icon={FolderTree} />
                <PanelToggle panel="changes" label="Changes" icon={FileDiff} badge={changedFiles} />
                <PanelToggle panel="terminal" label="Terminal" icon={SquareTerminal} />
              </>
            )}
            <PanelToggle panel="tools" label="Tools & Integrations" icon={Plug} />
          </div>
        </header>

        <div ref={scroller} onScroll={onScroll} className="relative z-10 min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-6 py-6">
            <Timeline
              session={session}
              onApproval={(requestId, allow, always) => respondApproval(sessionId, requestId, allow, always)}
              onAsk={(requestId, answers) => respondAsk(sessionId, requestId, answers)}
              onRetry={retry}
            />
          </div>
        </div>

        {!following && (
          <button
            type="button"
            onClick={() => {
              const el = scroller.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            }}
            className="absolute bottom-36 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge-strong bg-raised-2 px-3 py-1.5 text-xs text-ink shadow-pop hover:bg-raised"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </button>
        )}

        <div className="relative z-10 shrink-0 px-6 pb-4">
          <div className="mx-auto w-full max-w-[820px]">
            <Composer
              variant="dock"
              mode={session.mode}
              text={text}
              onText={setText}
              prefs={{ model: session.model, effort: session.effort, approval: session.approval }}
              onPrefs={(p) => setPrefs(sessionId, p)}
              attachments={attachments}
              context={context}
              onRemoveContext={(path) => useDrafts.getState().removeContext(sessionId, path)}
              busy={busy}
              onSend={(input: UserInput) => {
                void send(session.mode, input)
                useDrafts.getState().clear(sessionId)
              }}
              onStop={() => stop(sessionId)}
              placeholder={session.status === 'waiting' ? 'Answer above to continue…' : 'Message Celeste...'}
            />
            <div className={cn('mt-2 flex h-4 items-center justify-center gap-2 text-[11px] text-ink-faint')}>
              {onChatGptPlan ? (
                <>
                  Using ChatGPT plan ·
                  <a href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
                    Manage usage
                  </a>
                </>
              ) : (
                'Shift + Enter for a new line'
              )}
            </div>
          </div>
        </div>
      </div>
    </DropZone>
  )
}
