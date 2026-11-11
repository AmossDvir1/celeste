/*
 * Celeste's browser pane (docs/BROWSER_PLAN.md). What the main process, which owns the pages, tells the window, and what the window may ask
 * of it. The pure helpers here (what an address bar means, which keys the page must hand back) are shared so both sides and the tests agree.
 */

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** A file a tab shows (docs/FILE_VIEWER_PLAN.md): its path, name and kind of file. */
export interface BrowserFile {
  path: string
  name: string
  /** "Word document", "Spreadsheet"…, for the tab's tooltip. */
  label: string
}

export interface BrowserTab {
  id: string
  /** A page of the web (or a file Chromium shows itself), or a file the viewer page shows. */
  kind: 'web' | 'file'
  file?: BrowserFile
  /** The chat this tab belongs to. */
  chatId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Why the page could not be shown, or null. */
  error: string | null
}

export interface BrowserPrompt {
  id: string
  /** The site, such as https://example.com. */
  origin: string
  /** What it wants, as the end of a sentence: "use your camera". */
  what: string
}

export interface BrowserDownload {
  id: string
  name: string
  state: 'progress' | 'done' | 'failed'
  received: number
  total: number
}

export type SearchEngine = 'google' | 'duckduckgo' | 'bing'
export type LinksIn = 'ask' | 'celeste' | 'system'

export interface BrowserPrefs {
  /** Keep cookies and sign-ins after Celeste quits. Off, as in Claude's browser. */
  keepCookies: boolean
  /** Where a web link in a chat opens. */
  linksIn: LinksIn
  search: SearchEngine
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = { keepCookies: false, linksIn: 'ask', search: 'google' }

/** Other programs (Playwright MCP, a script) using the browser: where they connect while allowed, and how many are connected. */
export interface BrowserExternal {
  endpoint: string | null
  clients: number
}

export interface BrowserState {
  tabs: BrowserTab[]
  /** The tab shown for each chat that has one. */
  selected: Record<string, string>
  prompts: BrowserPrompt[]
  downloads: BrowserDownload[]
  prefs: BrowserPrefs
  external: BrowserExternal
}

export const EMPTY_BROWSER_STATE: BrowserState = { tabs: [], selected: {}, prompts: [], downloads: [], prefs: DEFAULT_BROWSER_PREFS, external: { endpoint: null, clients: 0 } }

export type TabAction = 'back' | 'forward' | 'reload' | 'stop' | 'devtools'

/** Every call the window can make, with its argument and what comes back. */
export interface BrowserCalls {
  state: { arg: undefined; result: BrowserState }
  /** Which chat's pane is on screen and where (in the window's CSS pixels). A null rectangle takes the page off the screen. */
  show: { arg: { chatId: string | null; rect: BrowserRect | null }; result: void }
  /** Something of the window is over the page. `on` hides the page and returns its picture to leave in its place. */
  cover: { arg: { on: boolean }; result: string | null }
  newTab: { arg: { chatId: string; url?: string }; result: string }
  closeTab: { arg: { id: string }; result: void }
  selectTab: { arg: { id: string }; result: void }
  navigate: { arg: { id: string; input: string }; result: void }
  action: { arg: { id: string; action: TabAction }; result: void }
  /** Opens an address in the chat's pane: in its selected tab if that is empty, in a new one if not. */
  open: { arg: { chatId: string; url: string }; result: string | null }
  respond: { arg: { id: string; allow: boolean }; result: void }
  clearData: { arg: undefined; result: void }
  setPrefs: { arg: Partial<BrowserPrefs>; result: void }
  openExternal: { arg: { url: string }; result: void }
  showDownload: { arg: { id: string }; result: void }
  dismissDownload: { arg: { id: string }; result: void }
  closeChat: { arg: { chatId: string }; result: void }
  /** Gives the keyboard to the page. */
  focus: { arg: undefined; result: void }
  /** Opens a file in a tab: Chromium shows PDF, images, video and HTML itself; the viewer page shows the rest. Fails with a reason in words. */
  openFile: { arg: { chatId: string; path: string }; result: { id: string; how: 'native' | 'viewer' | 'card' } }
  /** Asks, with the system's own dialog, for a file to open. True when one was opened. */
  pickFile: { arg: { chatId: string }; result: boolean }
  /** What the person can do with the file a tab shows, in their own programs. */
  fileAction: { arg: { id: string; action: 'open' | 'reveal' }; result: void }
  /** Lets other programs (Playwright MCP, a script) connect to the browser, or turns them out. `endpoint` is where they connect, or null while they are not allowed. */
  external: { arg: { on: boolean }; result: BrowserExternal }
}
export type BrowserOp = keyof BrowserCalls

export const SEARCH_URL: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q='
}

