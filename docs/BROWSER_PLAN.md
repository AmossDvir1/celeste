# Celeste: Browser Plan

> **Status, 10 November 2026: step 0 (the spike) is done and the design works, and all four steps are built and checked (section 8). What is left is the by-hand list in section 11, and later work (section 10).** The owner chose the design on 10 November 2026: a real Chromium view inside the app (Electron's `WebContentsView`), driven by Playwright, behaving like the Claude desktop app's built-in browser. Section 3 lists what we copy from it and what we leave out. The decisions in section 9 are the defaults I picked; any of them can be changed before step 1 starts.

## 1. Summary

Celeste gets a **browser pane**: tabs, an address bar, back, forward and reload, beside the conversation like Files, Changes and Terminal. It is a real browser (Chromium, the one inside Electron), not a picture of one: sites load, sign-ins work, video plays, typing and scrolling feel native.

The assistant can use it. Its tools open pages, read them, click, type, take screenshots and read the console and network, on Celeste's own tool server, so **Claude and Copilot both get them**. Under the tools is **Playwright**, connected to the pane's tabs. Other programs can connect the same way when the person allows it, for example Playwright MCP from another agent, or a test script.

## 2. Research: how others build this

| Product | How the page is drawn | How the agent drives it |
|---|---|---|
| **Claude desktop** (the model for this plan) | A separate Chromium view inside the Electron app. Checked from inside on 10 Nov 2026: the page reports `Claude/4.23118.1 Chrome/152` (the app's own Chromium with "Electron" taken out of the user agent), it is the top-level page (no frame), and `navigator.webdriver` is false. | Chrome DevTools Protocol, very likely; not documented. |
| **VS Code + Copilot** (browser tools GA July 2026) | `WebContentsView`, owned by the main process. The page is painted over the workbench, so VS Code handles position, layering, focus and screenshots by hand. | **Playwright**, running in a helper process, reaching the page over IPC. |
| **Cursor** | Probably `WebContentsView` (a fork of VS Code; not stated by Cursor). Its forum has bugs from the same layering problem (resizing). | Reports disagree: Playwright or raw CDP. |
| **Codex app** (April 2026) | Not documented; the app is Electron, so most likely the same. Has a comment-on-element mode. | Not documented. |
| **ChatGPT Atlas** | Chromium in a separate process, its pixels put into the app with macOS layer hosting (OpenAI's "OWL"). Needs a custom Chromium build and Mac-only private APIs. **Not an option.** | Their own. |

Two other ways were weighed and turned down: a hidden Playwright browser whose frames are streamed into a canvas (no layering problems, but it does not feel like a browser: lag, blur on scaled screens, clumsy typing and select menus, and about 150 MB more to download), and a separate Chrome window (not inside Celeste). The `<webview>` tag is discouraged by Electron, and an `<iframe>` is refused by most sites.

Sources: [Claude Code desktop docs](https://code.claude.com/docs/en/desktop), [Copilot browser tools GA](https://github.blog/changelog/2026-07-01-browser-tools-for-github-copilot-in-vs-code-are-generally-available), [VS Code integrated browser skill](https://www.skills.sh/microsoft/vscode/integrated-browser), [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron debugger](https://www.electronjs.org/docs/latest/api/debugger), [webview tag](https://www.electronjs.org/docs/latest/api/webview-tag), [Codex update](https://openai.com/index/codex-for-almost-everything/), [Building ChatGPT Atlas](https://openai.com/index/building-chatgpt-atlas).

## 3. Like Claude: what we copy, what we leave out

The owner asked for it to be **exactly like Claude's**. From Claude's documentation and the check above:

| Claude's browser | Celeste |
|---|---|
| A pane in the conversation, opened with Ctrl+Shift+B or a button in the title bar | Same: a right-hand panel, Ctrl+Shift+B, a Browser button with the other panel buttons. |
| Tabs | Same. |
| A clean profile, separate from your own browser; **Keep cookies** and **Clear browsing data** in a ⋮ menu | Same. |
| The first link you click asks whether links open in the pane or your browser; a setting changes it later; Ctrl+click always opens your browser | Same. |
| Claude can screenshot, read the page, click, type, fill forms, read console and network | Same, through Playwright (section 6). |
| No border, no "assistant is using this" bar | Same. The assistant opens and uses the browser freely. |
| Local dev servers need no approval | Same. |
| **The first time Claude acts on an external site, a card: Allow once, Always allow, Deny.** Always allow is remembered per site and can be removed in Settings | Same, on Celeste's own approval card. **A switch in Settings turns it off** (on by default, as in Claude). |
| Before navigating to a new site, a check in every permission mode except Auto and Bypass | Same: in Celeste's "Ask" and "Edits" approval modes, opening a new external site asks; in "Auto" it does not. In "Plan" only reading tools work, as for every other tool. |
| A safety classifier reviews clicks and typing on external pages | **Left out.** Celeste has no classifier. |
| Won't buy, create accounts or solve CAPTCHAs without you | Said in the tools' instructions to the assistant (soft, like Claude's). No hard block. |
| A setting turns the browser tools off | Same: "Browser tools" in Settings, on by default. The pane works with it off; only the assistant's tools go. |

## 4. How it is built

```
 Renderer (React)                 Main process                              Core (utility process)
 ───────────────                  ────────────                              ──────────────────────
 BrowserPanel  ── bounds, ──────▶ BrowserService                            BrowserTools (ExtraTools)
  toolbar, tabs   commands        ├ one WebContentsView per tab              ├ browser_* tools on the tool server
  placeholder div ◀── tab state ── ├ session 'celeste-browser'               ├ site approvals (approval card)
                                  ├ popups, downloads, permissions          └ playwright-core
                                  └ CDP bridge (ws://127.0.0.1:<port>/<token>) ◀── connectOverCDP
                                       └ webContents.debugger per tab        ▲
                                                                             └── other programs, when allowed
```

### 4.1 The view

- Each tab is a `WebContentsView` added to the window's `contentView`. Only the selected tab of the shown panel is visible; the others are kept but hidden.
- `webPreferences`: no preload, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false` (so screenshots and timers stay right when the pane is closed), `partition` from section 4.4.
- The page cannot reach Celeste: it has no preload, so no bridge. As a second wall, the main process's IPC check (`fromOurWindow` in `src/main/index.ts`) is tightened to accept only the window's own `webContents`, never a view's.
- The user agent drops the `Electron/x` token, as Claude's does, so sites (Google sign-in above all) treat it as Chrome.

### 4.2 Layering (the known cost of this design)

The view is painted **on top of** the React page, not in it. So:

- The panel renders an empty placeholder `div`. A `ResizeObserver` (plus window resize and zoom) reports its rectangle to main, which calls `setBounds`. The rectangle is in CSS pixels and the zoom factor is applied.
- Anything that would overlap the view (a dialog, a menu, a popover, a tooltip, the `/` menu, the settings window) would be hidden underneath it. While one is open, main **hides the view and the placeholder shows the last screenshot of it** (`capturePage`), so nothing flickers to blank. The renderer keeps a count of open overlays in the UI store; Radix's open state feeds it.
- Focus: clicking the page focuses the view; Esc or a click in Celeste gives focus back.
- Celeste's shortcuts do not reach the renderer while the page has focus. Main listens on the view's `before-input-event` and forwards Ctrl+Shift+B, Ctrl+K, Ctrl+, , Ctrl+N and Ctrl+1/2/3. The pane's own: Ctrl+L (address bar), Ctrl+T, Ctrl+W, Ctrl+R / F5, Alt+Left/Right, F12 (DevTools).

### 4.3 Tabs and chats

- **Tabs belong to a chat.** Each chat has its own tabs; switching chats switches the pane. Two chats working at once never fight over one page, and the assistant can only use its own chat's tabs.
- The **profile** (cookies, storage) is shared by all chats, so signing in once counts everywhere, as in Claude.
- Tabs are not restored after Celeste restarts in v1.
- A chat that is deleted closes its tabs. A tab idle and hidden for 30 minutes is discarded (its URL is kept and it reloads when shown), to save memory.

### 4.4 Profile, popups, downloads, permissions

- Session `persist:celeste-browser` when **Keep cookies** is on; an in-memory `celeste-browser` otherwise (cleared on quit). Default: off, as in Claude.
- **Clear browsing data**: `session.clearStorageData()` and `clearCache()`.
- `window.open` and `target=_blank`: a new tab. Sign-in popups that need `window.opener` (Google, Microsoft, GitHub OAuth) open as a small real window with the same session, and close themselves when done.
- Downloads: a bar in the pane with the file name and size; saved to the system Downloads folder after the person presses Save.
- Camera, microphone, location, notifications, MIDI, clipboard read: a prompt bar in the pane ("example.com wants to use your camera: Allow / Block"), remembered per site for the session. The assistant cannot answer it.
- Certificate errors: a full-page warning with "Go back"; no "proceed anyway" in v1.

### 4.5 The CDP bridge and Playwright

Playwright connects to a browser over the Chrome DevTools Protocol (`chromium.connectOverCDP`). Electron does not give a browser-level endpoint for some views only, so main serves **a small bridge**:

- A WebSocket server on `127.0.0.1`, a random port, a random token in the path. It speaks browser-level CDP and maps it onto each tab's `webContents.debugger`:
  - `Target.getTargets`, `Target.setAutoAttach`, `Target.attachToTarget` see **only the browser's tabs**, never Celeste's own windows.
  - Each tab gets a session id; commands with that id go to that tab's `debugger.sendCommand`, and its events come back with it. Child sessions (iframes in other processes, workers) are passed through with their own ids.
  - `Target.createTarget` opens a new tab; `Target.closeTarget` closes one.
  - `Browser.getVersion` answers; `Browser.setDownloadBehavior` and similar browser-level calls are answered by main or politely ignored.
- Core's `BrowserTools` connects once with `playwright-core` and keeps the connection; it reconnects if Core or main restarts.
- **Other programs** (Playwright MCP's `--cdp-endpoint`, a script): Settings shows "Let other programs control Celeste's browser", **off by default**. When on, Settings shows the endpoint with its token and a Copy button, and a new token is made each start. A program connected this way sees only the browser's tabs (of all chats).
- **DevTools:** opening DevTools on a tab ends the debugger on that tab (Electron's rule). While DevTools is open, the assistant is told that tab cannot be used; the bridge attaches again when DevTools closes.
- `playwright-core` moves from `devDependencies` to `dependencies` (about 8 MB, no browser download), and `ws` is added.

## 5. The pane

- **Header:** back, forward, reload or stop, the address bar (a URL, or words searched with the person's choice of engine, Google by default), a ⋮ menu: Keep cookies, Clear browsing data, Open links in the built-in browser, Open in my browser, DevTools.
- **Tabs** above the header, with + and ×. A dot on a tab the assistant used in the last few seconds (a small hint, not a border).
- **Width:** the panel is resizable by dragging its left edge (the other panels are a fixed 400 px; a browser needs more). Default 45% of the window, remembered.
- **In Chat and in Develop.** The Browser button sits with the other panel buttons; today only Tools shows in Chat, so `RightPanel` in `App.tsx` lets Browser through in both.
- **Links from the chat:** the first click on a web link in a message asks "Open links in Celeste's browser or your browser?" and remembers. `localhost` and `127.0.0.1` links always open in the pane. Ctrl+click always opens the system browser.
- Empty state: an address bar and a short line, "Open a site, or ask the assistant to."

## 6. The assistant's tools

On Celeste's own tool server, so every vendor has them, through `CombinedTools` beside desktop control and the phone. Every call names a tab or uses the chat's selected tab, and **opens the pane** if it is closed (as Claude's does).

| Tool | What it does | Playwright under it |
|---|---|---|
| `browser_tabs` | Lists this chat's tabs (id, title, URL, which is selected). | `context.pages()` filtered to the chat |
| `browser_new_tab`, `browser_select_tab`, `browser_close_tab` | Tab management. | `Target.createTarget` / bring to front / close |
| `browser_navigate` | Opens a URL, or `back` / `forward` / `reload`. | `page.goto`, `goBack`, `goForward`, `reload` |
| `browser_read_page` | The page as an accessibility tree, each element tagged `ref_N`; optional `interactive` filter and a root ref. | `page.ariaSnapshot({ mode: 'ai' })` (checked in step 0) |
| `browser_find` | Elements whose role, name or text match a phrase. | Over the snapshot |
| `browser_get_text` | The page's readable text (main content first). | `evaluate` |
| `browser_click` | Click a `ref` or an x/y in the last screenshot; double, right, with modifiers. | `page.getByRef(ref).click()` or `mouse.click` |
| `browser_type`, `browser_key` | Type text; press keys. | `keyboard.type`, `keyboard.press` |
| `browser_fill` | Set a field, select, checkbox. | `locator.fill`, `selectOption`, `setChecked` |
| `browser_scroll`, `browser_hover` | Scroll; hover. | `mouse.wheel`, `locator.hover` |
| `browser_screenshot` | A picture of the tab (viewport, or a zoomed region). | `page.screenshot` |
| `browser_wait` | Wait for text, a ref, or a few seconds. | `waitFor` |
| `browser_console`, `browser_network` | Recent console messages and requests (with a filter); one response body by id. | `page.on('console')`, `on('request'/'response')`, kept per tab |
| `browser_eval` | Run JavaScript in the page, for inspection. | `page.evaluate` |
| `browser_upload` | Put a file from the chat's folder into a file input. | `setInputFiles` |

Rules in code:

- **Site approvals (section 3):** a call that clicks, types, fills, uploads or evaluates on an external site with no approval raises the approval card (Allow once / Always allow / Deny) and waits. Reading and screenshots do not ask. "Local" is `localhost`, `127.0.0.0/8`, `[::1]`, `*.localhost` and `file:` under the chat's folder. Always-allowed sites are listed in Settings with a Remove button; subdomains are separate sites, as in Claude.
- **Navigation check:** in the "Ask" and "Edits" approval modes, navigating to a site that is not approved and not local asks first; in "Auto", never. In "Plan", only the reading tools (`browser_tabs`, `browser_read_page`, `browser_find`, `browser_get_text`, `browser_screenshot`, `browser_console`, `browser_network`) are marked `readOnly`.
- Text from pages is returned marked as page content; the tool descriptions tell the assistant to treat it as data, never as instructions, and not to buy, create accounts or solve CAPTCHAs without asking.
- Workflow steps: the tools answer "not available in workflows yet" in v1 (a step has no pane to show; see section 10).

## 7. Settings: a new "Browser" section

- **Browser tools** (on): the assistant may use the browser.
- **Ask before the assistant acts on a new site** (on), with the list of always-allowed sites.
- **Keep cookies** (off) and **Clear browsing data**.
- **Open links from chats in**: Ask / Celeste's browser / My browser.
- **Search engine** for the address bar.
- **Let other programs control Celeste's browser** (off), with the endpoint and Copy.

## 8. Build order

### Step 0: spike (done, 10 November 2026)

The spike is kept in `spikes/browser/` (a tiny Electron app, the bridge in `bridge.js`, and `t3-bridge.mjs` to run the checks; Electron 45.2.3, Chromium 156, Playwright 1.65). **Result: the design works. Two small things came out of it, and four things were not tested.**

**Worked:**

1. **Layout.** A `WebContentsView` placed at the placeholder's rectangle times the window's zoom factor matched exactly at 100%, 125% and 150% zoom, and after a window resize. The view's picture (`capturePage`) still works while it is hidden, so the "hide under a dialog and show its picture" idea is possible.
2. **The bridge.** Through `connectOverCDP`, Playwright saw only the browser's tabs (not Celeste's window) and could: read the title, click, fill, screenshot, receive console messages, click inside an iframe from **another site** (it lives in another process), open a new tab with `context.newPage()`, follow a `target=_blank` link into a new tab, and close a tab. `browser.version()` and the user agent came out right.
3. **Playwright over Electron's own debug port** (the fallback) also works: Playwright sees each view as an ordinary page. So the fallback is real, but not needed.
4. **Element refs.** Playwright 1.65 has a public `page.ariaSnapshot({ mode: 'ai', boxes: true })` that returns the tree with refs (`[ref=e3]`, `[ref=f1e2]` inside an iframe) and `page.getByRef('e3')` to act on one. Clicking a button by its ref worked.
5. **User agent.** With the `Electron/…` part taken out, the page sees the brands "Chromium 156" and "Not:A-Brand", `navigator.webdriver` is false, and `window.chrome` exists: the same as Claude's pane. (The app-name part, `celeste/1.1.0`, must be taken out too.)
6. **Sign-in pages.** The Google, Microsoft and GitHub sign-in pages loaded in a view and showed their real forms, with no "unsupported browser" page.
7. **`app.firstWindow()`** in `scripts/lib/app.mjs` still returns Celeste's own window, because it opens first. Checks that care should pick the page by its URL.

**What the bridge needs to get right (found the hard way):**

- On `Target.createTarget` the client must be told the new target is attached **before** it gets the answer, or Playwright's `newPage()` fails with an internal error.
- When a tab closes, the bridge must send `Target.detachedFromTarget` (and `Target.targetDestroyed` when discovery is on), or `page.close()` waits forever. It must do this also when the page closes itself (`window.close()`).
- `Browser.setDownloadBehavior` and a browser-level `Target.getTargetInfo` can be answered with `{}`. Everything sent with a session id goes to that tab's `debugger.sendCommand`; child sessions (iframes in other processes) go with their own ids.
- The spike takes its WebSocket server from inside `playwright-core`; the real bridge adds the `ws` package as a dependency.

**Not tested (do these early in step 1 or 2, or by hand):**

- A second monitor or a high-DPI screen (this computer has one screen at 100%). Bounds are in device-independent pixels, so it should hold.
- Whether the dialog really draws above the page, as a picture, not only that the view reports hidden.
- **Actually signing in.** Pages load, but only a real sign-in shows whether Google accepts the view after the email step, and whether the popup flows work. The spike denied `window.open` and opened a tab instead; a sign-in that needs `window.opener` (Google, Microsoft, GitHub OAuth in a popup) needs the small real window of section 4.4. Windows also showed its passkey prompt when Google's page loaded; a real browser does the same.
- The official Playwright MCP against the bridge (`--cdp-endpoint`); it is not installed here.

### Step 1: the pane (built, 10 November 2026)

**Built and checked** (`npm run verify:browser`, 35 checks, plus 3 screens in `verify:ui`, plus 16 unit tests in `src/shared/browser.test.ts`): the panel in Chat and Develop (Ctrl+Shift+B, a header button, drag the edge to resize), tabs per chat that close with the chat, the address bar (`resolveAddress`), Back, Forward, Reload and Stop, errors with Try again, the page's questions (location, camera, microphone, notifications, clipboard, MIDI, screen share) as a bar in the panel, downloads (the system's Save window, then a row in the panel), the page stepping aside for dialogs, menus and messages with its picture left in its place, window keys handed back from the page (`before-input-event`), the right-click menu, popups that need `window.opener` as small real windows, Keep cookies / Clear browsing data, links from chats (ask the first time; local pages always open in the pane; Ctrl+click opens the person's browser), and tabs put away after 30 idle minutes.

Where it is: `src/main/browser/service.ts` (the pages), `src/shared/browser.ts` (types and helpers), `src/renderer/features/browser/` (the panel, `useBrowserArea` for placing the page and stepping aside, the link question), `src/renderer/stores/browser.ts`, `src/renderer/lib/links.ts`. The preload gives the window `celeste.browser` (`call`, `onState`, `onKey`).

**Differences from the plan above:**

- The pane's own preferences (keep cookies, where links open, search engine) are kept by the main process in `browser.json` in the data folder, not in Core's settings. Step 3's Browser section of Settings reads and writes them through the same calls; the assistant's switches (tools, site approvals) go in Core's settings.
- Cookies are kept by always using the persistent profile and clearing it when Celeste starts and quits unless Keep cookies is on (the plan said two partitions).
- Tabs show a spinner or a globe, not the site's icon: the window's content policy would block a remote icon, and fetching it is left for later.
- A page that is covered by a message (a toast) over its area steps aside for as long as the message shows.

**Not checked by the script (do by hand):** that a download is saved where the person chose (Playwright takes downloads over, so the check only sees one start); a sign-in popup that needs `window.opener`; Google, Microsoft and GitHub sign-in end to end; a second monitor or a high-DPI screen; a camera or microphone prompt; a video.

`RightPanel` gains `'browser'`; `BrowserPanel` (header, tabs, placeholder, empty state, resizable width); `BrowserService` in `src/main/browser/` (views, bounds, tabs per chat, state pushed to the window); overlays and the screenshot placeholder; focus and shortcuts; popups, downloads, permissions; profile and Clear data; the ⋮ menu; links from chats; Ctrl+Shift+B.

### Step 2: Playwright and the tools (built, 10 November 2026)

**Built and checked** (`npm run verify:browser-tools`, 33 checks; 14 bridge tests in `src/main/browser/bridge.test.ts`; 26 tool tests in `src/core/browser/tools.test.ts`; `verify:package` also checks Playwright and `ws` load from inside the archive): the DevTools bridge in the main process (`src/main/browser/bridge.ts`), all 20 tools of section 6 in Core (`src/core/browser/tools.ts`, joined into `CombinedTools`), Core's link to the main process (`src/core/browser/main-host.ts`, with `browser-call` / `browser-reply` messages like desktop control), the browser coming up beside the chat the first time the assistant uses it, the `browserTools` switch in Core's settings (on by default), and the `external` call that lets other programs in (off by default, and turns them out at once).

**What the bridge needed beyond the spike** (each found by running it, and now a test): the browser-level session Playwright makes for `newCDPSession` (it is how Core finds which page is which tab); one announcement per page (the browser and the request that made the page both announced it, and Playwright stops on a second); a page that has never navigated does not answer DevTools commands, so a tab with no address starts at `about:blank` (the tab's own address stays empty); the page's own DevTools window ends the bridge's hold on it and the tab is announced again when it closes; refusing any request that carries an `Origin` or a wrong `Host` (a web page can open a WebSocket to this computer).

**Differences from the plan above:**

- A new tab is made blank and the address is opened in it from the tool, so Playwright is watching from the first request and the console and network of a page are complete. A page opened some other way (a link, the person) is watched only from when Core first sees it.
- Playwright runs in Core (a utility process), so it never slows the window. Core finds a tab's page by the id its own DevTools gives it.
- `browser_navigate` takes `back`, `forward` and `reload` as its address.
- Not yet (step 3): the question before acting on a site, the Always allow choice, the Browser section of Settings. Until then the assistant uses any site, the switch in Settings does not exist as a control, and "other programs" is only the `external` call.

**Not checked by the script:** Copilot using the tools (the check uses Claude through the stand-in; the tools are on Celeste's own tool server, which both use); the official Playwright MCP against the endpoint; a page that opens a popup window; DevTools opened by the person while the assistant is using the tab.

### Step 3: approvals and Settings (built, 10 November 2026)

**Built and checked** (`npm run verify:browser-tools` is now 54 checks, with rounds on a site that is not this computer (yes for this chat, always, taking it back, no, and asking switched off) and the Settings screen; 12 new tool tests, 4 new service tests, 1 reducer test; 48 screens in `verify:ui`, with the Browser settings among them):

- **The card has a third answer.** `approval.requested` carries optional `choices: { allow, always }` (the words on two buttons); `SessionService.requestChoice` returns `'once' | 'always' | 'deny'` and `requestApproval` is unchanged for its old callers. The card shows "Allow for this chat", "Always allow <site>" and Deny when `choices` is there, and is as before when it is not.
- **The tools ask** (`gate` in `src/core/browser/tools.ts`). Acting on a page (click, type, key, fill, upload, eval) on a site that is not this computer, and not allowed, asks, in every approval mode. Opening a page (navigate, new tab) asks only in "Ask" and "Edits", and never in "Auto"; going back, forward or reloading never asks. Reading, looking and moving the pointer never ask. Pages on this computer (`localhost`, `127.x`, `*.localhost`, files) never ask. A site is its host name (a subdomain is another site, the scheme and port do not matter).
- **What a yes means.** "Allow for this chat" is for that chat until it ends (the plan said "Allow once", which would ask at every click). "Always allow" is saved in the settings (`browserAllowedSites`) and holds in every chat. A no is remembered for that chat, so the assistant cannot keep asking, and it is told not to try again; another chat is not bound by it.
- **The settings.** `browserTools`, `browserAskSites` (on) and `browserAllowedSites` (a list of host names, checked and cleaned in Core) in Core's settings, and `settings.get` so the window reads the list fresh (the assistant adds to it while Settings is closed).
- **Settings, Browser** (and "Browser settings…" in the pane's ⋮ menu): let the assistant use the browser; ask before a new site; the sites always allowed, each with Remove; keep cookies; clear browsing data; where links from chats open; the search engine; and "other programs", which shows the address with a Copy button and how many programs are connected (the bridge tells the window when one comes or goes). The pane's own preferences are still kept by the main process, as in step 1.

**Not checked by the script:** the navigation question (opening a new site in an "Ask" or "Edits" chat) beyond the unit tests, because those modes also put a card on every tool call from the vendor; the card for a site on the phone (the phone shows Allow and Deny, and Allow means for this chat); a site's own port or a redirect to another site in the middle of a task (the check is made on the page's address when each tool runs, so a redirect is caught at the next action).

### Step 4: the last pass (done, 11 November 2026)

**Hardening found by reading the code again:**

- A file address (`file:`) is opened by the tools only from the chat's own folder (the project folder in Develop). Before, a chat with no access to the computer's files could read any of them by opening it in the browser, or by being sent to one by a page. A page cannot open a file in a new tab either, and the right-click menu does not hand a file address to the person's own programs (that would start whatever opens it). A sign-in popup may not go to a file or an app link.
- Every page keeps a real size even when hidden: a page that had never been shown had no size, so a program (the real Playwright MCP found this) could not take its picture. Now a hidden page is the size the panel last was, or a plain default before it ever was.
- The address bar takes the keyboard only when the person opened the panel or made a tab. When the assistant opened it, it used to take the keyboard from the message box and stop following the page (found by looking at the README picture).

**Checked with the real thing:** the official Playwright MCP (`@playwright/mcp` 0.0.85, installed in a scratch folder, not part of Celeste) was pointed at the endpoint with `--cdp-endpoint`: it connected, listed its 25 tools, saw only the browser's tab, read the page with refs, clicked (the page showed the click), navigated and took a screenshot. A sign-in popup that talks back to its page through `window.opener` works, and a link that opens a new tab opens one in the panel (both in `verify:browser`).

**Docs:** the README (a bullet, a picture made by `npm run shots`, the shortcut, the state table, the roadmap), the changelog, CONTRIBUTING, PRIVACY, the notices, `IMPLEMENTATION_PLAN.md` (decision 18).

## 9. Decisions (defaults picked; say if any should change)

| # | Decision | Default |
|---|---|---|
| B1 | How it is built | `WebContentsView` + Playwright through a CDP bridge (**chosen by the owner**) |
| B2 | Where | A right-hand panel, resizable, Ctrl+Shift+B |
| B3 | Which modes | Chat and Develop |
| B4 | Tabs | Per chat; the profile is shared |
| B5 | Cookies | Not kept unless "Keep cookies" is on (as Claude) |
| B6 | Site approvals | On, with a switch to turn them off (as Claude) |
| B7 | Border or "in use" bar | None (as Claude) |
| B8 | Other programs (Playwright MCP, scripts) | Allowed with a switch, off by default |
| B9 | Workflows | Not in v1 |

## 10. Later (not v1)

- Opening HTML, PDF and video files from the chat in the pane (Claude does this).
- Starting a project's dev server and opening it ("Open" on a server card), and the assistant checking its own changes after each edit (Claude's "Auto-verify").
- Comment on an element and send it to the chat (Codex's comment mode; VS Code's "select element").
- The browser in workflow steps (a hidden tab per step).
- Restoring tabs after a restart.
- Importing cookies from the person's own browser.

## 11. Tests and checks

- **Unit (vitest):** the bridge against a fake `debugger` (targets filtered, session ids routed, child sessions, create and close); site approval rules (local hosts, subdomains, Allow once versus Always, the navigation check per approval mode); tab ownership (a chat cannot reach another chat's tab).
- **`npm run verify:browser`** (`scripts/browser-check.mjs`), on a page served by the script and the stand-in Anthropic API:
  - The pane opens with Ctrl+Shift+B, loads the page, back and forward work, a dialog hides the view and shows its picture.
  - Claude (scripted by the stand-in) reads the page, clicks a button by ref, types into a field, and the page shows the result.
  - An "external" site (a test host name mapped to 127.0.0.1 with `--host-resolver-rules`) raises the approval card; Deny refuses; Always allow is remembered.
  - Two chats, two tabs: one chat's tools cannot see the other's tab.
  - With the switch on, a separate `connectOverCDP` from the script sees the browser's tabs and **not** Celeste's own window.
- `verify:ui` (accessibility) passes with the pane open.
- **By hand (not yet done):** Google, Microsoft and GitHub sign-in end to end; a download saved where the person chose (Playwright takes downloads over in the checks); a video; a camera prompt; 150% scaling and a second monitor; Copilot using the tools (the checks use Claude, and never a real Copilot account); DevTools opened by the person on a tab the assistant is using.

## 12. Risks

| Risk | What we do |
|---|---|
| The view drawn over Celeste's menus and dialogs | The overlay count and screenshot placeholder (4.2); checked in `verify:browser`. |
| The bridge does not satisfy Playwright | Found in step 0; the fallback is in step 0. |
| Google blocks sign-in in an embedded browser | Clean user agent; popups as real windows; checked in step 0. If it still fails, "Open in my browser" for that site. |
| A page tries to steer the assistant (prompt injection) | Page text marked as data; site approvals on by default; nothing stops a determined page, as with Claude without its classifier. Said plainly in Settings. |
| Memory with many tabs | Idle hidden tabs are discarded (4.3). |
| Playwright upgrades break the bridge | `playwright-core` pinned; the bridge has its own tests; `verify:browser` runs before releases. |
