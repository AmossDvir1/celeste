import { join } from 'node:path'
import { app, BrowserWindow, dialog, MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import type { DesktopService } from './desktop/service'
import { secrets } from './secrets'

// Core may ask for a device's password or key passphrase, the API key of a vendor that takes one, the secret values of a tool (MCP server) the person added,
// and the phone bridge's own key pair.
const DEVICE_SECRET = /^(device\.dev-[0-9a-f-]{36}\.(password|passphrase)|vendor\.(claude|openai|gemini)\.key|mcp\.mcp-[0-9a-f]{8}\.(env|header)\.[A-Za-z0-9_-]{1,40}|phone\.key)$/
/** The only secret Core makes and stores itself: the key pair phones are paired with. */
const CORE_STORES = 'phone.key'

/**
 * The Core process: database, sessions and the assistant, in a utility process of its own. Windows talk to it
 * directly over a message port, so conversations stream without passing through the main process.
 */
export class CoreProcess {
  private child: UtilityProcess | null = null
  private shuttingDown = false
  private exits: number[] = []
  private desktop: DesktopService | null = null

  /** The real computer, for Core's desktop tools. Core asks it by message; it asks Core to stop by message. */
  setDesktop(desktop: DesktopService): void {
    this.desktop = desktop
  }

  /** A message to Core that is not a request from a window. */
  send(message: unknown): void {
    this.child?.postMessage(message)
  }

  start(): void {
    const child = utilityProcess.fork(join(__dirname, 'core.js'), [], {
      serviceName: 'Celeste Core',
      env: { ...process.env, CELESTE_DATA_DIR: app.getPath('userData'), CELESTE_VERSION: app.getVersion() }
    })
    this.child = child

    child.on('message', (message: { type?: string; message?: string; id?: number; name?: string; method?: string; arg?: unknown }) => {
      if (message?.type === 'desktop-call' && typeof message.id === 'number' && typeof message.method === 'string') {
        const id = message.id
        const desktop = this.desktop
        if (!desktop) {
          child.postMessage({ type: 'desktop-reply', id, ok: false, error: 'Desktop control is not available.' })
          return
        }
        desktop.handle(message.method, message.arg).then(
          (result) => child.postMessage({ type: 'desktop-reply', id, ok: true, result }),
          (err: unknown) => child.postMessage({ type: 'desktop-reply', id, ok: false, error: err instanceof Error ? err.message : String(err) })
        )
        return
      }
      if (message?.type === 'secret-request' && typeof message.id === 'number') {
        const allowed = typeof message.name === 'string' && DEVICE_SECRET.test(message.name)
        child.postMessage({ type: 'secret-reply', id: message.id, value: allowed ? secrets.get(message.name as string) : null })
        return
      }
      if (message?.type === 'secret-store' && typeof message.id === 'number') {
        const m = message as { id: number; name?: unknown; value?: unknown }
        let ok = false
        if (m.name === CORE_STORES && typeof m.value === 'string') {
          try {
            secrets.set(m.name, m.value)
            ok = true
          } catch {
            // No secure store on this computer: Core keeps the key where it was.
          }
        }
        child.postMessage({ type: 'secret-stored', id: m.id, value: ok })
        return
      }
      if (message?.type !== 'fatal') return
      // Core could not open the data, usually because it was saved by a newer Celeste. Nothing is changed.
      this.shuttingDown = true
      dialog.showErrorBox('Celeste cannot open its data', message.message ?? 'Unknown error.')
      app.exit(1)
    })

    child.on('exit', (code) => {
      // Whatever Core had granted is gone with it: take the bar down, so nothing says control is on when it is not.
      this.desktop?.reset()
      if (this.shuttingDown) return
      console.error(`[main] Core exited unexpectedly (code ${code})`)
      const now = Date.now()
      this.exits = [...this.exits.filter((t) => now - t < 60_000), now]
      if (this.exits.length > 3) {
        dialog.showErrorBox('Celeste stopped', 'Its storage process keeps stopping. Please restart Celeste.')
        app.exit(1)
        return
      }
      // Everything in the log is safe. Start again and let every window reconnect.
      setTimeout(() => {
        this.start()
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.reload())
      }, 300)
    })
  }

  /** Gives a window its own line to Core. Its end of the port arrives in the preload script. */
  connect(webContents: WebContents): void {
    const { port1, port2 } = new MessageChannelMain()
    this.child?.postMessage({ type: 'connect' }, [port1])
    webContents.postMessage('celeste:port', null, [port2])
  }

  /** Lets Core close the database cleanly. Gives up after a few seconds. */
  shutdown(): Promise<void> {
    this.shuttingDown = true
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        child.kill()
        finish()
      }, 3000)
      child.on('message', (m: { type?: string }) => {
        if (m?.type === 'closed') {
          child.kill()
          finish()
        }
      })
      child.on('exit', finish)
      child.postMessage({ type: 'shutdown' })
    })
  }
}
