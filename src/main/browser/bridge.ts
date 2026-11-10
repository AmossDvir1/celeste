import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import type { WebContents } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'

/*
 * The browser's DevTools endpoint (docs/BROWSER_PLAN.md, section 4.5): a browser-level Chrome DevTools Protocol server that Playwright
 * connects to with connectOverCDP. It shows only the browser's tabs, never Celeste's own windows, and routes every command for a tab
 * onto that tab's webContents.debugger. Core connects with a key of its own; other programs may connect only while the person allows it.
 *
 * What the spike (spikes/browser) found Playwright needs: a tab is announced (Target.attachedToTarget) before the answer to
 * Target.createTarget, a closed tab is announced (Target.detachedFromTarget) or page.close() waits for ever, and a second,
 * browser-level session (Target.attachToBrowserTarget) that Playwright uses for newCDPSession.
 */

/** A tab that has a page, as the bridge sees it. The bridge keeps the page's own id for it. */
export interface BridgeTab {
  id: string
  /** The id the page's own DevTools gives it. Set when the bridge first attaches. */
  targetId: string | null
  view: { webContents: WebContents } | null
}

export interface BridgeHost {
  /** The tabs that have a page now. */
  tabs(): BridgeTab[]
  /** Opens a tab (Playwright's newPage) and waits until it has a page. */
  createTab(url: string | undefined): Promise<BridgeTab>
  closeTab(tab: BridgeTab): Promise<void>
  userAgent(): string
  log?(...args: unknown[]): void
}

interface Attached {
  tab: BridgeTab
  /** The page it is a session of. A tab that is put back after being put away has a new page, and needs a new session. */
  wc: WebContents
  /** Where the announcement of its going is sent: the connection's root, or the browser-level session that attached it. */
  scope: string | undefined
  listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void
}

const rand = () => randomBytes(8).toString('hex').toUpperCase()

export class CdpBridge {
  private readonly server: Server
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly internalToken = randomBytes(16).toString('hex')
  private readonly externalToken = randomBytes(16).toString('hex')
  private external = false
  private port = 0
  private readonly clients = new Set<Client>()
  /** Called when a program connects or leaves. */
  onChange: (() => void) | null = null
  /** Tabs whose DevTools window opened (which ends the bridge's hold on the page) and that are waiting for it to close. */
  private readonly watched = new WeakSet<BridgeTab>()

  constructor(private readonly host: BridgeHost) {
    this.server = createServer((_req, res) => res.writeHead(404).end())
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head))
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
  }

  /** The address Core connects to. */
  internalEndpoint(): string {
    return `ws://127.0.0.1:${this.port}/devtools/browser/${this.internalToken}`
  }

  /** The address other programs connect to, or null while they are not allowed. */
  externalEndpoint(): string | null {
    return this.external ? `ws://127.0.0.1:${this.port}/devtools/browser/${this.externalToken}` : null
  }

  /** Lets other programs in, or turns them out at once. */
  setExternal(on: boolean): void {
    this.external = on
    if (!on) for (const c of [...this.clients]) if (c.external) c.close()
  }

  /** How many programs other than Core are connected. */
  externalClients(): number {
    return [...this.clients].filter((c) => c.external).length
  }

  /** A tab has a page now (it was made, or it was put back). */
  announce(tab: BridgeTab): void {
    for (const c of this.clients) void c.announce(tab)
  }

  /** A tab's page is going away. */
  closed(tab: BridgeTab): void {
    for (const c of this.clients) c.closed(tab)
  }

  /** The tab's own DevTools window ended the bridge's hold on the page: the tab is gone to Playwright until it closes. */
  private watch(tab: BridgeTab): void {
    const wc = tab.view?.webContents
    if (!wc || this.watched.has(tab)) return
    this.watched.add(tab)
    wc.debugger.on('detach', (_e, reason) => {
      if (reason === 'target closed') return
      this.closed(tab)
      wc.once('devtools-closed', () => {
        if (!wc.isDestroyed() && this.host.tabs().includes(tab)) this.announce(tab)
      })
    })
  }

  /** Attaches the page's debugger (once) and learns its DevTools id. */
  async ensureAttached(tab: BridgeTab): Promise<void> {
    const wc = tab.view?.webContents
    if (!wc || wc.isDestroyed()) throw new Error('The tab has no page.')
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    this.watch(tab)
    if (!tab.targetId) {
      const info = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo: { targetId: string } }
      tab.targetId = info.targetInfo.targetId
    }
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const reject = (): void => {
      socket.destroy()
    }
    // A web page can open a WebSocket to this computer, and always says where it came from. Programs (Playwright) say nothing.
    if (req.headers.origin !== undefined) return reject()
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reject()
    const url = req.url ?? ''
    const isInternal = url === `/devtools/browser/${this.internalToken}`
    const isExternal = this.external && url === `/devtools/browser/${this.externalToken}`
    if (!isInternal && !isExternal) return reject()
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client = new Client(this, ws, isExternal)
      this.clients.add(client)
      this.onChange?.()
    })
  }

  /** @internal Used by a client. */
  get hostApi(): BridgeHost {
    return this.host
  }

  /** @internal */
  forget(client: Client): void {
    if (this.clients.delete(client)) this.onChange?.()
  }

  /** @internal */
  all(): Set<Client> {
    return this.clients
  }

  close(): void {
    for (const c of [...this.clients]) c.close()
    this.server.close()
  }
}

