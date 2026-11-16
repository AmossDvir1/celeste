import { app, BrowserWindow, dialog, ipcMain, Notification, powerMonitor, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { canOpenFile } from '@shared/produced'
import { resolveChatFile } from '../core/chat-files'
import { registerAttachmentScheme, serveAttachments } from './attachments-protocol'
import { BrowserService } from './browser/service'
import { CoreProcess, type AppMessage } from './core-process'
import { DesktopService } from './desktop/service'
import { secrets } from './secrets'
import { APP_ID, registerDevIdentity } from './identity'
import { LayoutService } from './layout'
import { BACKGROUND_ARG, LoginItem } from './login-item'
import { TrayService } from './tray'
import { hidesOnClose, quitQuestion, shouldNotify, startsHidden } from './tray-rules'

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
  extend: () => core.send({ type: 'desktop-extend' }),
  resume: () => core.send({ type: 'desktop-resume' })
})
core.setDesktop(desktop)
// The browser pane (docs/BROWSER_PLAN.md): the pages are views laid over the window; the window says which are shown and where.
const browser = new BrowserService(join(app.getPath('userData'), 'browser.json'), { appDir: join(__dirname, '../renderer'), devUrl: DEV_URL })
/** The web contents of Celeste's own windows, the only ones the bridge answers (a page in the browser has no bridge, and a sign-in popup is not one of these). */
const ownContents = new WeakSet<WebContents>()
core.setBrowser(browser)
const flushed = new WeakSet<BrowserWindow>()

// The tray (docs/TRAY_AND_COMPACT_PLAN.md, Part 1): closing the window hides it, and Celeste goes on in the tray.
let quitting = false
/** Settings, General: closing the window leaves Celeste running. Core tells us at start-up and whenever it changes. */
let closeToTray = true
let working = 0
let waiting = 0
/** How many schedules there are, and whether they are all paused: Core tells us, for the tray's menu. */
let scheduleCount = 0
let schedulesPaused = false
/** Started with the computer (`--background`): the first window stays hidden in the tray. */
let background = process.argv.includes(BACKGROUND_ARG)
/** The window was left hidden at start-up and nobody has asked for it yet. */
let startedHidden = false
const loginItem = new LoginItem()
const APP_ICON = join(__dirname, '../../resources/icon.png')
const tray = new TrayService({
  icon: APP_ICON,
  open: () => showMain(),
  quit: () => void quitFromTray(),
  compact: () => layout.state().compact,
  toggleCompact: () => layout.set(showMain(), { compact: !layout.state().compact }),
  schedules: () => ({ count: scheduleCount, paused: schedulesPaused }),
  // Core makes the change and tells us the new state, which redraws the menu.
  togglePauseSchedules: () => core.send({ type: 'schedules-pause', on: !schedulesPaused })
})
/** The window's two shapes, the full window and the small side window (docs/TRAY_AND_COMPACT_PLAN.md, Part 2). */
const layout = new LayoutService(join(app.getPath('userData'), 'layout.json'), () => tray.refresh())
/** The first time the window is hidden, one notice says where Celeste went. Remembered in a file of its own, so it is said once. */
const trayNote = join(app.getPath('userData'), 'tray-told')
const notices = new Set<Notification>()

// The app checks read the tray's menu and the notifications that were shown, and press them, through this (the system's own menu and
// notifications cannot be reached from a script).
const shown: { title: string; body: string; click?: () => void }[] = []
if (process.env['CELESTE_TEST_HOOKS'] === '1') {
  ;(globalThis as Record<string, unknown>)['celesteTest'] = {
    tray: () => tray.inspect(),
    notices: () => shown.map(({ title, body }) => ({ title, body })),
    clickNotice: (i: number) => shown[i]?.click?.()
  }
}

/** The window of the app itself (not the bar or a border of desktop control). */
function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && ownContents.has(w.webContents))
}

