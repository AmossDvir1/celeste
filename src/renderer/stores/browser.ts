import { create } from 'zustand'
import { useSessions } from './sessions'
import { useUi } from './ui'
import { EMPTY_BROWSER_STATE, type BrowserCalls, type BrowserOp, type BrowserState } from '@shared/browser'

/** Asks the main process, which owns the pages, to do something. */
export function browserCall<O extends BrowserOp>(op: O, arg: BrowserCalls[O]['arg']): Promise<BrowserCalls[O]['result']> {
  if (!window.celeste) return Promise.reject(new Error('The browser is part of Celeste’s desktop app.'))
  return window.celeste.browser.call(op, arg)
}

/** What the main process last said about the tabs, the questions pages asked and the downloads. */
export const useBrowser = create<BrowserState>(() => ({ ...EMPTY_BROWSER_STATE }))

/** Starts listening. Returns the way to stop. */
export function startBrowser(): () => void {
  if (!window.celeste) return () => undefined
  const stopState = window.celeste.browser.onState((state) => useBrowser.setState(state))
  // A key typed in a page that the window handles is played again here as if it had been typed in the window.
  const stopKeys = window.celeste.browser.onKey((k) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, ctrlKey: k.control, shiftKey: k.shift, altKey: k.alt, metaKey: k.meta, bubbles: true, cancelable: true }))
  })
  // The assistant used the browser in a chat for the first time: bring it up beside that chat, if the person has it open.
  const stopReveal = window.celeste.browser.onReveal((chatId) => {
    const { mode, setRight } = useUi.getState()
    if (mode !== 'workflows' && useSessions.getState().active[mode] === chatId) setRight('browser')
  })
  void browserCall('state', undefined).then((state) => useBrowser.setState(state), () => undefined)
  return () => {
    stopState()
    stopKeys()
    stopReveal()
  }
}
