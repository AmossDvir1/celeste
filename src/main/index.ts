import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'

const DEV_URL = process.env['ELECTRON_RENDERER_URL']
// Test scripts open a specific view, for example CELESTE_QUERY="bare=chat".
const START_QUERY = process.env['CELESTE_QUERY'] ?? ''
const isMac = process.platform === 'darwin'
const HEX = /^#[0-9a-fA-F]{6}$/

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

// The renderer tells us the theme so the native window buttons match the top bar.
ipcMain.on('celeste:theme', (event, payload: { color?: unknown; symbolColor?: unknown }) => {
  const { color, symbolColor } = payload ?? {}
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return
  if (!HEX.test(color) || !HEX.test(symbolColor)) return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || isMac) return
  win.setBackgroundColor(color)
  win.setTitleBarOverlay({ color, symbolColor, height: 56 })
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
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}
