import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { CdpBridge, type BridgeHost, type BridgeTab } from './bridge'

let counter = 0

class FakeDebugger extends EventEmitter {
  attached = false
  readonly sent: { method: string; params: unknown; session: string | undefined }[] = []
  readonly targetId = `TARGET-${++counter}`
  attach(): void {
    this.attached = true
  }
  isAttached(): boolean {
    return this.attached
  }
  async sendCommand(method: string, params: unknown, session?: string): Promise<object> {
    this.sent.push({ method, params, session })
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: this.targetId } }
    return { ran: method, session: session ?? null }
  }
}

class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  destroyed = false
  constructor(
    private url: string,
    private title: string
  ) {
    super()
  }
  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return this.title
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

const makeTab = (url = 'https://example.com/', title = 'Example'): BridgeTab => ({ id: `tab-${++counter}`, targetId: null, view: { webContents: new FakeContents(url, title) as never } })
const dbg = (tab: BridgeTab): FakeDebugger => (tab.view!.webContents as unknown as FakeContents).debugger
const contents = (tab: BridgeTab): FakeContents => tab.view!.webContents as unknown as FakeContents

/** A program on the other end: sends commands, keeps every message it was sent in order. */
class Program {
  readonly messages: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown>; error?: { message: string } }[] = []
  private next = 0
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(String(d))))
  }
  static async connect(url: string, headers: Record<string, string> = {}): Promise<Program> {
    const ws = new WebSocket(url, { headers })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)))
    })
    return new Program(ws)
  }
  async call(method: string, params: object = {}, sessionId?: string): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const id = ++this.next
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    await this.until(() => this.messages.some((m) => m.id === id))
    return this.messages.find((m) => m.id === id)!
  }
  events(method: string) {
    return this.messages.filter((m) => m.method === method)
  }
  indexOf(pred: (m: Program['messages'][number]) => boolean): number {
    return this.messages.findIndex(pred)
  }
  async until(fn: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (fn()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('timed out')
  }
  closed(): Promise<void> {
    return new Promise((resolve) => (this.ws.readyState === WebSocket.CLOSED ? resolve() : this.ws.once('close', () => resolve())))
  }
}

let tabs: BridgeTab[]
let bridge: CdpBridge
let host: BridgeHost
/** The browser itself announces a page it makes, as the real one does; a test can turn that off. */
let hostAnnounces = false
const programs: Program[] = []
const connect = async (url = bridge.internalEndpoint(), headers?: Record<string, string>) => {
  const p = await Program.connect(url, headers)
  programs.push(p)
  return p
}

beforeEach(async () => {
  hostAnnounces = false
  tabs = [makeTab('https://one.test/', 'One'), makeTab('https://two.test/', 'Two')]
  host = {
    tabs: () => tabs,
    createTab: async (url) => {
      const tab = makeTab(url ?? 'about:blank', '')
      tabs.push(tab)
      if (hostAnnounces) bridge.announce(tab)
      return tab
    },
    closeTab: async (tab) => {
      tabs = tabs.filter((t) => t !== tab)
      bridge.closed(tab)
    },
    userAgent: () => 'Mozilla/5.0 Chrome/156'
  }
  bridge = new CdpBridge(host)
  await bridge.listen()
})

afterEach(() => {
  for (const p of programs.splice(0)) p.ws.terminate()
  bridge.close()
})

describe('who may connect', () => {
  it('refuses a wrong key, a wrong path and a web page (which always says where it came from)', async () => {
    const good = bridge.internalEndpoint()
    await expect(connect(good.replace(/\/[0-9a-f]+$/, '/nope'))).rejects.toThrow()
    await expect(connect(good.replace('/devtools/browser/', '/other/'))).rejects.toThrow()
    await expect(connect(good, { Origin: 'https://evil.test' })).rejects.toThrow()
    await expect(connect(good, { Host: 'evil.test' })).rejects.toThrow()
    await expect(connect(good)).resolves.toBeTruthy()
  })

  it('keeps other programs out until they are allowed, and turns them out when they are not', async () => {
    expect(bridge.externalEndpoint()).toBeNull()
    bridge.setExternal(true)
    const url = bridge.externalEndpoint()!
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{32}$/)
    expect(url).not.toBe(bridge.internalEndpoint())
    const core = await connect()
    const other = await connect(url)
    expect(bridge.externalClients()).toBe(1)
    bridge.setExternal(false)
    await other.closed()
    expect(bridge.externalEndpoint()).toBeNull()
    expect(bridge.externalClients()).toBe(0)
    await expect(connect(url)).rejects.toThrow()
    // Core is not turned out.
    expect((await core.call('Browser.getVersion')).result?.['product']).toMatch(/^Chrome\//)
  })
})

