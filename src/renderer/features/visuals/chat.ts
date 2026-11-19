import { useEffect, useState } from 'react'
import type { SessionMode } from '@shared/agent'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'

/** The chat a picture in an answer belongs to, as far as the window knows: the one that is open. Null in a window with none (the workflows screen). */
export function chatNow(): { id: string; mode: SessionMode } | null {
  const { mode } = useUi.getState()
  if (mode === 'workflows') return null
  const id = useSessions.getState().active[mode]
  return id ? { id, mode } : null
}

/** Whether the open chat is still working, so a block that has not been closed yet may still be arriving. */
export function useChatWorking(): boolean {
  return useSessions((s) => {
    const { mode } = useUi.getState()
    if (mode === 'workflows') return false
    const id = s.active[mode]
    return !!id && s.sessions[id]?.status !== 'idle'
  })
}

/** The theme in use ('dark' or 'light'), redrawn when the person changes it, so a picture can be drawn again in the other colours. */
export function useThemeName(): string {
  const read = () => document.documentElement.dataset['theme'] ?? 'dark'
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watch.disconnect()
  }, [])
  return theme
}

/** The value of one of the theme's colours: the same function the phone uses (colors.ts). */
export { themeColor } from './colors'