/** The schemes a page may be opened with. Everything else (javascript:, data:, app links) is refused. */
const OPENABLE = new Set(['http:', 'https:', 'file:'])

export function parseUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** True for an address the pane may load. */
export function isOpenable(url: string): boolean {
  if (url === 'about:blank') return true
  const u = parseUrl(url)
  return !!u && OPENABLE.has(u.protocol)
}

/** A page on this computer: a dev server, or a file. Needs no approval and is the one place plain http is the default. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0'
}

export function isLocalUrl(url: string): boolean {
  const u = parseUrl(url)
  return !!u && (u.protocol === 'file:' || (OPENABLE.has(u.protocol) && isLocalHost(u.hostname)))
}

/**
 * What the person typed in the address bar, as an address to load: a full address as it is, something that looks like a site with
 * https (http for this computer), and anything else as a search. Null for nothing, or for an address the pane will not open.
 */
export function resolveAddress(input: string, search: SearchEngine = 'google'): string | null {
  const text = input.trim()
  if (!text) return null
  if (text === 'about:blank') return text
  // A scheme: it is an address, and must be one the pane opens ("localhost:3000" has a colon but no scheme).
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase()
  if (scheme && !/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(scheme) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(text)) {
    return isOpenable(text) ? text : null
  }
  if (!/\s/.test(text)) {
    const host = text.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? ''
    const bare = host.replace(/:\d+$/, '')
    const looksLikeSite = isLocalHost(bare) || /^\d+\.\d+\.\d+\.\d+$/.test(bare) || /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(bare)
    if (looksLikeSite) {
      const url = `${isLocalHost(bare) ? 'http' : 'https'}://${text}`
      return parseUrl(url) ? url : null
    }
  }
  return SEARCH_URL[search] + encodeURIComponent(text)
}

/** The site of an address, as the pane's approvals and permissions name it: scheme, host and port. */
export function originOf(url: string): string {
  const u = parseUrl(url)
  return u && u.origin !== 'null' ? u.origin : (u?.protocol ?? '')
}

/** What a tab or the address bar shows for an address: no scheme, no leading www, no trailing slash. */
export function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  const u = parseUrl(url)
  if (!u) return url
  if (u.protocol === 'file:') return decodeURIComponent(u.pathname.replace(/^\//, ''))
  const rest = `${u.hostname.replace(/^www\./, '')}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}${u.hash}`
  return rest.endsWith('/') && !u.search && !u.hash ? rest.slice(0, -1) : rest
}

/** The user agent a site should see: the app's own, with the "Electron" and app-name parts taken out, as Claude's browser does. */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\sElectron\/\S+/i, '')
    .replace(/\sceleste\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** A key as the window and the page see it. */
export interface KeyInput {
  key: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/**
 * The keys the window handles, so a page that has the keyboard must hand them back (the page is a native layer and the window never sees
 * its keys). Ctrl, or Cmd on a Mac, is the main key.
 */
export function isWindowKey(k: KeyInput): boolean {
  const main = k.control || k.meta
  const key = k.key.toLowerCase()
  if (main && !k.alt) {
    if (k.shift) return key === 'b'
    return ['k', ',', 'n', 'b', '1', '2', '3', 'l', 't', 'w', 'r'].includes(key)
  }
  if (k.alt && !main && !k.shift) return key === 'arrowleft' || key === 'arrowright'
  // Escape is the page's own (it closes the page's menus and leaves full screen), so it stays with the page.
  return !main && !k.alt && !k.shift && (key === 'f5' || key === 'f12')
}

/** Which tab to show after one closes: the one before it, else the one after, among the same chat's tabs (in order). */
export function afterClosing(order: string[], closing: string): string | null {
  const i = order.indexOf(closing)
  if (i < 0) return order[0] ?? null
  return order[i - 1] ?? order[i + 1] ?? null
}

/** A tab as Core's browser tools see it (they act on the page through Playwright; this is what only the main process knows). */
export interface HostTab {
  id: string
  /** The id the page's own DevTools gives it, which is how Playwright's page for it is found. Null while it has no page. */
  targetId: string | null
  url: string
  title: string
  selected: boolean
  loading: boolean
  error: string | null
}

/**
 * The address a tool was given, or null when it is not one: a full address, or something that is plainly a site (example.com). A phrase
 * to search for is not an address, and is refused so the assistant says what it means.
 */
export function addressFor(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const url = resolveAddress(text, 'google')
  if (!url || url.startsWith(SEARCH_URL.google)) return null
  return url === 'about:blank' ? null : url
}
