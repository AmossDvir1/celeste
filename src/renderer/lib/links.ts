import { isLocalUrl } from '@shared/browser'
import { browserCall, useBrowser } from '@/stores/browser'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'

/** The chat whose pane a link would open in, or null when none is open. */
function activeChat(): string | null {
  const { mode } = useUi.getState()
  return mode === 'workflows' ? null : useSessions.getState().active[mode]
}

/** Opens an address in Celeste's browser, beside the chat that is open. False when there is no chat to put it in. */
export async function openInPane(url: string): Promise<boolean> {
  const chatId = activeChat()
  if (!chatId || !window.celeste) return false
  const tab = await browserCall('open', { chatId, url }).catch(() => null)
  if (!tab) return false
  useUi.getState().setRight('browser')
  return true
}

/**
 * Opens a file in a tab of the browser pane, beside the chat that is open: Chromium shows PDF, images, video and web pages itself, and
 * the viewer shows Office documents, Markdown, tables and more (docs/FILE_VIEWER_PLAN.md). Says why in a message when it cannot.
 */
export async function openFileInPane(path: string): Promise<boolean> {
  const chatId = activeChat()
  if (!chatId || !window.celeste) return false
  try {
    await browserCall('openFile', { chatId, path })
    useUi.getState().revealBrowser()
    return true
  } catch (e) {
    useUi.getState().pushToast({ text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not open the file.' })
    return false
  }
}

export const openInMyBrowser = (url: string): Promise<void> => browserCall('openExternal', { url }).catch(() => undefined)

/**
 * A web link in a chat was clicked. A page on this computer always opens in Celeste's browser, and Ctrl or Cmd always opens the person's own;
 * otherwise the choice made in the browser's menu applies, and the first time the person is asked.
 */
export async function openLink(url: string, e?: { ctrlKey?: boolean; metaKey?: boolean }): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  if (!window.celeste) {
    window.open(url, '_blank', 'noopener')
    return
  }
  if (e?.ctrlKey || e?.metaKey) return openInMyBrowser(url)
  if (isLocalUrl(url)) {
    if (!(await openInPane(url))) await openInMyBrowser(url)
    return
  }
  const where = useBrowser.getState().prefs.linksIn
  if (where === 'system') return openInMyBrowser(url)
  if (where === 'celeste') {
    if (!(await openInPane(url))) await openInMyBrowser(url)
    return
  }
  if (!activeChat()) return openInMyBrowser(url)
  useUi.getState().setPendingLink(url)
}
