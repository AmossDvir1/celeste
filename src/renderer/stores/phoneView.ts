import { create } from 'zustand'
import type { CorePush } from '@shared/api'
import { core } from '@/api'

/*
 * A phone's screen, live, on this computer (docs/PHONE_PLAN.md 7.3). The person taps "Show on computer" on the phone and says yes
 * in Android's own dialog; the phone's offer comes here (through Core, from a sealed call) as a push, this window answers it as a
 * WebRTC peer that only receives, and the video plays in a small panel. Nothing here can touch the phone: watching only, and Stop.
 */

export interface PhoneView {
  phoneId: string
  name: string
  stream: MediaStream | null
  state: 'connecting' | 'live' | 'failed'
}

interface PhoneViewState {
  views: Record<string, PhoneView>
  applyPush: (push: CorePush) => void
  /** The person pressed Stop here: the phone is told to stop sharing, and the view closes. */
  stop: (phoneId: string) => void
}

const peers = new Map<string, RTCPeerConnection>()

const gathered = (pc: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const t = setTimeout(resolve, 5000)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t)
        resolve()
      }
    }
  })

export const usePhoneView = create<PhoneViewState>((set) => {
  const drop = (phoneId: string) => {
    peers.get(phoneId)?.close()
    peers.delete(phoneId)
    set((s) => {
      const { [phoneId]: _gone, ...rest } = s.views
      return { views: rest }
    })
  }
  const patch = (phoneId: string, change: Partial<PhoneView>) => set((s) => (s.views[phoneId] ? { views: { ...s.views, [phoneId]: { ...(s.views[phoneId] as PhoneView), ...change } } } : s))

  return {
    views: {},

    applyPush: (push) => {
      if (push.type === 'phoneViewEnd') return drop(push.phoneId)
      if (push.type !== 'phoneView') return
      const { requestId, phoneId, name, offer, servers } = push
      // One view per phone: a new one replaces the old.
      drop(phoneId)
      const pc = new RTCPeerConnection({ iceServers: servers })
      peers.set(phoneId, pc)
      set((s) => ({ views: { ...s.views, [phoneId]: { phoneId, name, stream: null, state: 'connecting' } } }))
      pc.ontrack = (e) => patch(phoneId, { stream: e.streams[0] ?? new MediaStream([e.track]), state: 'live' })
      pc.onconnectionstatechange = () => {
        if (peers.get(phoneId) !== pc) return
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') patch(phoneId, { state: 'failed' })
      }
      void (async () => {
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: offer })
          await pc.setLocalDescription(await pc.createAnswer())
          await gathered(pc)
          await core.call('phone.viewAnswer', requestId, pc.localDescription?.sdp ?? null)
        } catch {
          drop(phoneId)
          void core.call('phone.viewAnswer', requestId, null).catch(() => undefined)
        }
      })()
    },

    stop: (phoneId) => {
      drop(phoneId)
      void core.call('phone.viewStop', phoneId).catch(() => undefined)
    }
  }
})