describe('what it shows', () => {
  it('lists only the browser’s tabs, with the ids their own DevTools gave them', async () => {
    const p = await connect()
    const r = await p.call('Target.getTargets')
    const infos = r.result?.['targetInfos'] as { targetId: string; url: string; type: string }[]
    expect(infos.map((i) => i.url)).toEqual(['https://one.test/', 'https://two.test/'])
    expect(infos.map((i) => i.targetId)).toEqual([dbg(tabs[0]!).targetId, dbg(tabs[1]!).targetId])
    expect(new Set(infos.map((i) => i.type))).toEqual(new Set(['page']))
  })

  it('announces each tab when asked to attach to them, and sends a command for a tab to that tab’s page', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    const first = p.events('Target.attachedToTarget')[0]!.params as { sessionId: string; targetInfo: { url: string } }
    expect(first.targetInfo.url).toBe('https://one.test/')
    const answer = await p.call('Page.navigate', { url: 'https://x.test' }, first.sessionId)
    expect(answer.result?.['ran']).toBe('Page.navigate')
    expect(dbg(tabs[0]!).sent.some((c) => c.method === 'Page.navigate' && (c.params as { url: string }).url === 'https://x.test')).toBe(true)
    expect(dbg(tabs[1]!).sent.some((c) => c.method === 'Page.navigate')).toBe(false)
    expect(p.messages.find((m) => m.id === 1 && m.sessionId === first.sessionId) ?? p.messages.at(-1)).toBeTruthy()
  })

  it('passes what a page says back, under that tab’s session', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    const second = p.events('Target.attachedToTarget')[1]!.params as { sessionId: string }
    dbg(tabs[1]!).emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' })
    await p.until(() => p.events('Runtime.consoleAPICalled').length === 1)
    expect(p.events('Runtime.consoleAPICalled')[0]!.sessionId).toBe(second.sessionId)
  })

  it('sends a command for something inside a page (a frame in another process) with that frame’s own session', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    dbg(tabs[0]!).emit('message', {}, 'Target.attachedToTarget', { sessionId: 'FRAME-1', targetInfo: { type: 'iframe' } })
    await p.until(() => p.events('Target.attachedToTarget').length === 3)
    await p.call('Runtime.evaluate', { expression: '1' }, 'FRAME-1')
    expect(dbg(tabs[0]!).sent.at(-1)).toMatchObject({ method: 'Runtime.evaluate', session: 'FRAME-1' })
  })

  it('refuses a session it does not know, and a context of its own', async () => {
    const p = await connect()
    expect((await p.call('Page.enable', {}, 'NOPE')).error?.message).toMatch(/No such session/)
    expect((await p.call('Target.createBrowserContext')).error?.message).toMatch(/one profile/)
    expect((await p.call('Target.attachToTarget', { targetId: 'NOT-A-TAB' })).error?.message).toMatch(/No such target/)
  })
})

