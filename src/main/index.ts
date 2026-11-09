import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { canOpenFile } from '@shared/produced'
import { resolveChatFile } from './chat-files'
import { registerAttachmentScheme, serveAttachments } from './attachments-protocol'
import { CoreProcess } from './core-process'
import { DesktopService } from './desktop/service'
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
// The assistant's use of this computer's mouse and keyboard (docs/DESKTOP_CONTROL_PLAN.md). Core decides; this does it, and shows the bar.
const desktop = new DesktopService({
  stop: (why) => core.send({ type: 'desktop-stop', why }),
  extend: () => core.send({ type: 'desktop-extend' })
})
core.setDesktop(desktop)
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

  // Control ends with the last of Celeste's own windows: nothing may be left controlling the computer with no chat in view.
  win.on('closed', () => {
    if (!BrowserWindow.getAllWindows().some((w) => !desktop.owns(w))) desktop.stopAll('You closed Celeste.')
  })

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

// Files the agent made in a chat's private folder. The window names one; this checks it is really there, and never starts a program.
ipcMain.handle('celeste:chat-file', async (event, sessionId: unknown, path: unknown, action: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  const found = resolveChatFile(app.getPath('userData'), sessionId, path)
  if ('error' in found) return { ok: false, message: found.error }
  const name = basename(found.file)
  if (action === 'reveal') {
    shell.showItemInFolder(found.file)
    return { ok: true }
  }
  if (action === 'open') {
    // Only documents are opened. A program or script the agent wrote can be shown in its folder, not started from here.
    if (!canOpenFile(name)) return { ok: false, message: 'Celeste only opens documents. Show this one in its folder instead.' }
    const failed = await shell.openPath(found.file)
    return failed ? { ok: false, message: failed } : { ok: true }
  }
  if (action === 'save') {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { defaultPath: join(app.getPath('downloads'), name) }
    const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return { ok: false }
    await copyFile(found.file, chosen.filePath)
    return { ok: true, message: `Saved ${basename(chosen.filePath)}.` }
  }
  return { ok: false, message: 'Unknown action.' }
})

// A workflow is shared and imported as a text file. The window asks; the person chooses the file in the system's own dialog.
ipcMain.handle('celeste:save-text', async (event, suggestedName: unknown, text: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  if (typeof suggestedName !== 'string' || typeof text !== 'string' || text.length > 2_000_000) throw new Error('Invalid file')
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = { defaultPath: join(app.getPath('documents'), basename(suggestedName)) }
  const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (chosen.canceled || !chosen.filePath) return { saved: null }
  await writeFile(chosen.filePath, text, 'utf8')
  return { saved: basename(chosen.filePath) }
})

ipcMain.handle('celeste:open-text', async (event, extensions: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  const exts = Array.isArray(extensions) ? extensions.filter((e): e is string => typeof e === 'string' && /^[a-z0-9]{1,12}$/i.test(e)) : []
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = { properties: ['openFile' as const], filters: exts.length ? [{ name: 'Workflow', extensions: exts }] : [] }
  const chosen = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = chosen.filePaths[0]
  if (chosen.canceled || !path) return null
  if ((await stat(path)).size > 1_000_000) throw new Error('That file is too large to be a workflow.')
  return { name: basename(path), text: await readFile(path, 'utf8') }
})

ipcMain.handle('celeste:reveal-data', (event) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  shell.showItemInFolder(join(app.getPath('userData'), 'celeste.db'))
})

ipcMain.handle('celeste:choose-folder', async (event) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = { properties: ['openDirectory' as const] }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
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
    desktop.stopAll('Celeste closed.')
    void Promise.all(BrowserWindow.getAllWindows().map(flushWindow))
      .then(() => core.shutdown())
      .finally(() => app.quit())
  })
}
