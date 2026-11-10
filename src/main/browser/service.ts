import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, Menu, session, shell, WebContentsView, type ContextMenuParams, type Session, type WebContents } from 'electron'
import { z } from 'zod'
import { CdpBridge, type BridgeTab } from './bridge'
import {
  afterClosing,
  cleanUserAgent,
  DEFAULT_BROWSER_PREFS,
  isOpenable,
  isWindowKey,
  originOf,
  resolveAddress,
  type BrowserCalls,
  type BrowserDownload,
  type BrowserOp,
  type BrowserPrefs,
  type BrowserPrompt,
  type BrowserRect,
  type BrowserState,
  type BrowserTab
} from '@shared/browser'

/*
 * Celeste's browser pane, the part that owns the pages (docs/BROWSER_PLAN.md, section 4). Each tab is a WebContentsView laid over the
 * window where the pane's placeholder is; it is a real Chromium page with no connection to Celeste, in a profile of its own. The window
 * says which chat's tabs are on screen and where, and is told the state of every tab as it changes.
 */

const PARTITION = 'persist:celeste-browser'
/** A tab that is hidden and untouched for this long is closed and keeps only its address (it loads again when shown). */
const IDLE_DISCARD_MS = 30 * 60_000
/** Things a page may do without asking. */
const SAFE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'pointerLock'])
/** Things a page may ask for, and how the bar says it. Anything else is refused. */
const ASKED: Record<string, string> = {
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices',
  'display-capture': 'share your screen'
}

interface Tab {
  id: string
  chatId: string
  /** The page. Null until something is opened, and again after the tab was put away. */
  view: WebContentsView | null
  url: string
  title: string
  loading: boolean
  error: string | null
  lastUsed: number
  /** The id the page's own DevTools gives it, once the bridge has attached. A new page has a new one. */
  targetId: string | null
}

interface PendingPrompt {
  prompt: BrowserPrompt
  key: string
  tabId: string
  callbacks: ((allow: boolean) => void)[]
}

interface DownloadRecord extends BrowserDownload {
  path: string
}

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) })
const id = z.string().min(1).max(60)
const text = z.string().max(4000)
const schemas = {
  state: z.undefined(),
  show: z.object({ chatId: id.nullable(), rect: rect.nullable() }),
  cover: z.object({ on: z.boolean() }),
  newTab: z.object({ chatId: id, url: text.optional() }),
  closeTab: z.object({ id }),
  selectTab: z.object({ id }),
  navigate: z.object({ id, input: text }),
  action: z.object({ id, action: z.enum(['back', 'forward', 'reload', 'stop', 'devtools']) }),
  open: z.object({ chatId: id, url: text }),
  respond: z.object({ id, allow: z.boolean() }),
  clearData: z.undefined(),
  setPrefs: z.object({ keepCookies: z.boolean().optional(), linksIn: z.enum(['ask', 'celeste', 'system']).optional(), search: z.enum(['google', 'duckduckgo', 'bing']).optional() }),
  openExternal: z.object({ url: text }),
  showDownload: z.object({ id }),
  dismissDownload: z.object({ id }),
  closeChat: z.object({ chatId: id }),
  focus: z.undefined(),
  external: z.object({ on: z.boolean() })
} satisfies Record<BrowserOp, z.ZodTypeAny>

const coreSchemas = {
  tabs: z.object({ chatId: id }),
  newTab: z.object({ chatId: id, url: text.optional() }),
  selectTab: z.object({ id }),
  closeTab: z.object({ id }),
  reveal: z.object({ chatId: id })
}

/** A short reason in plain words for a page that would not load. */
export function describeFailure(code: number, description: string, url: string): string {
  const site = originOf(url) || url
  if (code <= -200 && code > -300) return `${site} has a certificate that cannot be trusted, so Celeste did not open it.`
  if (code === -105 || code === -137) return `Could not find ${site}. Check the address.`
  if (code === -102 || code === -106 || code === -109) return `Could not connect to ${site}.`
  if (code === -118 || code === -7) return `${site} took too long to answer.`
  return `Could not open ${site} (${description.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase()}).`
}