describe('tabs coming and going', () => {
  it('shows a new page attached before it answers the request that made it (Playwright looks it up at once)', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    const r = await p.call('Target.createTarget', { url: 'https://new.test/' })
    const targetId = r.result?.['targetId'] as string
    const attached = p.indexOf((m) => m.method === 'Target.attachedToTarget' && (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId === targetId)
    const answer = p.indexOf((m) => m.id !== undefined && (m.result?.['targetId'] as string | undefined) === targetId)
    expect(attached).toBeGreaterThan(-1)
    expect(attached).toBeLessThan(answer)
    expect(tabs).toHaveLength(3)
  })

  it('tells a program about a new page once, even though the browser announces it and the request does too (Playwright stops on a second)', async () => {
    hostAnnounces = true
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    const r = await p.call('Target.createTarget', { url: 'https://new.test/' })
    const targetId = r.result?.['targetId'] as string
    await new Promise((res) => setTimeout(res, 80))
    const about = p.messages.filter((m) => m.method === 'Target.attachedToTarget' && (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId === targetId)
    expect(about).toHaveLength(1)
    expect(p.messages.indexOf(about[0]!)).toBeLessThan(p.indexOf((m) => m.id !== undefined && (m.result?.['targetId'] as string | undefined) === targetId))
  })

  it('does not announce a page it already shows, when the browser announces it again', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    bridge.announce(tabs[0]!)
    bridge.announce(tabs[0]!)
    await new Promise((res) => setTimeout(res, 80))
    expect(p.events('Target.attachedToTarget')).toHaveLength(2)
  })

  it('says a closed tab is gone, so page.close() ends', async () => {
    const p = await connect()
    await p.call('Target.setDiscoverTargets', { discover: true })
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    const sessionOfFirst = (p.events('Target.attachedToTarget')[0]!.params as { sessionId: string }).sessionId
    const r = await p.call('Target.closeTarget', { targetId: dbg(tabs[0]!).targetId })
    expect(r.result?.['success']).toBe(true)
    const gone = p.events('Target.detachedFromTarget')
    expect(gone).toHaveLength(1)
    expect(gone[0]!.params).toMatchObject({ sessionId: sessionOfFirst })
    expect(p.events('Target.targetDestroyed')).toHaveLength(1)
    const rest = await p.call('Target.getTargets')
    expect((rest.result?.['targetInfos'] as unknown[]).length).toBe(1)
  })

  it('tells every program when a page goes away on its own, and when one comes back', async () => {
    const core = await connect()
    bridge.setExternal(true)
    const other = await connect(bridge.externalEndpoint()!)
    for (const p of [core, other]) await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await core.until(() => core.events('Target.attachedToTarget').length === 2 && other.events('Target.attachedToTarget').length === 2)
    bridge.closed(tabs[0]!)
    await core.until(() => core.events('Target.detachedFromTarget').length === 1 && other.events('Target.detachedFromTarget').length === 1)
    bridge.announce(tabs[0]!)
    await core.until(() => core.events('Target.attachedToTarget').length === 3 && other.events('Target.attachedToTarget').length === 3)
  })

  it('treats the page’s own DevTools window as the page going away, and back when it closes', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    // The reason the debugger lets go when its own window closes the page is a different one: that is not DevTools.
    dbg(tabs[0]!).emit('detach', {}, 'target closed')
    await new Promise((r) => setTimeout(r, 60))
    expect(p.events('Target.detachedFromTarget')).toHaveLength(0)
    dbg(tabs[0]!).emit('detach', {}, 'replaced_with_devtools')
    await p.until(() => p.events('Target.detachedFromTarget').length === 1)
    contents(tabs[0]!).emit('devtools-closed')
    await p.until(() => p.events('Target.attachedToTarget').length === 3)
  })
})

describe('the session Playwright makes for itself (newCDPSession)', () => {
  it('attaches a tab without announcing it as a new page, and says it is gone to the session that attached it', async () => {
    const p = await connect()
    await p.call('Target.setAutoAttach', { autoAttach: true, flatten: true })
    await p.until(() => p.events('Target.attachedToTarget').length === 2)
    const root = (await p.call('Target.attachToBrowserTarget')).result?.['sessionId'] as string
    expect(root).toBeTruthy()
    const before = p.events('Target.attachedToTarget').length
    const attach = await p.call('Target.attachToTarget', { targetId: dbg(tabs[0]!).targetId, flatten: true }, root)
    const extra = attach.result?.['sessionId'] as string
    expect(extra).toBeTruthy()
    expect(p.events('Target.attachedToTarget')).toHaveLength(before)
    // A command in that session goes to the page itself, which is how Playwright learns which page is which.
    const own = await p.call('Target.getTargetInfo', {}, extra)
    expect((own.result?.['targetInfo'] as { targetId: string }).targetId).toBe(dbg(tabs[0]!).targetId)
    const info = await p.call('Target.getTargetInfo', { targetId: dbg(tabs[0]!).targetId }, root)
    expect((info.result?.['targetInfo'] as { url: string }).url).toBe('https://one.test/')
    await p.call('Target.detachFromTarget', { sessionId: extra }, root)
    expect((await p.call('Page.enable', {}, extra)).error?.message).toMatch(/No such session/)
  })
})
