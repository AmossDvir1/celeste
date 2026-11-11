import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Square } from 'lucide-react'
import type { IceServer, PhoneLinkAnswer, PhoneLinkInfo, PhoneLinkOffer } from '@shared/phone'
import { PUBLIC_ICE } from '@shared/signal'
import { useApp } from './store'
import { Shimmer } from './ui'

/*
 * The computer's screen, live, while the assistant uses it (docs/PHONE_PLAN.md 7.3). The phone makes a WebRTC offer that only
 * wants video, the computer answers with its screen (when this phone was allowed to watch, in Celeste's Settings on the
 * computer), and the video plays here. Nothing can be tapped through it: watching only. It ends with the sheet, with Stop on
 * the computer, or when the assistant is done.
 */

type State = { phase: 'asking' } | { phase: 'connecting' } | { phase: 'live' } | { phase: 'failed'; message: string }

const gathered = (pc: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const t = setTimeout(resolve, 5000)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') (clearTimeout(t), resolve())
    }
  })

export function WatchScreen({ onClose }: { onClose: () => void }) {
  const link = useApp((s) => s.link)
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<State>({ phase: 'asking' })
  const [leaving, setLeaving] = useState(false)
  const close = () => {
    setLeaving(true)
    setTimeout(onClose, 200)
  }

  useEffect(() => {
    if (!link) return setState({ phase: 'failed', message: 'Not connected to the computer.' })
    let live = true
    let pc: RTCPeerConnection | null = null
    void (async () => {
      try {
        const info = await link.call<PhoneLinkInfo>('phone.linkInfo').catch(() => ({ servers: null }) as PhoneLinkInfo)
        const servers: IceServer[] = info.servers && info.servers.length ? info.servers : PUBLIC_ICE
        pc = new RTCPeerConnection({ iceServers: servers })
        pc.addTransceiver('video', { direction: 'recvonly' })
        pc.ontrack = (e) => {
          if (!video.current) return
          video.current.srcObject = e.streams[0] ?? new MediaStream([e.track])
          void video.current.play().catch(() => undefined)
          if (live) setState({ phase: 'live' })
        }
        pc.onconnectionstatechange = () => {
          if (!live || !pc) return
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setState({ phase: 'failed', message: 'The picture was lost.' })
        }
        await pc.setLocalDescription(await pc.createOffer())
        await gathered(pc)
        const sdp = pc.localDescription?.sdp
        if (!sdp || !live) return
        const answer = await link.call<PhoneLinkAnswer>('phone.watch', { sdp } satisfies PhoneLinkOffer)
        if (!live) return
        setState({ phase: 'connecting' })
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      } catch (err) {
        if (live) setState({ phase: 'failed', message: err instanceof Error ? err.message : 'The screen could not be shown.' })
      }
    })()
    return () => {
      live = false
      pc?.close()
      void link.call('phone.watchStop').catch(() => undefined)
    }
  }, [link])

  return createPortal(
    <div className={`card-layer${leaving ? ' out' : ''}`}>
      <div className="scrim" onClick={close} />
      <div className="sheet tall" role="dialog" aria-label="The computer’s screen">
        <div className="handle" />
        <div className="overline" style={{ fontSize: 10 }}>
          Live view
        </div>
        <h1 className="h-l" style={{ fontSize: 20, margin: '2px 0 12px' }}>
          The computer’s screen
        </h1>
        <div className="watchbox">
          <video ref={video} className="watchvid" muted playsInline autoPlay />
          {state.phase !== 'live' && (
            <div className="watchnote">
              {state.phase === 'failed' ? state.message : <Shimmer>{state.phase === 'asking' ? 'Asking the computer' : 'Connecting'}</Shimmer>}
            </div>
          )}
        </div>
        <p className="small faint" style={{ margin: '10px 2px 0' }}>
          <Eye size={12} style={{ verticalAlign: '-1px' }} /> Watching only. It ends when Celeste stops using the computer, or when you close this.
        </p>
        <button className="btn primary block" style={{ marginTop: 14 }} onClick={close}>
          <Square size={14} /> Stop watching
        </button>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body
  )
}