export class BrowserService {
  private host: BrowserWindow | null = null
  private ses: Session | null = null
  private readonly tabs = new Map<string, Tab>()
  private readonly selected = new Map<string, string>()
  private chat: string | null = null
  private area: BrowserRect | null = null
  private covered = false
  private next = 0
  private prefs: BrowserPrefs
  private readonly prompts: PendingPrompt[] = []
  private readonly decided = new Map<string, boolean>()
  private readonly downloads: DownloadRecord[] = []
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private sweeper: ReturnType<typeof setInterval> | null = null
  /** The DevTools endpoint Playwright connects to: Core's tools, and other programs when the person allows them. */
  private bridge: CdpBridge | null = null

  constructor(private readonly prefsFile: string) {
    this.prefs = this.readPrefs()
  }

  private readPrefs(): BrowserPrefs {
    try {
      if (existsSync(this.prefsFile)) {
        const saved = JSON.parse(readFileSync(this.prefsFile, 'utf8')) as Partial<BrowserPrefs>
        const parsed = schemas.setPrefs.safeParse(saved)
        if (parsed.success) return { ...DEFAULT_BROWSER_PREFS, ...stripUndefined(parsed.data) }
      }
    } catch {
      // A damaged file is the same as none: the defaults.
    }
    return { ...DEFAULT_BROWSER_PREFS }
  }