/** Brings the window back from the tray, the taskbar or nothing at all. */
function showMain(): BrowserWindow {
  startedHidden = false
  const win = mainWindow() ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

/** Hides the window, once what it holds is saved. The assistant stops using the computer with it: control needs a chat in view. */
function hideMain(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.hide()
  desktop.stopAll('Celeste was hidden.')
  if (!existsSync(trayNote)) {
    try {
      writeFileSync(trayNote, 'told')
    } catch {
      /* the notice may be said again next time */
    }
    say('Celeste is still running in the tray', 'Right-click its icon to quit. You can change this in Settings, General.')
  }
}

function say(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  if (process.env['CELESTE_TEST_HOOKS'] === '1') shown.push({ title, body, ...(onClick ? { click: onClick } : {}) })
  const n = new Notification({ title, body, icon: APP_ICON })
  notices.add(n)
  n.on('click', () => onClick?.())
  n.on('close', () => notices.delete(n))
  n.show()
}

/** A chat or a workflow needs the person while they may not be looking: say so, and let a click take them to it. */
function needsYou(m: { kind: 'chat' | 'run'; target: string; title: string; text: string }): void {
  const win = mainWindow()
  if (!shouldNotify(win ? { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() } : null)) return
  say(`${m.title} needs you`, m.text, () => showMain().webContents.send('celeste:open', { kind: m.kind, target: m.target }))
  if (win?.isVisible()) win.flashFrame(true)
}

/** Quit from the tray: asks first when something would be stopped. */
async function quitFromTray(): Promise<void> {
  const question = quitQuestion(working, waiting)
  if (question) {
    const answer = await dialog.showMessageBox({ type: 'question', buttons: ['Quit', 'Keep running'], defaultId: 1, cancelId: 1, title: 'Quit Celeste?', message: 'Quit Celeste?', detail: question })
    if (answer.response !== 0) return
  }
  app.quit()
}

function hearCore(message: AppMessage): void {
  if (message.type === 'app-settings') {
    if (typeof message.closeToTray === 'boolean') closeToTray = message.closeToTray
    // The icon is only there while closing hides the window; with the setting off it is taken away.
    if (!closeToTray) {
      tray.destroy()
      // Started hidden into a tray that is now gone: nothing could bring the window back.
      if (startedHidden) showMain()
    } else if (process.platform === 'win32') tray.ensure()
  } else if (message.type === 'schedules-state') {
    if (typeof message.paused === 'boolean' && typeof message.count === 'number') {
      schedulesPaused = message.paused
      scheduleCount = message.count
      tray.refresh()
    }
  } else if (message.type === 'attention') {
    if (typeof message.working === 'number' && typeof message.waiting === 'number') {
      working = message.working
      waiting = message.waiting
      tray.update(working, waiting)
    }
  } else if (message.type === 'finished') {
    // A command the assistant started has ended: said only while the person may not be looking, like the others.
    const { target, title, text } = message
    if (typeof target !== 'string' || typeof title !== 'string' || typeof text !== 'string') return
    const win = mainWindow()
    if (!shouldNotify(win ? { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() } : null)) return
    say(title, text, () => showMain().webContents.send('celeste:open', { kind: 'chat', target }))
  } else if (message.type === 'notice') {
    // A scheduled run failed or finished, or a schedule paused itself: said while the person may not be looking. A click opens the run, or the list of schedules.
    const { kind, target, title, text } = message
    if (typeof title !== 'string' || typeof text !== 'string') return
    const win = mainWindow()
    if (!shouldNotify(win ? { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() } : null)) return
    const opens = kind === 'schedule-paused' || typeof target !== 'string' || !target ? { kind: 'schedules', target: '' } : { kind: 'run', target }
    say(title, text, () => showMain().webContents.send('celeste:open', opens))
  } else if (message.type === 'needs-you') {
    const { kind, target, title, text } = message
    if ((kind === 'chat' || kind === 'run') && typeof target === 'string' && typeof title === 'string' && typeof text === 'string') needsYou({ kind, target, title, text })
  }
}

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

function createWindow(): BrowserWindow {
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

  ownContents.add(win.webContents)
  // Left as the small side window last time: it opens as that again.
  layout.restore(win)
  win.once('ready-to-show', () => {
    // Started with the computer: it stays in the tray until someone opens it, when there is a tray icon to open it from.
    const hide = startsHidden({ background, platform: process.platform, trayReady: background && (tray.ready || tray.ensure()) })
    background = false
    if (hide) {
      startedHidden = true
      return
    }
    win.show()
  })

  // Control ends with the last of Celeste's own windows: nothing may be left controlling the computer with no chat in view.
  win.on('closed', () => {
    if (!BrowserWindow.getAllWindows().some((w) => !desktop.owns(w))) desktop.stopAll('You closed Celeste.')
  })

  // The computer is shutting down or the person is signing out: nothing may hold that up by hiding.
  win.on('session-end', () => {
    quitting = true
  })
  win.on('focus', () => win.flashFrame(false))

  // Closing the window first saves what it holds, so the last keystrokes are not lost. Then it is hidden (Celeste stays in the tray)
  // or really closed, depending on the setting and on whether Celeste is quitting.
  win.on('close', (event) => {
    if (hidesOnClose({ platform: process.platform, closeToTray, quitting, trayReady: tray.ready || (closeToTray && !quitting && tray.ensure()) })) {
      event.preventDefault()
      void flushWindow(win).then(() => {
        // `flushWindow` marks the window as saved for good; it is only hidden, so it is not.
        flushed.delete(win)
        hideMain(win)
      })
      return
    }
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
  return win
}

/** Only the app's own windows may use the bridge. */
function fromOurWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return ownContents.has(event.sender) && !!BrowserWindow.fromWebContents(event.sender) && event.senderFrame === event.sender.mainFrame
}

// The browser pane. Every call is checked and typed in browser/service.ts.
ipcMain.handle('celeste:browser', (event, op: unknown, arg: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) browser.bind(win)
  return browser.handle(op as Parameters<BrowserService['handle']>[0], arg)
})

// The renderer tells us the theme so the native window buttons match the top bar.
ipcMain.on('celeste:theme', (event, payload: { color?: unknown; symbolColor?: unknown }) => {
  if (!fromOurWindow(event)) return
  const { color, symbolColor } = payload ?? {}
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return
  if (!HEX.test(color) || !HEX.test(symbolColor)) return
  // The viewer page matches the window's theme, on every system.
  browser.setDark(color === '#080c17')
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || isMac) return
  win.setBackgroundColor(color)
  win.setTitleBarOverlay({ color, symbolColor, height: layout.barHeight() })
})

