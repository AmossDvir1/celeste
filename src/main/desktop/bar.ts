import { BrowserWindow, screen } from 'electron'
import { DESKTOP_HOTKEY, type DesktopBarState } from '@shared/desktop'

/*
 * The control bar and the border: what the person sees for as long as the assistant has control. Both are Celeste's own windows, so the
 * assistant cannot click them (the guard in `service.ts`), and both are left out of the screenshots it gets. The bar has no preload and no
 * Node: its buttons change the page's title, and the main process listens for that.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Celeste desktop control</title>
<style>
  html,body{margin:0;height:100%;background:#10162a;color:#e7ecf8;font:13px/1.45 "Segoe UI",system-ui,sans-serif;overflow:hidden;user-select:none}
  .card{box-sizing:border-box;height:100%;padding:10px 14px;border:2px solid #f0a23b;border-radius:12px;display:flex;flex-direction:column;gap:6px}
  .top{display:flex;align-items:center;gap:10px}
  .dot{width:10px;height:10px;border-radius:50%;background:#f0a23b;box-shadow:0 0 0 0 rgba(240,162,59,.7);animation:p 1.6s infinite}
  @keyframes p{70%{box-shadow:0 0 0 8px rgba(240,162,59,0)}100%{box-shadow:0 0 0 0 rgba(240,162,59,0)}}
  .title{font-weight:600;flex:1}
  .left{color:#aeb8d1;font-variant-numeric:tabular-nums}
  button{font:inherit;border:1px solid #3a4565;background:#1b2340;color:#e7ecf8;border-radius:8px;padding:4px 10px;cursor:pointer}
  button.stop{background:#d64545;border-color:#d64545;color:#fff;font-weight:600}
  button:hover{filter:brightness(1.15)}
  .log{color:#aeb8d1;font-size:12px;min-height:3.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .log div{overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<div class="card" role="region" aria-label="Celeste is controlling this computer">
  <div class="top"><span class="dot"></span><span class="title">Celeste is controlling this computer</span><span class="left" id="left"></span></div>
  <div class="top"><button id="more">+15 min</button><span style="flex:1"></span><button class="stop" id="stop">Stop (${DESKTOP_HOTKEY.replace('Control', 'Ctrl')})</button></div>
  <div class="log" id="log"></div>
</div>
<script>
  let until = 0
  const left = document.getElementById('left'), log = document.getElementById('log')
  const tick = () => { const s = Math.max(0, Math.round((until - Date.now()) / 1000)); left.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' left' }
  setInterval(tick, 1000)
  window.setState = (state) => {
    until = state.until; tick(); log.textContent = ''
    for (const line of state.lines) { const d = document.createElement('div'); d.textContent = line; log.appendChild(d) }
  }
  const press = (what) => { document.title = what + ':' + Date.now() }
  document.getElementById('stop').onclick = () => press('stop')
  document.getElementById('more').onclick = () => press('extend')
</script></body></html>`

const BORDER = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden}
  div{box-sizing:border-box;position:fixed;inset:0;border:5px solid #f0a23b;box-shadow:inset 0 0 24px rgba(240,162,59,.55)}
</style></head><body><div></div></body></html>`

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

export class ControlBar {
  private bar: BrowserWindow | null = null
  private border: BrowserWindow | null = null

  constructor(private readonly handlers: { onStop(): void; onExtend(): void }) {}

  /** The bar, for the guard: its area is as untouchable as the rest of Celeste. */
  windows(): BrowserWindow[] {
    return this.bar && !this.bar.isDestroyed() ? [this.bar] : []
  }

  /** The border, which lets every click through and so must not count as a Celeste window that blocks them. */
  isBorder(win: BrowserWindow): boolean {
    return win === this.border
  }

  async show(state: DesktopBarState): Promise<void> {
    if (!this.bar || this.bar.isDestroyed()) await this.open()
    await this.bar?.webContents.executeJavaScript(`window.setState(${JSON.stringify(state)})`)
  }

  hide(): void {
    for (const win of [this.bar, this.border]) if (win && !win.isDestroyed()) win.destroy()
    this.bar = null
    this.border = null
  }

  private async open(): Promise<void> {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    const common = { frame: false, show: false, focusable: false, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, hasShadow: false } as const
    const web = { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } as const

    const border = new BrowserWindow({ ...common, x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, transparent: true, webPreferences: web })
    border.setIgnoreMouseEvents(true)
    border.setAlwaysOnTop(true, 'screen-saver')
    border.setContentProtection(true)
    await border.loadURL(dataUrl(BORDER))
    border.showInactive()
    this.border = border

    const width = 520
    const bar = new BrowserWindow({ ...common, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 12, width, height: 132, webPreferences: web })
    bar.setAlwaysOnTop(true, 'screen-saver')
    bar.setContentProtection(true)
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    bar.webContents.on('will-navigate', (event) => event.preventDefault())
    bar.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      if (title.startsWith('stop:')) this.handlers.onStop()
      else if (title.startsWith('extend:')) this.handlers.onExtend()
    })
    await bar.loadURL(dataUrl(PAGE))
    bar.showInactive()
    this.bar = bar
  }
}
