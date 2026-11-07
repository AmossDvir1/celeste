import { create } from 'zustand'
import type { AttachmentInfo } from '@shared/agent'
import type { DraftState } from '@shared/api'
import { core } from '@/api'

/**
 * Unsent text and attachments, one draft per place you can type: each session, and the home screen of each
 * mode (`home:chat`, `home:develop`). Drafts are saved shortly after you stop typing, so a restart brings
 * back what was half written.
 */
interface DraftsState {
  drafts: Record<string, DraftState>
  init: (drafts: Record<string, DraftState>) => void
  setText: (key: string, text: string) => void
  setAttachments: (key: string, update: (items: AttachmentInfo[]) => AttachmentInfo[]) => void
  /** After a send: forget the draft at once. The files now belong to the message. */
  clear: (key: string) => void
  /** Saves anything still waiting. Called before the window closes. */
  flush: () => Promise<void>
}

const SAVE_DELAY_MS = 400
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Set<Promise<unknown>>()

export const useDrafts = create<DraftsState>((set, get) => {
  const write = (key: string) => {
    clearTimeout(timers.get(key))
    timers.delete(key)
    const draft = get().drafts[key]
    const done = core.call('drafts.set', key, draft ?? null).catch(() => undefined)
    inFlight.add(done)
    void done.finally(() => inFlight.delete(done))
  }
  const schedule = (key: string) => {
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => write(key), SAVE_DELAY_MS))
  }
  const change = (key: string, fn: (d: DraftState) => DraftState) => {
    set((st) => {
      const next = fn(st.drafts[key] ?? { text: '', attachments: [] })
      const { [key]: _old, ...rest } = st.drafts
      return { drafts: next.text === '' && next.attachments.length === 0 ? rest : { ...rest, [key]: next } }
    })
    schedule(key)
  }

  return {
    drafts: {},
    init: (drafts) => set({ drafts }),
    setText: (key, text) => change(key, (d) => ({ ...d, text })),
    setAttachments: (key, update) => change(key, (d) => ({ ...d, attachments: update(d.attachments) })),
    clear: (key) => {
      set((st) => {
        const { [key]: _gone, ...rest } = st.drafts
        return { drafts: rest }
      })
      write(key)
    },
    flush: async () => {
      for (const key of [...timers.keys()]) write(key)
      await Promise.all([...inFlight])
    }
  }
})