export class Client {
  /** Sessions of tabs, by id. */
  private readonly sessions = new Map<string, Attached>()
  /** Sessions inside a page (a frame in another process), by id: they belong to the tab whose page they are in. */
  private readonly children = new Map<string, BridgeTab>()
  /** Browser-level sessions, which Playwright makes for its own use. */
  private readonly browserSessions = new Set<string>()
  private autoAttach = false
  private discover = false
  /** Pages being announced now, so a second announcement of one waits for the first instead of making another. */
  private readonly announcing = new Map<WebContents, Promise<void>>()

  constructor(
    private readonly bridge: CdpBridge,
    private readonly ws: WebSocket,
    readonly external: boolean
  ) {
    ws.on('message', (data) => void this.onMessage(String(data)))
    ws.on('close', () => this.dispose())
    ws.on('error', () => this.dispose())
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // Already closed.
    }
    this.dispose()
  }

  private dispose(): void {
    for (const a of this.sessions.values()) a.tab.view?.webContents.debugger.removeListener('message', a.listener)
    this.sessions.clear()
    this.children.clear()
    this.bridge.forget(this)
  }

  private send(obj: object): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
  }

  private emit(scope: string | undefined, method: string, params: object): void {
    this.send({ method, params, ...(scope ? { sessionId: scope } : {}) })
  }

  private info(tab: BridgeTab) {
    const wc = tab.view?.webContents
    return { targetId: tab.targetId, type: 'page', title: wc && !wc.isDestroyed() ? wc.getTitle() : '', url: wc && !wc.isDestroyed() ? wc.getURL() : '', attached: true, canAccessOpener: false, browserContextId: 'DEFAULT' }
  }

  private tabs(): BridgeTab[] {
    return this.bridge.hostApi.tabs().filter((t) => t.view && !t.view.webContents.isDestroyed())
  }

  /** Gives the program a session on a tab. */
  private async attach(tab: BridgeTab, scope: string | undefined): Promise<string> {
    await this.bridge.ensureAttached(tab)
    const wc = tab.view!.webContents
    const sessionId = rand()
    const listener = (_e: unknown, method: string, params: unknown, childSession?: string) => {
      if (method === 'Target.attachedToTarget') {
        const id = (params as { sessionId?: string }).sessionId
        if (id) this.children.set(id, tab)
      }
      this.send({ method, params, sessionId: childSession || sessionId })
    }
    wc.debugger.on('message', listener)
    this.sessions.set(sessionId, { tab, wc, scope, listener })
    return sessionId
  }

  /**
   * Shows the program a page it can attach to. Once per page: the browser announces a new page itself, and a request to make one
   * announces it too, and the program (Playwright) stops with "Duplicate target" if it is told twice. A second call waits for the first,
   * so whoever must have it announced before going on (the answer to createTarget) can count on it.
   */
  announce(tab: BridgeTab): Promise<void> {
    const wc = tab.view?.webContents
    if (!this.autoAttach || !wc || wc.isDestroyed()) return Promise.resolve()
    const running = this.announcing.get(wc)
    if (running) return running
    if ([...this.sessions.values()].some((a) => a.wc === wc && a.scope === undefined)) return Promise.resolve()
    const work = (async () => {
      try {
        const sessionId = await this.attach(tab, undefined)
        this.emit(undefined, 'Target.attachedToTarget', { sessionId, targetInfo: this.info(tab), waitingForDebugger: false })
      } catch {
        // The page went away while it was being announced.
      } finally {
        this.announcing.delete(wc)
      }
    })()
    this.announcing.set(wc, work)
    return work
  }

  closed(tab: BridgeTab): void {
    for (const [id, a] of [...this.sessions]) {
      if (a.tab !== tab) continue
      a.tab.view?.webContents.debugger.removeListener('message', a.listener)
      this.sessions.delete(id)
      this.emit(a.scope, 'Target.detachedFromTarget', { sessionId: id, targetId: tab.targetId })
    }
    for (const [id, t] of [...this.children]) if (t === tab) this.children.delete(id)
    if (this.discover && tab.targetId) this.emit(undefined, 'Target.targetDestroyed', { targetId: tab.targetId })
  }

  private async onMessage(text: string): Promise<void> {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const { id, method, params = {}, sessionId } = msg
    if (typeof id !== 'number' || typeof method !== 'string') return
    const tag = sessionId ? { sessionId } : {}
    const reply = (result: object = {}) => this.send({ id, result, ...tag })
    const fail = (message: string) => this.send({ id, error: { code: -32000, message }, ...tag })
    try {
      // A command for a tab, or for something inside it.
      const attached = sessionId ? this.sessions.get(sessionId) : undefined
      const childTab = sessionId && !attached ? this.children.get(sessionId) : undefined
      if (attached || childTab) {
        const tab = (attached?.tab ?? childTab) as BridgeTab
        const wc = tab.view?.webContents
        if (!wc || wc.isDestroyed()) return fail('The page is gone.')
        return reply((await wc.debugger.sendCommand(method, params, attached ? undefined : sessionId)) as object)
      }
      if (sessionId && !this.browserSessions.has(sessionId)) return fail('No such session')
      await this.browserCommand(method, params, sessionId, reply, fail)
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
    }
  }

  /** A command for the browser itself, from the connection's root or from one of its browser-level sessions. */
  private async browserCommand(method: string, params: Record<string, unknown>, scope: string | undefined, reply: (r?: object) => void, fail: (m: string) => void): Promise<void> {
    const host = this.bridge.hostApi
    switch (method) {
      case 'Browser.getVersion':
        return reply({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '0', userAgent: host.userAgent(), jsVersion: process.versions.v8 })
      case 'Target.attachToBrowserTarget': {
        const id = rand()
        this.browserSessions.add(id)
        return reply({ sessionId: id })
      }
      case 'Target.getBrowserContexts':
        return reply({ browserContextIds: [] })
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext':
        return fail('Celeste’s browser has one profile; separate browser contexts are not supported.')
      case 'Target.setDiscoverTargets': {
        this.discover = !!params['discover']
        reply()
        if (this.discover) {
          for (const tab of this.tabs()) {
            await this.bridge.ensureAttached(tab).catch(() => undefined)
            this.emit(scope, 'Target.targetCreated', { targetInfo: this.info(tab) })
          }
        }
        return
      }
      case 'Target.setAutoAttach': {
        reply()
        if (!scope) {
          this.autoAttach = !!params['autoAttach']
          if (this.autoAttach) for (const tab of this.tabs()) await this.announce(tab)
        }
        return
      }
      case 'Target.getTargets': {
        const tabs = this.tabs()
        for (const tab of tabs) await this.bridge.ensureAttached(tab).catch(() => undefined)
        return reply({ targetInfos: tabs.filter((t) => t.targetId).map((t) => this.info(t)) })
      }
      case 'Target.getTargetInfo': {
        const tab = this.tabs().find((t) => t.targetId === params['targetId'])
        if (!tab) return reply({ targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } })
        return reply({ targetInfo: this.info(tab) })
      }
      case 'Target.attachToTarget': {
        const tab = this.tabs().find((t) => t.targetId === params['targetId'])
        if (!tab) return fail('No such target')
        const sessionId = await this.attach(tab, scope)
        // Explicit attaches are answered with the session; the announcement is for auto-attach (Playwright would take it for a new page).
        return reply({ sessionId })
      }
      case 'Target.detachFromTarget': {
        const id = String(params['sessionId'] ?? '')
        const a = this.sessions.get(id)
        if (a) {
          a.tab.view?.webContents.debugger.removeListener('message', a.listener)
          this.sessions.delete(id)
        }
        this.browserSessions.delete(id)
        return reply()
      }
      case 'Target.createTarget': {
        const tab = await host.createTab(typeof params['url'] === 'string' && params['url'] !== 'about:blank' ? params['url'] : undefined)
        // The program must see the new page attached before it gets the answer: Playwright looks it up at once.
        const was = this.autoAttach
        this.autoAttach = true
        await this.announce(tab)
        this.autoAttach = was
        reply({ targetId: tab.targetId })
        for (const c of this.bridge.all()) if (c !== this) void c.announce(tab)
        return
      }
      case 'Target.closeTarget': {
        const tab = this.tabs().find((t) => t.targetId === params['targetId'])
        if (!tab) return fail('No such target')
        await host.closeTab(tab)
        return reply({ success: true })
      }
      case 'Target.activateTarget':
      case 'Browser.setDownloadBehavior':
      case 'Browser.close':
        return reply()
      case 'Browser.getWindowForTarget':
        return reply({ windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } })
      default:
        host.log?.('browser command answered with nothing:', method)
        return reply()
    }
  }
}
