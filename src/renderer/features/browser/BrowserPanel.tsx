import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, Ellipsis, ExternalLink, FileText, Folder, FolderOpen, Globe, LoaderCircle, Plus, RotateCw, X } from 'lucide-react'
import { displayUrl, type BrowserTab } from '@shared/browser'
import { cn } from '@/lib/cn'
import { Button, IconButton } from '@/components/ui'
import { Menu } from '@/components/menu'
import { browserCall, useBrowser } from '@/stores/browser'
import { BROWSER_WIDTH, useUi } from '@/stores/ui'
import { useBrowserArea } from './useBrowserArea'

const NO_TABS: BrowserTab[] = []

function TabStrip({ tabs, selected, onNew }: { tabs: BrowserTab[]; selected: string | undefined; onNew: () => void }) {
  return (
    <div aria-label="Browser tabs" role="group" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === selected
        const label = t.file?.name ?? (t.title || displayUrl(t.url) || 'New tab')
        return (
          <div
            key={t.id}
            className={cn(
              'group flex h-8 max-w-[190px] min-w-[96px] shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2.5 text-[12.5px] transition-colors',
              active ? 'bg-hover text-ink' : 'text-ink-muted hover:bg-hover/60 hover:text-ink'
            )}
          >
            <button
              type="button"
              data-testid="browser-tab"
              aria-current={active ? 'true' : undefined}
              title={label}
              onClick={() => void browserCall('selectTab', { id: t.id })}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {t.loading ? (
                <LoaderCircle aria-label="Loading" className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : t.kind === 'file' ? (
                <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-70" />
              ) : (
                <Globe aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-70" />
              )}
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => void browserCall('closeTab', { id: t.id })}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      <IconButton label="New tab (Ctrl+T)" size="sm" onClick={onNew}>
        <Plus className="h-4 w-4" />
      </IconButton>
    </div>
  )
}

function PageMenu({ chatId, tab }: { chatId: string; tab: BrowserTab | undefined }) {
  const prefs = useBrowser((s) => s.prefs)
  const pushToast = useUi((s) => s.pushToast)
  const openSettings = useUi((s) => s.openSettings)
  // A tab that shows a file: a viewer tab, or a page on a file address.
  const isFileTab = !!tab && (tab.kind === 'file' || /^file:/i.test(tab.url))
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton label="More">
          <Ellipsis className="h-[18px] w-[18px]" />
        </IconButton>
      </Menu.Trigger>
      <Menu.Content align="end" className="min-w-[250px]">
        <Menu.Item onSelect={() => void browserCall('pickFile', { chatId }).catch((e: Error) => pushToast({ text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))}>
          <FolderOpen className="h-3.5 w-3.5" /> Open a file…
        </Menu.Item>
        {isFileTab && (
          <>
            <Menu.Item onSelect={() => tab && void browserCall('fileAction', { id: tab.id, action: 'open' }).catch((e: Error) => pushToast({ text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))}>
              <ExternalLink className="h-3.5 w-3.5" /> Open in your own program
            </Menu.Item>
            <Menu.Item onSelect={() => tab && void browserCall('fileAction', { id: tab.id, action: 'reveal' }).catch(() => undefined)}>
              <Folder className="h-3.5 w-3.5" /> Show in its folder
            </Menu.Item>
          </>
        )}
        <Menu.Separator />
        <Menu.Item disabled={!tab?.url || tab?.kind === 'file'} onSelect={() => tab && void browserCall('openExternal', { url: tab.url })}>
          <ExternalLink className="h-3.5 w-3.5" /> Open in my browser
        </Menu.Item>
        <Menu.Item disabled={!tab?.url} onSelect={() => tab && void browserCall('action', { id: tab.id, action: 'devtools' })}>
          Developer tools
        </Menu.Item>
        <Menu.Separator />
        <Menu.Label>Open links from chats in</Menu.Label>
        <Menu.RadioGroup value={prefs.linksIn} onValueChange={(v) => void browserCall('setPrefs', { linksIn: v as typeof prefs.linksIn })}>
          <Menu.RadioItem value="ask">Ask each time</Menu.RadioItem>
          <Menu.RadioItem value="celeste">Celeste’s browser</Menu.RadioItem>
          <Menu.RadioItem value="system">My browser</Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Separator />
        <Menu.RadioGroup value={prefs.keepCookies ? 'keep' : 'clear'} onValueChange={(v) => void browserCall('setPrefs', { keepCookies: v === 'keep' })}>
          <Menu.RadioItem value="keep" description="Stay signed in to sites after you quit Celeste.">
            Keep cookies
          </Menu.RadioItem>
          <Menu.RadioItem value="clear" description="Start signed out each time.">
            Forget everything when I quit
          </Menu.RadioItem>
        </Menu.RadioGroup>
        <Menu.Separator />
        <Menu.Item onSelect={() => openSettings('browser')}>Browser settings…</Menu.Item>
        <Menu.Item
          onSelect={() =>
            void browserCall('clearData', undefined).then(() => pushToast({ text: 'Cleared the browser’s cookies, sign-ins and saved data.' }), () => pushToast({ text: 'Could not clear the browser’s data.' }))
          }
        >
          Clear browsing data
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  )
}

function Toolbar({ chatId, tab, addressRef }: { chatId: string; tab: BrowserTab | undefined; addressRef: React.RefObject<HTMLInputElement | null> }) {
  // A viewer tab shows the file's path, which is not typed over.
  const shown = tab ? (tab.file?.path ?? tab.url) : ''
  const fileTab = tab?.kind === 'file'
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  // While the person is not typing, the bar shows where the page is.
  useEffect(() => {
    if (!editing) setText(shown)
  }, [shown, tab?.id, editing])
  const go = () => {
    const input = text.trim()
    if (!input || fileTab) return
    if (tab) void browserCall('navigate', { id: tab.id, input })
    else void browserCall('newTab', { chatId, url: input })
    addressRef.current?.blur()
    setEditing(false)
  }
  const act = (action: 'back' | 'forward' | 'reload' | 'stop') => tab && void browserCall('action', { id: tab.id, action })
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-edge/70 px-2">
      <IconButton label="Back (Alt+Left)" size="sm" disabled={!tab?.canGoBack || fileTab} onClick={() => act('back')}>
        <ArrowLeft className="h-4 w-4" />
      </IconButton>
      <IconButton label="Forward (Alt+Right)" size="sm" disabled={!tab?.canGoForward || fileTab} onClick={() => act('forward')}>
        <ArrowRight className="h-4 w-4" />
      </IconButton>
      {tab?.loading ? (
        <IconButton label="Stop" size="sm" onClick={() => act('stop')}>
          <X className="h-4 w-4" />
        </IconButton>
      ) : (
        <IconButton label="Reload (Ctrl+R)" size="sm" disabled={!tab?.url} onClick={() => act('reload')}>
          <RotateCw className="h-4 w-4" />
        </IconButton>
      )}
      <input
        ref={addressRef}
        value={text}
        spellCheck={false}
        aria-label="Address"
        readOnly={fileTab}
        placeholder="Search or type an address"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.select()
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go()
          if (e.key === 'Escape') {
            setText(shown)
            e.currentTarget.blur()
          }
        }}
        className="mx-1 h-8 min-w-0 flex-1 rounded-full border border-edge bg-field px-3.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
      />
      <PageMenu chatId={chatId} tab={tab} />
    </div>
  )
}

