import { app, BrowserWindow, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { registerAttachmentScheme, serveAttachments } from './attachments-protocol'
import { CoreProcess } from './core-process'
import { secrets } from './secrets'

const DEV_URL = process.env['ELECTRON_RENDERER_URL']
// Test scripts open a specific view, for example CELESTE_QUERY="bare=chat".
const START_QUERY = process.env['CELESTE_QUERY'] ?? ''
const isMac = process.platform === 'darwin'
const HEX = /^#[0-9a-fA-F]{6}$/

// The name decides the data folder (for example %APPDATA%\Celeste), so set it before anything reads it.
app.setName('Celeste')
registerAttachmentScheme()

const core = new CoreProcess()
const flushed = new WeakSet<BrowserWindow>()

/** Asks the window to save whatever it is holding (unsent text) and waits briefly for its answer. */
function flushWindow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (event?: IpcMainEvent) => {
      if (event && event.sender !== win.webContents) return
      clearTimeout(timer)
      ipcMain.off('celeste:flush-done', done)
      flushed.add(win)
      resolve()
    }
    const timer = setTimeout(() => done(), 1200)
    ipcMain.on('celeste:flush-done', done)
    win.webContents.send('celeste:before-quit')
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: '#080c17',
    title: 'Celeste',
    icon: join(__dirname, '../../resources/icon.png'),
    // Native window controls are drawn over the app's own top bar.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 18, y: 20 } }
      : { titleBarOverlay: { color: '#080c17', symbolColor: '#aeb8d1', height: 56 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Closing the window first saves what it holds, so the last keystrokes are not lost.
  win.on('close', (event) => {
    if (flushed.has(win)) return
    event.preventDefault()
    void flushWindow(win).then(() => win.close())
  })

  // Links open in the system browser. The app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  if (DEV_URL) {
    void win.loadURL(START_QUERY ? `${DEV_URL}?${START_QUERY}` : DEV_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: START_QUERY })
  }
}

/** Only the app's own windows may use the bridge. */
function fromOurWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!BrowserWindow.fromWebContents(event.sender) && event.senderFrame === event.sender.mainFrame
}

// The renderer tells us the theme so the native window buttons match the top bar.
ipcMain.on('celeste:theme', (event, payload: { color?: unknown; symbolColor?: unknown }) => {
  if (!fromOurWindow(event)) return
  const { color, symbolColor } = payload ?? {}
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return
  if (!HEX.test(color) || !HEX.test(symbolColor)) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || isMac) return
  win.setBackgroundColor(color)
  win.setTitleBarOverlay({ color, symbolColor, height: 56 })
})

// Each window asks for its own line to Core as soon as its preload script runs.
ipcMain.on('celeste:port-request', (event) => {
  if (fromOurWindow(event)) core.connect(event.sender)
})

// Secrets are stored and removed here and never sent to the window. See secrets.ts.
ipcMain.handle('celeste:secrets', (event, op: string, name: unknown, value: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  switch (op) {
    case 'available':
      return secrets.available()
    case 'set':
      return secrets.set(name, value)
    case 'remove':
      return secrets.remove(name)
    case 'has':
      return secrets.has(name)
    case 'hint':
      return secrets.hint(name)
    default:
      throw new Error('Unknown operation')
  }
})

ipcMain.handle('celeste:reveal-data', (event) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  shell.showItemInFolder(join(app.getPath('userData'), 'celeste.db'))
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('app.celeste')
    core.start()
    serveAttachments()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  // Quit in order: windows save their drafts, then Core closes the database, then the app exits.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void Promise.all(BrowserWindow.getAllWindows().map(flushWindow))
      .then(() => core.shutdown())
      .finally(() => app.quit())
  })
}
