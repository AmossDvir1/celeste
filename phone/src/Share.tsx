import { useEffect } from 'react'
import { create } from 'zustand'
import { Cast, Square } from 'lucide-react'
import type { PhoneLinkAnswer, PhoneLinkInfo, PhoneLinkOffer } from '@shared/phone'
import { PUBLIC_ICE } from '@shared/signal'
import { screen } from './native'
import { useApp } from './store'

/*
 * This phone's screen, live, on the computer (docs/PHONE_PLAN.md 7.3). A button in the "assistant is using this phone" row of a
 * chat. Android asks the person in its own dialog every time; the computer shows the picture in a small panel and can stop it,
 * and so can the person, here or from Android's own chip. Nothing on the computer can touch the phone through it.
 */

interface ShareState {
  state: 'idle' | 'starting' | 'sharing'
  start: () => Promise<void>
  stop: () => void
}

export const useShare = create<ShareState>((set, get) => ({
  state: 'idle',

  start: async () => {
    const { link, say } = useApp.getState()
    if (get().state !== 'idle') return
    if (!link) return say('Not connected to the computer.')
    set({ state: 'starting' })
    try {
      const info = await link.call<PhoneLinkInfo>('phone.linkInfo').catch(() => ({ servers: null }) as PhoneLinkInfo)
      // Android's dialog appears here; the offer comes back when the person has said yes.
      const { sdp } = await screen.start(info.servers && info.servers.length ? info.servers : PUBLIC_ICE)
      try {
        const answer = await link.call<PhoneLinkAnswer>('phone.view', { sdp } satisfies PhoneLinkOffer)
        await screen.answer(answer.sdp)
        set({ state: 'sharing' })
      } catch (err) {
        await screen.stop()
        throw err
      }
    } catch (err) {
      set({ state: 'idle' })
      say(err instanceof Error ? err.message : 'The screen could not be shown on the computer.')
    }
  },

  stop: () => {
    const link = useApp.getState().link
    set({ state: 'idle' })
    void screen.stop()
    void link?.call('phone.viewStop').catch(() => undefined)
  }
}))

/** The button in the chat's row. Also keeps the state right when the capture ends by itself. */
export function ShareButton() {
  const state = useShare((s) => s.state)
  useEffect(
    () =>
      screen.onEnded((why) => {
        useShare.setState({ state: 'idle' })
        void useApp.getState().link?.call('phone.viewStop').catch(() => undefined)
        if (why) useApp.getState().say(why)
      }),
    []
  )
  if (state === 'sharing') {
    return (
      <button className="btn" aria-label="Stop showing this screen on the computer" onClick={() => useShare.getState().stop()}>
        <Square size={14} /> Stop showing
      </button>
    )
  }
  return (
    <button className="btn" aria-label="Show this screen on the computer" aria-busy={state === 'starting'} disabled={state === 'starting'} onClick={() => void useShare.getState().start()}>
      <Cast size={15} /> {state === 'starting' ? 'Asking…' : 'Show on computer'}
    </button>
  )
}