/** A page asked to use something of the computer. */
function Prompts() {
  const prompts = useBrowser((s) => s.prompts)
  return (
    <>
      {prompts.map((p) => (
        <div key={p.id} role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/70 bg-warning/10 px-3 py-2 text-[13px] text-ink">
          <span className="min-w-0 flex-1">
            <b className="font-medium">{p.origin.replace(/^https?:\/\//, '')}</b> wants to {p.what}.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void browserCall('respond', { id: p.id, allow: false })}>
            Block
          </Button>
          <Button size="sm" variant="primary" onClick={() => void browserCall('respond', { id: p.id, allow: true })}>
            Allow
          </Button>
        </div>
      ))}
    </>
  )
}

function Downloads() {
  const downloads = useBrowser((s) => s.downloads)
  if (!downloads.length) return null
  return (
    <div className="shrink-0 border-t border-edge/70">
      {downloads.slice(-3).map((d) => (
        <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-ink-muted">
          <Download className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-ink" title={d.name}>
            {d.name}
          </span>
          <span className="shrink-0">{d.state === 'progress' ? (d.total > 0 ? `${Math.round((d.received / d.total) * 100)}%` : 'Downloading…') : d.state === 'done' ? 'Saved' : 'Failed'}</span>
          {d.state === 'done' && (
            <IconButton label="Show in folder" size="sm" onClick={() => void browserCall('showDownload', { id: d.id })}>
              <Folder className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {d.state !== 'progress' && (
            <IconButton label="Dismiss" size="sm" onClick={() => void browserCall('dismissDownload', { id: d.id })}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  )
}

/** The edge of the panel, dragged to make it wider or narrower. */
function ResizeEdge({ onDragging }: { onDragging: (on: boolean) => void }) {
  const setWidth = useUi((s) => s.setBrowserWidth)
  const width = useUi((s) => s.browserWidth)
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = useUi.getState().browserWidth
    const max = Math.min(BROWSER_WIDTH.max, window.innerWidth * 0.7)
    onDragging(true)
    const move = (ev: PointerEvent) => setWidth(Math.min(max, startWidth + (startX - ev.clientX)), false)
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      setWidth(useUi.getState().browserWidth)
      onDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the browser"
      aria-valuenow={width}
      aria-valuemin={BROWSER_WIDTH.min}
      aria-valuemax={BROWSER_WIDTH.max}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(e) => {
        const w = useUi.getState().browserWidth
        if (e.key === 'ArrowLeft') setWidth(w + 40)
        if (e.key === 'ArrowRight') setWidth(w - 40)
      }}
      className="absolute top-0 -left-2.5 z-10 h-full w-3 cursor-col-resize rounded-full hover:bg-accent/30 focus-visible:bg-accent/40"
    />
  )
}

export function BrowserPanel({ chatId }: { chatId: string }) {
  const all = useBrowser((s) => s.tabs)
  const selected = useBrowser((s) => s.selected[chatId])
  const tabs = all.filter((t) => t.chatId === chatId)
  const tab = tabs.find((t) => t.id === selected)
  const addressRef = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLElement>(null)
  const [dragging, setDragging] = useState(false)
  const { shot } = useBrowserArea(body, chatId, dragging)

  // A browser or a tab that has nothing to show gets the address bar ready for typing, but only when the person asked for it: opened the
  // panel, or made a tab. When the assistant opens the panel, or its tab is a moment blank before the page loads, the keyboard stays put.
  const wantFocus = useRef(useUi.getState().browserFocus)
  const newTab = useCallback(() => {
    wantFocus.current = true
    void browserCall('newTab', { chatId })
  }, [chatId])
  const emptyId = tab && !tab.url ? tab.id : undefined
  useLayoutEffect(() => {
    if (!wantFocus.current || !(emptyId || tabs.length === 0)) return
    addressRef.current?.focus()
    wantFocus.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyId])

  // The browser's own keys. A key typed in the page comes back as a made-up event; a real one only counts with the focus in the panel,
  // so Ctrl+R in the message box still means what it means there.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const here = !e.isTrusted || !!root.current?.contains(document.activeElement)
      if (!here) return
      const main = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const current = tab?.id
      if (main && !e.shiftKey && key === 'l') {
        e.preventDefault()
        addressRef.current?.focus()
      } else if (main && !e.shiftKey && key === 't') {
        e.preventDefault()
        newTab()
      } else if (main && !e.shiftKey && key === 'w' && current) {
        e.preventDefault()
        void browserCall('closeTab', { id: current })
      } else if (current && ((main && !e.shiftKey && key === 'r') || key === 'f5')) {
        e.preventDefault()
        void browserCall('action', { id: current, action: 'reload' })
      } else if (current && e.altKey && key === 'arrowleft') {
        e.preventDefault()
        void browserCall('action', { id: current, action: 'back' })
      } else if (current && e.altKey && key === 'arrowright') {
        e.preventDefault()
        void browserCall('action', { id: current, action: 'forward' })
      } else if (current && key === 'f12') {
        e.preventDefault()
        void browserCall('action', { id: current, action: 'devtools' })
      }
    },
    [tab?.id, newTab]
  )
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  const close = useUi((s) => s.setRight)
  return (
    <section ref={root} aria-label="Browser" className="relative flex h-full min-h-0 flex-col rounded-2xl border border-edge bg-panel">
      <ResizeEdge onDragging={setDragging} />
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-edge/70 pr-1 pl-2">
        <TabStrip tabs={tabs.length ? tabs : NO_TABS} selected={selected} onNew={newTab} />
        <IconButton label="Close browser" size="sm" onClick={() => close(null)}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <Toolbar chatId={chatId} tab={tab} addressRef={addressRef} />
      <Prompts />
      <div ref={body} data-testid="browser-page" className="relative min-h-0 flex-1 overflow-hidden rounded-b-2xl bg-white">
        {shot && <img src={shot} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-top" />}
        {!shot && tab?.error && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-panel p-8 text-center">
            <p className="max-w-[340px] text-[14px] text-ink">{tab.error}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => void browserCall('action', { id: tab.id, action: 'reload' })}>
                Try again
              </Button>
              {tab.canGoBack && (
                <Button size="sm" onClick={() => void browserCall('action', { id: tab.id, action: 'back' })}>
                  Go back
                </Button>
              )}
            </div>
          </div>
        )}
        {!shot && !tab?.error && !tab?.url && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-panel p-8 text-center">
            <Globe aria-hidden className="h-8 w-8 text-ink-faint" />
            <p className="text-[14px] text-ink-muted">Open a site, or ask the assistant to.</p>
          </div>
        )}
      </div>
      <Downloads />
    </section>
  )
}
