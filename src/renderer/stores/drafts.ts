import { create } from 'zustand'
import type { AttachmentInfo, ContextRef } from '@shared/agent'
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
  /** Adds files or folders of the project to the draft (each once, at most 20). Returns how many did not fit. */
  addContext: (key: string, refs: ContextRef[]) => number
  removeContext: (key: string, path: string) => void
  /** After a send: forget the draft at once. The files now belong to the message. */
  clear: (key: string) => void
  /** Saves anything still waiting. Called before the window closes. */
  flush: () => Promise<void>
}

/** A message can carry this many files and folders of the project (Core refuses more). */
const MAX_CONTEXT = 20
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
      return { drafts: next.text === '' && next.attachments.length === 0 && !next.context?.length ? rest : { ...rest, [key]: next } }
    })
    schedule(key)
  }

  return {
    drafts: {},
    init: (drafts) => set({ drafts }),
    setText: (key, text) => change(key, (d) => ({ ...d, text })),
    setAttachments: (key, update) => change(key, (d) => ({ ...d, attachments: update(d.attachments) })),
    addContext: (key, refs) => {
      const have = get().drafts[key]?.context ?? []
      const fresh = refs.filter((r, i) => !have.some((h) => h.path === r.path) && refs.findIndex((x) => x.path === r.path) === i)
      const room = Math.max(0, MAX_CONTEXT - have.length)
      if (fresh.length > 0 && room > 0) change(key, (d) => ({ ...d, context: [...(d.context ?? []), ...fresh.slice(0, room)] }))
      return Math.max(0, fresh.length - room)
    },
    removeContext: (key, path) => change(key, (d) => ({ ...d, context: (d.context ?? []).filter((c) => c.path !== path) })),
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
