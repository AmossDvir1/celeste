const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron')
const http = require('node:http')
const path = require('node:path')
const { createBridge } = require('./bridge')

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
app.setPath('userData', path.join(app.getPath('temp'), 'celeste-spike-profile-' + process.pid))

/** Test pages: the same server on two host names, so an iframe from the second is another site. */
function pageServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (req.url.startsWith('/frame')) return res.end('<!doctype html><title>frame</title><button id="fb" onclick="document.getElementById(\'fo\').textContent=\'frame clicked\'">Frame button</button><p id="fo"></p>')
      if (req.url.startsWith('/second')) return res.end('<!doctype html><title>Second tab</title><h1>Second tab page</h1>')
      const port = s.address().port
      res.end(`<!doctype html><title>Test page</title>
<h1>Hello from the test page</h1>
<button id="b" onclick="document.getElementById('out').textContent='clicked '+(++window.n)">Press me</button>
<input id="i" placeholder="Type here" aria-label="Name"><p id="out"></p>
<a id="blank" href="/second" target="_blank">Open second</a>
<iframe id="fr" src="http://localhost:${port}/frame" width="300" height="80"></iframe>
<script>window.n=0; console.log('page loaded'); addEventListener('click',()=>console.log('a click happened'))</script>`)
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

let win
let tabsList = []
let overlay = false
let lastRect = { x: 0, y: 0, width: 100, height: 100 }
const clean = (ua) => ua.replace(/\sElectron\/\S+/, '').replace(/\sceleste-spike\/\S+/i, '')

function layout() {
  const z = win.webContents.getZoomFactor()
  const b = { x: Math.round(lastRect.x * z), y: Math.round(lastRect.y * z), width: Math.round(lastRect.width * z), height: Math.round(lastRect.height * z) }
  for (const t of tabsList) {
    t.view.setBounds(b)
    t.view.setVisible(t === selected() && !overlay)
  }
  return b
}
const selected = () => tabsList[tabsList.length - 1]

async function createTab(url) {
  const ses = session.fromPartition('celeste-browser')
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, session: ses } })
  view.webContents.setUserAgent(clean(view.webContents.getUserAgent()))
  view.webContents.setWindowOpenHandler(({ url }) => {
    void createTab(url).then((t) => bridge?.announce(t))
    return { action: 'deny' }
  })
  const tab = { view, targetId: null }
  view.webContents.once('destroyed', () => { if (tabsList.includes(tab)) { tabsList = tabsList.filter((t) => t !== tab); bridge?.closed(tab); layout() } })
  tabsList.push(tab)
  win.contentView.addChildView(view)
  layout()
  await view.webContents.loadURL(url || 'about:blank')
  return tab
}

async function closeTab(tab) {
  const mode = process.env.CLOSE_MODE || 'close'
  console.log('closeTab called, mode', mode, 'tabs before:', tabsList.length)
  tabsList = tabsList.filter((t) => t !== tab)
  const wc = tab.view.webContents
  if (mode === 'noop') { tabsList.push(tab); return }
  if (mode === 'detachonly') { wc.debugger.removeAllListeners('message'); wc.debugger.detach(); tabsList.push(tab); return }
  if (mode === 'removeonly') { win.contentView.removeChildView(tab.view); return }
  if (mode !== 'keepdebugger' && wc.debugger.isAttached()) { wc.debugger.removeAllListeners('message'); wc.debugger.detach() }
  win.contentView.removeChildView(tab.view)
  if (mode === 'none') { layout(); return }
  if (mode === 'defer') { setTimeout(() => { wc.close(); console.log('deferred close done') }, 800); layout(); return }
  if (mode === 'destroy') { wc.destroy?.(); layout(); console.log('destroy called'); return }
  wc.close()
  console.log('closed; window destroyed =', win.isDestroyed())
  layout()
}

let bridge
let servers

app.whenReady().then(async () => {
  const s = await pageServer()
  const port = s.address().port
  win = new BrowserWindow({ width: 1000, height: 700, show: !flag('--hidden'), webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true } })
  ipcMain.on('rect', (_e, r) => {
    lastRect = r
    layout()
  })
  await win.loadFile(path.join(__dirname, 'index.html'))
  const first = await createTab(`http://127.0.0.1:${port}/`)
  const ua = first.view.webContents.getUserAgent()
  globalThis.spike = {
    port,
    tabs: () => tabsList,
    layout,
    setOverlay: async (on) => {
      overlay = on
      await win.webContents.executeJavaScript(`window.setOverlay(${on})`)
      layout()
    },
    selectedBounds: () => selected().view.getBounds(),
    visible: () => selected().view.getVisible?.() ?? null,
    win,
    ua,
    shot: async () => {
      const img = await selected().view.webContents.capturePage()
      return { size: img.getSize(), bytes: img.toPNG().length }
    }
  }
  if (flag('--bridge')) {
    bridge = createBridge({ tabs: () => tabsList, createTab, closeTab, userAgent: ua, log: (...a) => console.log('[bridge]', ...a) })
    const { endpoint } = await bridge.listen()
    console.log('BRIDGE ' + endpoint)
  }
  console.log('READY ' + port)
  process.stdin.on('data', (d) => {
    if (String(d).includes('quit')) app.quit()
  })
})
app.on('window-all-closed', () => { console.log('window-all-closed fired; win destroyed =', win.isDestroyed()); if (!flag('--stay')) app.quit() })
