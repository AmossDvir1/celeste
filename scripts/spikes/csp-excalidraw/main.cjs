const { app, BrowserWindow, session } = require('electron')
const { join } = require('node:path')
// Every request the page makes that is not a local file, so the harness can see what would have gone to the network.
global.requests = []
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    if (!d.url.startsWith('file://') && !d.url.startsWith('devtools://')) global.requests.push(d.url.slice(0, 160))
    cb({})
  })
  const win = new BrowserWindow({ width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true } })
  win.loadFile(join(__dirname, 'dist', 'index.html'))
})