// The window's shape: the full window or the small side window. The window asks; the main process moves and resizes it.
ipcMain.handle('celeste:layout', (event, op: unknown, patch: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('No window')
  if (op === 'get') return layout.state()
  if (op === 'toggle') return layout.set(win, { compact: !layout.state().compact })
  if (op !== 'set' || typeof patch !== 'object' || patch === null) throw new Error('Invalid request')
  const { compact, pinned } = patch as { compact?: unknown; pinned?: unknown }
  return layout.set(win, { ...(typeof compact === 'boolean' ? { compact } : {}), ...(typeof pinned === 'boolean' ? { pinned } : {}) })
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
  if (action === 'preview') {
    // Shown in a tab of the browser pane, for the chat the file belongs to.
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) browser.bind(win)
    try {
      browser.openFile(sessionId as string, found.file)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Could not open the file.' }
    }
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

// A picture from the canvas: the same dialog as a workflow file, for bytes.
ipcMain.handle('celeste:save-binary', async (event, suggestedName: unknown, data: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  if (typeof suggestedName !== 'string' || !(data instanceof ArrayBuffer) || data.byteLength > 50_000_000) throw new Error('Invalid file')
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = { defaultPath: join(app.getPath('pictures'), basename(suggestedName)) }
  const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (chosen.canceled || !chosen.filePath) return { saved: null }
  await writeFile(chosen.filePath, Buffer.from(data))
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

// Starting Celeste when the person signs in. The operating system holds the answer; see login-item.ts.
ipcMain.handle('celeste:login-item', (event, op: unknown, on: unknown) => {
  if (!fromOurWindow(event)) throw new Error('Not allowed')
  if (op === 'get') return loginItem.state()
  if (op !== 'set' || typeof on !== 'boolean') throw new Error('Invalid request')
  loginItem.set(on)
  return loginItem.state()
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
  // Starting Celeste again, from the Start menu or a shortcut, brings the window back, also from the tray.
  app.on('second-instance', () => {
    if (app.isReady()) showMain()
  })

  void app.whenReady().then(() => {
    // The id notifications and taskbar buttons are filed under: the installer's shortcuts have it, which gives them Celeste's name and icon.
    app.setAppUserModelId(APP_ID)
    // A run from the project has no shortcut, so it would be "Electron" with its atom: give the id a name and a picture.
    if (!app.isPackaged) registerDevIdentity('Celeste', APP_ICON)
    core.setApp(hearCore)
    core.start()
    // What came due while the computer slept is looked at now, not at the next half minute.
    powerMonitor.on('resume', () => core.send({ type: 'power-resume' }))
    serveAttachments()
    void browser.init()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  // Quit in order: windows save their drafts, then Core closes the database, then the app exits.
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    tray.destroy()
    desktop.stopAll('Celeste closed.')
    void Promise.all(BrowserWindow.getAllWindows().map(flushWindow))
      .then(() => browser.shutdown())
      .then(() => core.shutdown())
      .finally(() => app.quit())
  })
}
