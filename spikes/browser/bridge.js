// The spike's CDP bridge: a browser-level DevTools endpoint that shows only the browser's tabs and routes everything
// onto each tab's webContents.debugger. Written to be ported to TypeScript later.
const http = require('node:http')
const crypto = require('node:crypto')
const { wsServer: WebSocketServer } = require('playwright-core/lib/utilsBundle')

function createBridge({ tabs, createTab, closeTab, userAgent, log = () => {} }) {
  const server = http.createServer((req, res) => {
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true })
  const token = crypto.randomBytes(12).toString('hex')
  /** Per connected client: the sessions it attached. */
  const clients = new Set()

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== `/devtools/browser/${token}`) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => new Client(ws))
  })

  class Client {
    constructor(ws) {
      this.ws = ws
      /** our session id -> tab */
      this.sessions = new Map()
      /** child session id (from Electron's debugger) -> tab */
      this.children = new Map()
      this.autoAttach = false
      this.discover = false
      this.handlers = new Map()
      clients.add(this)
      ws.on('message', (data) => this.onMessage(String(data)))
      ws.on('close', () => this.dispose())
    }

    send(obj) {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
    }

    dispose() {
      clients.delete(this)
      for (const [sid, tab] of this.sessions) this.detachListeners(tab)
      this.sessions.clear()
    }

    detachListeners(tab) {
      const l = this.handlers.get(tab)
      if (l) {
        tab.view.webContents.debugger.removeListener('message', l)
        this.handlers.delete(tab)
      }
    }

    async attach(tab) {
      const dbg = tab.view.webContents.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      if (!tab.targetId) {
        const info = await dbg.sendCommand('Target.getTargetInfo')
        tab.targetId = info.targetInfo.targetId
      }
      const sessionId = crypto.randomBytes(8).toString('hex').toUpperCase()
      this.sessions.set(sessionId, tab)
      const listener = (_e, method, params, childSession) => {
        if (method === 'Target.attachedToTarget' && params.sessionId) this.children.set(params.sessionId, tab)
        this.send({ method, params, sessionId: childSession || sessionId })
      }
      dbg.on('message', listener)
      this.handlers.set(tab, listener)
      return sessionId
    }

    closed(tab) {
      for (const [sid, t] of [...this.sessions]) {
        if (t !== tab) continue
        this.send({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: tab.targetId } })
        this.sessions.delete(sid)
      }
      for (const [sid, t] of [...this.children]) if (t === tab) this.children.delete(sid)
      this.handlers.delete(tab)
      if (this.discover) this.send({ method: 'Target.targetDestroyed', params: { targetId: tab.targetId } })
    }

    targetInfo(tab) {
      return { targetId: tab.targetId, type: 'page', title: tab.view.webContents.getTitle(), url: tab.view.webContents.getURL(), attached: true, canAccessOpener: false, browserContextId: 'DEFAULT' }
    }

    async announce(tab) {
      if (!this.autoAttach) return
      const sessionId = await this.attach(tab)
      this.send({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: this.targetInfo(tab), waitingForDebugger: false } })
    }

    async onMessage(text) {
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      const { id, method, params = {}, sessionId } = msg
      if (!sessionId || method.startsWith('Target.') || method.startsWith('Browser.')) log('<-', method, sessionId ? 'session' : 'browser', JSON.stringify(params).slice(0, 120))
      const reply = (result) => this.send({ id, result, ...(sessionId ? { sessionId } : {}) })
      const fail = (message) => this.send({ id, error: { code: -32000, message }, ...(sessionId ? { sessionId } : {}) })
      try {
        if (sessionId) {
          // A command for a tab (or for something inside it).
          const tab = this.sessions.get(sessionId) ?? this.children.get(sessionId)
          if (!tab) return fail('No such session')
          const child = this.sessions.has(sessionId) ? undefined : sessionId
          const result = await tab.view.webContents.debugger.sendCommand(method, params, child)
          return reply(result)
        }
        switch (method) {
          case 'Browser.getVersion':
            return reply({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '0', userAgent, jsVersion: process.versions.v8 })
          case 'Target.getBrowserContexts':
            return reply({ browserContextIds: [] })
          case 'Target.setDiscoverTargets':
            this.discover = !!params.discover
            reply({})
            if (this.discover) for (const tab of tabs()) this.send({ method: 'Target.targetCreated', params: { targetInfo: this.targetInfo(tab) } })
            return
          case 'Target.setAutoAttach':
            this.autoAttach = !!params.autoAttach
            reply({})
            if (this.autoAttach) for (const tab of tabs()) await this.announce(tab)
            return
          case 'Target.getTargets':
            for (const tab of tabs()) if (!tab.targetId) await this.attach(tab)
            return reply({ targetInfos: tabs().map((t) => this.targetInfo(t)) })
          case 'Target.attachToTarget': {
            const tab = tabs().find((t) => t.targetId === params.targetId)
            if (!tab) return fail('No such target')
            const sid = await this.attach(tab)
            this.send({ method: 'Target.attachedToTarget', params: { sessionId: sid, targetInfo: this.targetInfo(tab), waitingForDebugger: false } })
            return reply({ sessionId: sid })
          }
          case 'Target.createTarget': {
            const tab = await createTab(params.url)
            // The client must see the new target attached BEFORE it gets the answer: Playwright looks the page up at once.
            const wasAuto = this.autoAttach
            this.autoAttach = true
            await this.announce(tab)
            this.autoAttach = wasAuto
            reply({ targetId: tab.targetId })
            for (const c of clients) if (c !== this) await c.announce(tab)
            return
          }
          case 'Target.closeTarget': {
            const tab = tabs().find((t) => t.targetId === params.targetId)
            if (!tab) return fail('No such target')
            await closeTab(tab)
            for (const c of clients) c.closed(tab)
            return reply({ success: true })
          }
          case 'Browser.close':
            return reply({})
          default:
            log('browser-level command answered with {}:', method)
            return reply({})
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e))
      }
    }
  }

  return {
    token,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      const port = server.address().port
      return { port, endpoint: `ws://127.0.0.1:${port}/devtools/browser/${token}` }
    },
    announce(tab) {
      for (const c of clients) void c.announce(tab)
    },
    /** A tab went away by itself (the page closed it). */
    closed(tab) {
      for (const c of clients) c.closed(tab)
    },
    close() {
      server.close()
      for (const c of clients) c.ws.close()
    }
  }
}

module.exports = { createBridge }
