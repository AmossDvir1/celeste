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
 * What it will not show: only the main screen is captured, Celeste's own windows are left out by the grant (their content
 * protection), and while a window of a program on the never list is on the screen the video goes black, checked four times a
 * second. When the assistant has only one app or one window, the video is drawn through a mask: only the windows it may use are
 * copied from the screen, and everything else (the desktop, other programs, whatever is in front of them) is black. The mask is
 * refreshed ten times a second. A window that opens, closes or moves between two checks can show for a fraction of a second:
 * that is the limit of video, which a screenshot's redaction does not have.
 */

/** What the video may show, in screen pixels: the windows on the main screen from bottom to top, each shown or painted black. */
export interface WatchMask {
  /** The main screen. */
  screen: { x: number; y: number; width: number; height: number }
  layers: { x: number; y: number; width: number; height: number; show: boolean }[]
}

export interface WatchGate {
  /** Why watching cannot start now, or null. */
  ready(): string | null
  /** True while a window the person said is never to be shown is on the screen. */
  blocked(): boolean
  /** What the video may show when the assistant has less than the whole screen, or null when it has all of it. Never throws: when it cannot tell, nothing is shown. */
  mask(): WatchMask | null
}

interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

interface View {
  win: BrowserWindow
  timer: ReturnType<typeof setInterval>
  maskTimer: ReturnType<typeof setInterval> | null
}

const CHECK_MS = 250
const MASK_MS = 100
/** Shorter than the 30 s the bridge waits, so the person gets this sentence and not a silence. */
const START_MS = 20_000

/**
 * The page's side, run in the hidden window: capture the screen and answer the offer, with the addresses gathered. With a mask, the
 * track that is sent is a canvas that starts black and copies from the screen only the windows the mask shows.
 */
const script = (offer: string, servers: IceServer[], mask: WatchMask | null) => `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false })
  window.__stream = stream
  let track = stream.getVideoTracks()[0]
  if (${JSON.stringify(mask !== null)}) {
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    // A screen that is not changing sends no frames, so play() may not settle for a while: never wait for it.
    video.play().catch(() => undefined)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    window.__mask = ${JSON.stringify(mask)}
    canvas.width = Math.max(2, Math.min(1920, window.__mask.screen.width))
    canvas.height = Math.max(2, Math.round(canvas.width * window.__mask.screen.height / window.__mask.screen.width))
    const draw = () => {
      const vw = video.videoWidth || canvas.width, vh = video.videoHeight || canvas.height
      if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh }
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, vw, vh)
      const m = window.__mask
      if (!m || !video.videoWidth) return
      const sx = vw / m.screen.width, sy = vh / m.screen.height
      for (const l of m.layers) {
        const x = Math.max(0, Math.floor((l.x - m.screen.x) * sx)), y = Math.max(0, Math.floor((l.y - m.screen.y) * sy))
        const w = Math.min(vw, Math.ceil((l.x + l.width - m.screen.x) * sx)) - x, h = Math.min(vh, Math.ceil((l.y + l.height - m.screen.y) * sy)) - y
        if (w <= 0 || h <= 0) continue
        if (l.show) ctx.drawImage(video, x, y, w, h, x, y, w, h)
        else ctx.fillRect(x, y, w, h)
      }
    }
    draw()
    window.__draw = setInterval(draw, 33)
    track = canvas.captureStream(30).getVideoTracks()[0]
  }
  window.__track = track
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
    const first = this.gate.mask()
    const masked = first !== null
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
    let lastMask = ''
    const push = (js: string) => void win.webContents.executeJavaScript(js).catch(() => undefined)
    const tick = () => {
      if (win.isDestroyed()) return
      const blocked = this.gate.blocked()
      if (blocked !== paused) {
        paused = blocked
        push(`window.__stream && window.__stream.getVideoTracks().forEach((t) => (t.enabled = ${!blocked}))`)
      }
    }
    const timer = setInterval(tick, CHECK_MS)
    timer.unref?.()
    // The mask follows the windows; a mask that has not changed is not sent again.
    const maskTimer = masked
      ? setInterval(() => {
          if (win.isDestroyed()) return
          const json = JSON.stringify(this.gate.mask())
          if (json === lastMask) return
          lastMask = json
          push(`window.__mask = ${json}`)
        }, MASK_MS)
      : null
    maskTimer?.unref?.()
    const view: View = { win, timer, maskTimer }
    this.views.set(phoneId, view)
    win.on('closed', () => {
      clearInterval(timer)
      if (maskTimer) clearInterval(maskTimer)
      if (this.views.get(phoneId) === view) this.views.delete(phoneId)
    })
    try {
      await win.loadFile(this.file())
      // Black from the first frame if a never-listed window is already showing.
      if (this.gate.blocked()) {
        paused = true
      }
      const run = win.webContents.executeJavaScript(script(offer, servers, first), true) as Promise<unknown>
      let giveUp: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_resolve, reject) => {
        giveUp = setTimeout(() => reject(new Error('The screen did not start in time.')), START_MS)
      })
      const answer = await Promise.race([run, late]).finally(() => clearTimeout(giveUp))
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
      if (view.maskTimer) clearInterval(view.maskTimer)
      if (!view.win.isDestroyed()) view.win.destroy()
    }
  }

  get count(): number {
    return this.views.size
  }
}