  /** Called once the app is ready. Sets up the profile, and clears it when cookies are not kept. */
  async init(): Promise<void> {
    const ses = session.fromPartition(PARTITION)
    this.ses = ses
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
    ses.setPermissionRequestHandler((wc, permission, callback, details) => this.onPermission(wc, permission, callback, details as { requestingUrl?: string; mediaTypes?: string[] }))
    ses.setPermissionCheckHandler((_wc, permission, origin) => SAFE_PERMISSIONS.has(permission) || this.decided.get(`${origin}|${permission}`) === true)
    ses.on('will-download', (_event, item, wc) => this.onDownload(item, wc))
    if (!this.prefs.keepCookies) await ses.clearStorageData().catch(() => undefined)
    const bridge = new CdpBridge({
      tabs: () => [...this.tabs.values()].filter((t) => t.view) as BridgeTab[],
      createTab: async (url) => {
        // A page opened by a program belongs to the chat on screen, or to none.
        const tab = this.createTab(this.chat ?? 'external', url)
        this.ensureView(tab)
        return tab as BridgeTab
      },
      closeTab: async (tab) => this.closeTab(tab.id),
      userAgent: () => ses.getUserAgent()
    })
    await bridge.listen()
    bridge.onChange = () => this.changed()
    this.bridge = bridge
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000)
    this.sweeper.unref()
  }

  /** Called when Celeste quits. */
  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.bridge?.close()
    if (this.ses && !this.prefs.keepCookies) {
      await Promise.race([this.ses.clearStorageData().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))])
    }
  }

  /** The window the pane is shown in. */
  bind(win: BrowserWindow): void {
    if (this.host === win) return
    this.host = win
    win.once('closed', () => {
      if (this.host !== win) return
      for (const tab of this.tabs.values()) this.dropView(tab)
      this.tabs.clear()
      this.selected.clear()
      this.host = null
    })
  }

  /** Whether a window belongs to the browser (a sign-in popup), so the rest of Celeste leaves it alone. */
  owns(wc: WebContents): boolean {
    return !!this.tabOf(wc)
  }

  // ---- Core's calls ---------------------------------------------------------------------------------------------------------------

  /** Lets other programs (Playwright MCP, a script) connect to the browser, or turns them out. Returns where they connect, or null. */
  setExternal(on: boolean): string | null {
    this.bridge?.setExternal(on)
    this.changed()
    return this.bridge?.externalEndpoint() ?? null
  }

  /** What Core's browser tools ask of the pages. It does the acting through Playwright; this is only what it cannot see for itself. */
  async core(method: string, raw: unknown): Promise<unknown> {
    switch (method) {
      case 'endpoint':
        return this.bridge?.internalEndpoint() ?? null
      case 'tabs': {
        const { chatId } = coreSchemas.tabs.parse(raw)
        const mine = [...this.tabs.values()].filter((t) => t.chatId === chatId)
        // Playwright finds a tab's page by the id its own DevTools gives it, so every page is attached first.
        for (const tab of mine) if (tab.view) await this.bridge?.ensureAttached(tab as BridgeTab).catch(() => undefined)
        const shown = this.selected.get(chatId)
        return mine.map((t) => ({ id: t.id, targetId: t.targetId, url: t.url, title: t.title, selected: t.id === shown, loading: t.loading, error: t.error }))
      }
      case 'newTab': {
        const { chatId, url } = coreSchemas.newTab.parse(raw)
        if (url !== undefined && !isOpenable(url)) throw new Error('That is not an address the browser opens (use http, https or file).')
        // With no address the tab starts blank, so a program can attach to it before anything has loaded.
        const tab = this.createTab(chatId, url)
        this.ensureView(tab)
        return tab.id
      }
      case 'selectTab':
        await this.run('selectTab', coreSchemas.selectTab.parse(raw))
        return undefined
      case 'closeTab':
        this.closeTab(coreSchemas.closeTab.parse(raw).id)
        return undefined
      case 'reveal': {
        const { chatId } = coreSchemas.reveal.parse(raw)
        if (this.host && !this.host.isDestroyed()) this.host.webContents.send('celeste:browser-reveal', { chatId })
        return undefined
      }
      default:
        throw new Error('Unknown browser call')
    }
  }

  // ---- the window's calls -------------------------------------------------------------------------------------------------------

  async handle<O extends BrowserOp>(op: O, raw: unknown): Promise<BrowserCalls[O]['result']> {
    const schema = schemas[op]
    if (!schema) throw new Error('Unknown operation')
    const arg = (schema.parse(raw) ?? {}) as Record<string, unknown>
    return (await this.run(op, arg)) as BrowserCalls[O]['result']
  }

  private async run(op: BrowserOp, arg: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'state':
        return this.snapshot()
      case 'show':
        this.chat = (arg['chatId'] as string | null) ?? null
        this.area = (arg['rect'] as BrowserRect | null) ?? null
        this.touch(this.current())
        this.layout()
        return undefined
      case 'cover':
        return this.cover(!!arg['on'])
      case 'newTab': {
        // What the address bar held is typed text; one that means nothing leaves the tab empty.
        const url = arg['url'] ? (resolveAddress(String(arg['url']), this.prefs.search) ?? undefined) : undefined
        return this.createTab(String(arg['chatId']), url).id
      }
      case 'closeTab':
        this.closeTab(String(arg['id']))
        return undefined
      case 'selectTab': {
        const tab = this.tabs.get(String(arg['id']))
        if (!tab) return undefined
        this.selected.set(tab.chatId, tab.id)
        this.touch(tab)
        if (!tab.view && tab.url) this.ensureView(tab)
        this.changed(true)
        return undefined
      }
      case 'navigate': {
        const tab = this.tabs.get(String(arg['id']))
        const url = tab ? resolveAddress(String(arg['input']), this.prefs.search) : null
        if (tab && url) this.load(tab, url)
        return undefined
      }
      case 'action':
        this.act(String(arg['id']), String(arg['action']))
        return undefined
      case 'open':
        return this.open(String(arg['chatId']), String(arg['url']))
      case 'respond':
        this.respond(String(arg['id']), !!arg['allow'])
        return undefined
      case 'clearData':
        await this.ses?.clearStorageData()
        await this.ses?.clearCache()
        await this.ses?.clearAuthCache()
        this.decided.clear()
        return undefined
      case 'setPrefs':
        this.prefs = { ...this.prefs, ...stripUndefined(arg as Partial<BrowserPrefs>) }
        try {
          writeFileSync(this.prefsFile, JSON.stringify(this.prefs))
        } catch {
          // The choice holds for this run even if it could not be saved.
        }
        this.changed()
        return undefined
      case 'openExternal': {
        const url = String(arg['url'])
        if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
        return undefined
      }
      case 'showDownload': {
        const d = this.downloads.find((x) => x.id === arg['id'])
        if (d?.path) shell.showItemInFolder(d.path)
        return undefined
      }
      case 'dismissDownload': {
        const i = this.downloads.findIndex((x) => x.id === arg['id'])
        if (i >= 0) this.downloads.splice(i, 1)
        this.changed()
        return undefined
      }
      case 'closeChat':
        for (const tab of [...this.tabs.values()]) if (tab.chatId === arg['chatId']) this.closeTab(tab.id)
        return undefined
      case 'focus':
        this.current()?.view?.webContents.focus()
        return undefined
      case 'external':
        return { endpoint: this.setExternal(!!arg['on']), clients: this.bridge?.externalClients() ?? 0 }
    }
  }

  // ---- tabs ----------------------------------------------------------------------------------------------------------------------

  private current(): Tab | undefined {
    const id = this.chat ? this.selected.get(this.chat) : undefined
    return id ? this.tabs.get(id) : undefined
  }

  private tabOf(wc: WebContents): Tab | undefined {
    for (const tab of this.tabs.values()) if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents.id === wc.id) return tab
    return undefined
  }

  private touch(tab: Tab | undefined): void {
    if (tab) tab.lastUsed = Date.now()
  }

  private createTab(chatId: string, url?: string, background = false): Tab {
    const tab: Tab = { id: `tab-${Date.now().toString(36)}-${++this.next}`, chatId, view: null, url: '', title: '', loading: false, error: null, lastUsed: Date.now(), targetId: null }
    this.tabs.set(tab.id, tab)
    if (!background || !this.selected.has(chatId)) this.selected.set(chatId, tab.id)
    if (url) this.load(tab, url)
    else this.changed(true)
    return tab
  }

  private closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const order = [...this.tabs.values()].filter((t) => t.chatId === tab.chatId).map((t) => t.id)
    const after = afterClosing(order, tabId)
    this.dropView(tab)
    this.tabs.delete(tabId)
    if (this.selected.get(tab.chatId) === tabId) {
      if (after) this.selected.set(tab.chatId, after)
      else this.selected.delete(tab.chatId)
      const next = after ? this.tabs.get(after) : undefined
      if (next && !next.view && next.url) this.ensureView(next)
    }
    for (const p of [...this.prompts]) if (p.tabId === tabId) this.settle(p, false)
    this.changed(true)
  }

  /** Opens an address: in the selected tab if it is empty, in a new tab if not. */
  private open(chatId: string, url: string): string | null {
    if (!isOpenable(url) || url === 'about:blank') return null
    const selected = this.selected.get(chatId)
    const tab = selected ? this.tabs.get(selected) : undefined
    if (tab && !tab.url) {
      this.load(tab, url)
      return tab.id
    }
    return this.createTab(chatId, url).id
  }

  private load(tab: Tab, url: string): void {
    tab.url = url
    tab.error = null
    this.touch(tab)
    if (!tab.view) {
      this.ensureView(tab)
    } else {
      void tab.view.webContents.loadURL(url).catch(() => undefined)
    }
    this.changed(true)
  }

  private act(tabId: string, action: string): void {
    const tab = this.tabs.get(tabId)
    const wc = tab?.view?.webContents
    if (!tab || !wc || wc.isDestroyed()) return
    this.touch(tab)
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'stop') wc.stop()
    else if (action === 'devtools') wc.openDevTools({ mode: 'detach' })
    else if (action === 'reload') {
      if (tab.error) void wc.loadURL(tab.url).catch(() => undefined)
      else wc.reload()
    }
  }

  /** Makes the page of a tab that has none (it was never opened, or was put away) and loads its address. */
  private ensureView(tab: Tab): void {
    if (tab.view || !this.host || this.host.isDestroyed() || !this.ses) return
    const view = new WebContentsView({
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: true }
    })
    tab.view = view
    tab.targetId = null
    this.host.contentView.addChildView(view)
    this.wire(tab, view.webContents)
    view.setVisible(false)
    // A page that has never navigated does not answer DevTools commands until it does, so one with no address starts at a blank page
    // (the tab's own address stays empty, and the panel keeps showing its hint).
    void view.webContents.loadURL(tab.url || 'about:blank').catch(() => undefined)
    this.bridge?.announce(tab as BridgeTab)
  }

  private dropView(tab: Tab): void {
    const view = tab.view
    if (!view) return
    this.bridge?.closed(tab as BridgeTab)
    tab.view = null
    tab.targetId = null
    try {
      this.host?.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // Already gone.
    }
  }

  /** Puts away tabs that are hidden and have not been touched for a long time. */
  private sweep(): void {
    const shown = this.current()
    const now = Date.now()
    for (const tab of this.tabs.values()) {
      if (!tab.view || tab === shown || now - tab.lastUsed < IDLE_DISCARD_MS) continue
      if (tab.view.webContents.isCurrentlyAudible()) continue
      this.dropView(tab)
    }
    this.changed()
  }

  private wire(tab: Tab, wc: WebContents): void {
    wc.on('did-start-loading', () => {
      tab.loading = true
      this.changed()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      this.changed()
    })
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title
      this.changed()
    })
    wc.on('did-navigate', (_e, url) => {
      // The blank page a new tab starts on is not an address the person typed.
      if (url !== 'about:blank' || tab.url) tab.url = url
      tab.error = null
      this.changed(true)
    })
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (isMain) tab.url = url
      this.changed()
    })
    wc.on('did-fail-load', (_e, code, description, url, isMain) => {
      // -3 is a load that was replaced by another, which is normal.
      if (!isMain || code === -3) return
      tab.url = url
      tab.loading = false
      tab.error = describeFailure(code, description, url)
      this.changed(true)
    })
    wc.on('render-process-gone', () => {
      tab.loading = false
      tab.error = 'This page stopped working. Reload it to try again.'
      this.changed(true)
    })
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (!isOpenable(url)) event.preventDefault()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.setWindowOpenHandler((details) => this.onOpen(tab, details))
    wc.on('did-create-window', (win) => win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })))
    // The page is a native layer, so the window never sees the keys typed in it. The ones the window uses are handed back.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = { key: input.key, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta }
      if (!isWindowKey(key)) return
      event.preventDefault()
      this.host?.webContents.send('celeste:browser-key', key)
    })
    wc.on('context-menu', (_e, params) => this.contextMenu(tab, wc, params))
    // A page that closes itself (window.close()) closes its tab.
    wc.once('destroyed', () => {
      if (tab.view && this.tabs.has(tab.id)) this.closeTab(tab.id)
    })
  }

  private onOpen(tab: Tab, details: { url: string; disposition: string; features: string }) {
    if (!isOpenable(details.url) && details.url !== 'about:blank') return { action: 'deny' as const }
    // A sign-in popup that talks back to the page that opened it must be a real window; anything else is a tab.
    const popup = details.disposition === 'new-window' && /\b(width|height|popup)\b/i.test(details.features)
    if (popup) {
      return {
        action: 'allow' as const,
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          ...(this.host && !this.host.isDestroyed() ? { parent: this.host } : {}),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
        }
      }
    }
    if (details.url !== 'about:blank') this.createTab(tab.chatId, details.url, details.disposition === 'background-tab')
    return { action: 'deny' as const }
  }

  private contextMenu(tab: Tab, wc: WebContents, p: ContextMenuParams): void {
    const items: Electron.MenuItemConstructorOptions[] = []
    const link = p.linkURL && isOpenable(p.linkURL) ? p.linkURL : ''
    if (link) {
      items.push(
        { label: 'Open link in new tab', click: () => this.createTab(tab.chatId, link) },
        { label: 'Open link in my browser', click: () => void shell.openExternal(link) },
        { label: 'Copy link address', click: () => clipboard.writeText(link) },
        { type: 'separator' }
      )
    }
    if (p.mediaType === 'image' && p.srcURL && isOpenable(p.srcURL)) items.push({ label: 'Open image in new tab', click: () => this.createTab(tab.chatId, p.srcURL) }, { type: 'separator' })
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
    else if (p.selectionText) items.push({ role: 'copy' }, { type: 'separator' })
    const history = wc.navigationHistory
    items.push(
      { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) }
    )
    Menu.buildFromTemplate(items).popup(this.host && !this.host.isDestroyed() ? { window: this.host } : {})
  }

  // ---- what is on screen -----------------------------------------------------------------------------------------------------------

  private bounds(a: BrowserRect): Electron.Rectangle {
    const z = this.host?.webContents.getZoomFactor() ?? 1
    return { x: Math.round(a.x * z), y: Math.round(a.y * z), width: Math.max(0, Math.round(a.width * z)), height: Math.max(0, Math.round(a.height * z)) }
  }

  private layout(): void {
    const shown = this.current()
    for (const tab of this.tabs.values()) {
      const view = tab.view
      if (!view) continue
      const show = !!this.area && !this.covered && tab === shown && !tab.error && !!tab.url && tab.chatId === this.chat
      if (this.area) view.setBounds(this.bounds(this.area))
      view.setVisible(show)
    }
  }

  /** Something of the window is over the page (a dialog, a menu): take the page off the screen and return its picture. */
  private async cover(on: boolean): Promise<string | null> {
    if (!on) {
      this.covered = false
      this.layout()
      return null
    }
    let shot: string | null = null
    const view = this.current()?.view
    if (view && !view.webContents.isDestroyed() && this.area && !this.covered) {
      try {
        const image = await view.webContents.capturePage()
        if (!image.isEmpty()) shot = `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`
      } catch {
        // No picture: the placeholder just stays plain.
      }
    }
    this.covered = true
    this.layout()
    return shot
  }

  // ---- asking and downloading ------------------------------------------------------------------------------------------------------

  private onPermission(wc: WebContents, permission: string, callback: (allow: boolean) => void, details: { requestingUrl?: string; mediaTypes?: string[] }): void {
    const tab = this.tabOf(wc)
    if (SAFE_PERMISSIONS.has(permission)) return callback(true)
    let what = ASKED[permission]
    if (permission === 'media') {
      const types = details.mediaTypes ?? []
      const cam = types.includes('video')
      const mic = types.includes('audio')
      what = cam && mic ? 'use your camera and microphone' : cam ? 'use your camera' : mic ? 'use your microphone' : 'use your camera or microphone'
    }
    // Only a tab can ask, and only for what the bar can say.
    if (!tab || !what) return callback(false)
    const origin = originOf(details.requestingUrl ?? wc.getURL())
    const key = `${origin}|${permission}`
    const known = this.decided.get(key)
    if (known !== undefined) return callback(known)
    const waiting = this.prompts.find((p) => p.key === key)
    if (waiting) {
      waiting.callbacks.push(callback)
      return
    }
    this.prompts.push({ prompt: { id: `ask-${++this.next}`, origin, what }, key, tabId: tab.id, callbacks: [callback] })
    this.changed()
  }

  private respond(promptId: string, allow: boolean): void {
    const p = this.prompts.find((x) => x.prompt.id === promptId)
    if (!p) return
    this.decided.set(p.key, allow)
    this.settle(p, allow)
    this.changed()
  }

  private settle(p: PendingPrompt, allow: boolean): void {
    this.prompts.splice(this.prompts.indexOf(p), 1)
    for (const cb of p.callbacks) cb(allow)
  }

  private onDownload(item: Electron.DownloadItem, wc: WebContents): void {
    if (!this.tabOf(wc) && !this.owns(wc)) {
      item.cancel()
      return
    }
    const rec: DownloadRecord = { id: `dl-${++this.next}`, name: item.getFilename(), state: 'progress', received: 0, total: item.getTotalBytes(), path: '' }
    this.downloads.push(rec)
    // The system's own Save window asks where, which is the person's yes.
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), rec.name) })
    item.on('updated', () => {
      rec.received = item.getReceivedBytes()
      rec.total = item.getTotalBytes()
      this.changed()
    })
    item.once('done', (_e, state) => {
      if (state === 'cancelled') {
        this.downloads.splice(this.downloads.indexOf(rec), 1)
      } else {
        rec.state = state === 'completed' ? 'done' : 'failed'
        rec.path = item.getSavePath()
        rec.name = rec.path ? rec.path.split(/[\\/]/).pop() || rec.name : rec.name
      }
      this.changed()
    })
    this.changed()
  }

  // ---- telling the window ----------------------------------------------------------------------------------------------------------

  snapshot(): BrowserState {
    const tabs: BrowserTab[] = [...this.tabs.values()].map((t) => {
      const wc = t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null
      const history = wc?.navigationHistory
      return {
        id: t.id,
        chatId: t.chatId,
        url: t.url,
        title: t.title,
        loading: t.loading,
        canGoBack: !!history?.canGoBack(),
        canGoForward: !!history?.canGoForward(),
        error: t.error
      }
    })
    return {
      tabs,
      selected: Object.fromEntries(this.selected),
      prompts: this.prompts.map((p) => p.prompt),
      downloads: this.downloads.map(({ path: _path, ...d }) => d),
      prefs: this.prefs,
      external: { endpoint: this.bridge?.externalEndpoint() ?? null, clients: this.bridge?.externalClients() ?? 0 }
    }
  }

  /** Something changed. `layout` when what is shown may have (a tab opened, closed or failed). */
  private changed(layout = false): void {
    if (layout) this.layout()
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      const win = this.host
      if (win && !win.isDestroyed()) win.webContents.send('celeste:browser-state', this.snapshot())
    }, 30)
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
