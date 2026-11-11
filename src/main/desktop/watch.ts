import { BrowserWindow, desktopCapturer, screen, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * The computer's screen, live, on a phone (docs/PHONE_PLAN.md 7.3): while the assistant is using the computer, a paired phone
 * the person allowed may watch, as video. A hidden window runs Chromium's own WebRTC: it captures the main screen and answers
 * the phone's offer (the offer and the answer travel as sealed calls through the bridge). This file only does that; whether
 * the phone may watch, and for how long, is decided before it is asked (the bridge: a phone the person allowed; the grant: only
 * while the assistant has the computer).
 *
 * What it will not show: only the main screen is captured (never one app, whose pixels could not be told apart from the rest),
 * Celeste's own windows are left out by the grant (their content protection), and while a window of a program on the never
 * list is on the screen the video goes black, checked four times a second. A window that opens and closes between two checks
 * can show for a fraction of a second: that is the limit of video, which a screenshot's redaction does not have.
 */

export interface WatchGate {
  /** Why watching cannot start now, or null. */
  ready(): string | null
  /** True while a window the person said is never to be shown is on the screen. */
  blocked(): boolean
}

interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

interface View {
  win: BrowserWindow
  timer: ReturnType<typeof setInterval>
}

const CHECK_MS = 250

/** The page's side, run in the hidden window: capture the screen and answer the offer, with the addresses gathered. */
const script = (offer: string, servers: IceServer[]) => `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false })
  window.__stream = stream
  const track = stream.getVideoTracks()[0]
  // Movement matters more than sharpness: a cursor and windows moving, not a still page.
  track.contentHint = 'motion'
  const pc = new RTCPeerConnection({ iceServers: ${JSON.stringify(servers)} })
  window.__pc = pc
  pc.addTrack(track, stream)
  await pc.setRemoteDescription({ type: 'offer', sdp: ${JSON.stringify(offer)} })
  await pc.setLocalDescription(await pc.createAnswer())
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const t = setTimeout(resolve, 5000)
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve() } }
  })
  return pc.localDescription.sdp
})()`

const page = '<!doctype html><meta charset="utf-8"><title>Celeste live view</title>'

export class WatchService {
  private readonly views = new Map<string, View>()
  private pageFile: string | null = null

  constructor(private readonly gate: WatchGate) {}

  /** A secure page (a file) for the hidden window: `getDisplayMedia` needs a secure context. */
  private file(): string {
    if (!this.pageFile) {
      const dir = join(tmpdir(), 'celeste-watch')
      mkdirSync(dir, { recursive: true })
      this.pageFile = join(dir, 'view.html')
      writeFileSync(this.pageFile, page)
    }
    return this.pageFile
  }

  /** Answers a phone's offer with the screen as video. Throws a sentence fit for the person when it cannot. */
  async start(phoneId: string, offer: string, servers: IceServer[]): Promise<string> {
    const why = this.gate.ready()
    if (why) throw new Error(why)
    this.stop(phoneId)
    const ses = session.fromPartition(`celeste-watch-${randomBytes(6).toString('hex')}`)
    // The only screen this window is ever given is the main one.
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const primary = String(screen.getPrimaryDisplay().id)
        desktopCapturer.getSources({ types: ['screen'] }).then(
          (sources) => {
            const source = sources.find((s) => s.display_id === primary) ?? sources[0]
            callback(source ? { video: source } : {})
          },
          () => callback({})
        )
      },
      { useSystemPicker: false }
    )
    const win = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    let paused = false
    const timer = setInterval(() => {
      if (win.isDestroyed()) return
      const blocked = this.gate.blocked()
      if (blocked === paused) return
      paused = blocked
      void win.webContents.executeJavaScript(`window.__stream && window.__stream.getVideoTracks().forEach((t) => (t.enabled = ${!blocked}))`).catch(() => undefined)
    }, CHECK_MS)
    timer.unref?.()
    const view: View = { win, timer }
    this.views.set(phoneId, view)
    win.on('closed', () => {
      clearInterval(timer)
      if (this.views.get(phoneId) === view) this.views.delete(phoneId)
    })
    try {
      await win.loadFile(this.file())
      // Black from the first frame if a never-listed window is already showing.
      if (this.gate.blocked()) {
        paused = true
      }
      const answer = (await win.webContents.executeJavaScript(script(offer, servers), true)) as unknown
      if (typeof answer !== 'string' || !answer) throw new Error('The screen could not be shared.')
      if (paused) await win.webContents.executeJavaScript('window.__stream.getVideoTracks().forEach((t) => (t.enabled = false))')
      return answer
    } catch (err) {
      this.stop(phoneId)
      throw new Error(err instanceof Error && /Permission|NotAllowed|NotReadable/i.test(err.message) ? 'Windows would not let Celeste share the screen.' : 'The screen could not be shared.')
    }
  }

  /** Ends one phone's view, or every view. */
  stop(phoneId?: string): void {
    for (const [id, view] of [...this.views]) {
      if (phoneId !== undefined && id !== phoneId) continue
      this.views.delete(id)
      clearInterval(view.timer)
      if (!view.win.isDestroyed()) view.win.destroy()
    }
  }

  get count(): number {
    return this.views.size
  }
}
