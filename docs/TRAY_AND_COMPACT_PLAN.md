# Celeste: Tray and compact window Plan

> **Status: Part 1 (tray) is built on Windows, uncommitted, with unit tests and `verify:tray`; not yet looked at by eye (the icon in the tray and the overflow, the notification, the quit question). Differences from the text below: Linux closes as before (no hidden window that cannot be found); the dot on the icon is painted by `paintDot`; Core tells the main process through `app-settings`, `attention` and `needs-you` messages (`src/core/attention.ts`). Part 2 (compact window) is built, uncommitted, with unit tests for the bounds maths and `verify:compact`; looked at in screenshots of the small window, not yet used by hand. Differences from the text below: in the Workflows view a run in progress is one click away from its card (it opens the run's own panel, which has Allow and Deny) rather than showing the card in the list; the "Needs you" strip has Allow and Deny only for a plain yes or no whose log is loaded, and an Open link otherwise; the search dialog is not forced to the full view; the global shortcut and the attach-the-screen ideas (section 8) are not built.** Written 15 November 2026 from two requests by the owner. Part 1 keeps Celeste running in the system tray when its window is closed. Part 2 adds a button in the top bar that turns the window into a small side window for working beside other programs. The decisions in section 7 are the defaults I picked; change any before building. Part 1 also replaces section 4.6 of `SCHEDULING_PLAN.md` (the tray there was only "while a schedule is on"; it is now general). File references are to the code as of commit 9a5745f.

# Part 1: Stay in the tray

## 1. What happens today

`app.on('window-all-closed')` quits on Windows and Linux (`main/index.ts:257`), so closing the window ends everything: Core (a utility process, `core-process.ts`), running chats and workflow runs, the phone connection and the browser pane. The picture shows what the owner wants instead: Celeste's icon among the tray icons (Windows 11 keeps new icons in the overflow, the ^ menu, until the person pins them).

## 2. Design

- **Closing the window hides it; Celeste keeps running.** A tray icon appears (`resources/icon.ico`, 16 and 32 px: to verify it is sharp at both). Left click opens the window; right click opens a menu: **Open Celeste**, **Compact view** (Part 2), **Quit Celeste**. Later: **Pause scheduled runs** (from `SCHEDULING_PLAN.md`).
- **Hide, not destroy,** for now: reopening is instant and the chat, scroll and drafts are as they were. The cost is the window's memory while hidden; to be measured. If it is large, a later step destroys the window after some minutes hidden and rebuilds it (the Mac `activate` handler already rebuilds one, `main/index.ts:252`; Core and the sessions live outside the window, so nothing is lost but scroll).
- **Quit means quit.** Tray menu, Ctrl+Q (menu on Mac), an installer update and a system shutdown still run the existing `before-quit` sequence (drafts saved, browser shut, Core closed). If chats are working or a workflow run is going, Quit from the tray first asks: "2 chats are still working. Quit anyway?"
- **First time only:** when the window is first hidden, a notification says "Celeste is still running in the tray. Right-click the icon to quit." The same notice carries the way out (decision 2).
- **Tooltip:** "Celeste" and, when it matters, "Celeste: 2 working, 1 needs you". The icon gets a small dot when something needs you.

### What this changes, and has to be handled

| Because Celeste now lives without a window | Do this |
|---|---|
| A chat can reach an approval or a question while the window is hidden, and nobody sees it. | A system notification ("Fix the tests needs you: Run `npm test`?"), shown only while the window is hidden or unfocused; clicking it opens that chat. The taskbar button flashes. The phone already gets these (`bridge.ts:605`). |
| Desktop control ends with the last window, so nothing keeps controlling the computer with no chat in view (`main/index.ts:81`). A hidden window is "no chat in view" too. | Hiding the window while control is active **stops control** (`desktop.stopAll('Celeste was hidden.')`), the same as closing did. |
| `second-instance` focuses the window (`main/index.ts:238`). | It must show a hidden window first. |
| The browser pane's pages are views laid over the window. | Hidden with the window; the idle sweeper (`browser/service.ts:215`) still reclaims them. |
| Workflow runs and the phone connection continue in the background. | That is the point; it is also what scheduled workflows need. |
| Linux trays are unreliable (they need an indicator extension). | Use the tray only when Electron reports it works; otherwise closing minimises, as a normal app does. On Mac the app already stays open; a menu-bar icon is optional and skipped. |

## 3. Start with the computer (separate, optional)

Not asked for yet. A single choice, "Start Celeste when I sign in", off by default, started hidden in the tray (`app.setLoginItemSettings` with a `--background` argument). It makes the phone and scheduled workflows work after a restart. Offered once, the first time a schedule is created, and kept in Settings, General.

# Part 2: Compact window

## 4. What the owner wants

A button in the top bar (the spot in the second picture) that changes the same window into a small side window, about the size of the red rectangle in the third picture: roughly 520 by 615 pixels, resting on the right edge above the taskbar. It shows the session in a compacted way with the message box under it, so Celeste can sit beside the editor or a browser while the person works.

### 4.1 Where the button goes

In the picture the red box sits between the account avatar and the window buttons. I read it as (confirmed by the owner): **to the right of the avatar**, immediately left of minimise, so the avatar and the search icon each move one place left. Icon: `PictureInPicture2` (lucide), label "Compact view (Ctrl+Shift+M)". In compact view the same place holds the opposite button, "Full view", so the toggle never moves. If the owner meant the avatar's own place, it is a one-line change.

### 4.2 Same window, not a second one

The window **changes shape** (size, position, minimum size, on top or not, its top bar) and the page switches to a compact layout. It is one window and one set of stores, so the open session, the drafts and the busy dots are the same on both sides, and nothing reloads. A second window would hold a second copy of the state and the draft in the box could be in two places.

Main process, `celeste:layout` (payload checked, our window only):
1. **Entering:** remember the full bounds and whether it was maximised; un-maximise; set the minimum size to about 360 by 480 (it is 1040 by 640 today); resize to about 520 wide and 70% of the work area high (at most 700), placed at the bottom right of the **work area of the screen the window is on** (the taskbar is outside the work area, so this works wherever the taskbar is) with a 12 px margin; or at the last compact position if there is one and it is still on a screen; set always-on-top (decision 5).
2. **Leaving:** put back the full bounds and the maximised state, the old minimum size, and turn always-on-top off.
3. Bounds maths lives in `main/compact.ts` as plain functions (`compactBounds`, `fitOnScreen`), so it is unit-tested without Electron.
4. The title-bar overlay height is 56 today and is also set when the theme changes (`main/index.ts:133`); it becomes the compact bar's height (about 40) while compact.
5. The layout (full or compact) and the compact position are remembered in a small file next to `browser.json`, so a restart, or opening from the tray, returns to the last one. Maximising a compact window leaves compact view.
6. Main also pushes `celeste:layout-changed`, so the tray menu and the shortcut and the button all end up in the same state.

**The change is animated** (added after the first build). The page fades out (90 ms), the window glides to its new size and place (220 ms, eased, about 60 steps a second from a timer, since Windows has no native window animation), and the page, now in its new layout, fades in. The page is told when it starts (`celeste:layout-start`) and when it is done (`celeste:layout`), so neither layout is ever drawn at a size between the two. Changing your mind part way (the shortcut asks the main process to toggle, from the shape the window is going to have, so a quick second press goes back) stops the animation and goes the other way from where the window is. It **ignores the system's "reduce motion" setting** (decided by the owner on 15 November 2026: Windows' animation effects are often off for speed, and then the window would only ever jump); only a window that is hidden or minimised changes at once.

### 4.3 What the compact layout shows

- **Header (about 40 px):** the small logo, three icon-only mode tabs (Chat, Develop, Workflows) with the busy dots the top bar already has (`BusyDot`), a pin (on top / not), **Full view**, and the window buttons. No sidebar, no search box, no account menu.
- **A session:** the conversation as in Chat, but compacted: smaller type, less padding, no time stamps, tool calls and thinking folded to one line each (Chat already folds everything, `Timeline.tsx:186`; compact uses that for Develop too), diffs and file cards as one-line chips. Under it, the same message box with a **one-line control row**: attach, model, and a "…" menu holding the rest (effort, approval mode, folder), because the full row (`Composer`, `controls.tsx`) does not fit in 480 px.
- **Cards that ask you something** (approvals, questions, the desktop-control card) must work fully here. They are the main reason to glance at a small window, so they are tested at 400 px wide.
- **The right-hand panels** (tools, files, changes, terminal, browser) are not shown. A card that needs room (a diff, a file preview, the browser) has "Open in full view", which leaves compact, with that panel open.
- **Dialogs that need width** (Settings, the setup wizard, add device, folder picker) leave compact view first and open in the full window; the search dialog stays (to check at 480 px).
- **Desktop control** keeps working: Celeste's own windows are already hidden from the screen the assistant sees (`desktop.owns`), and a pinned compact window is a good place to watch it and press stop.

### 4.4 When no session is chosen (the owner asked me to think about this)

The full home (a 54 px greeting, the glow arc, three wide suggestion pills) cannot be squeezed into 520 px, and the sidebar that normally lists sessions is gone. So the compact home **is** the sidebar plus a quick ask. From top to bottom:

1. **Needs you** (only when something does): a strip with the chat's title and what it asks ("Run npm test?"), with Allow and Deny right there, and a link to the chat. Any mode, not just the one shown. This is the best thing a small window can do.
2. **The message box**, with the same one-line control row, focused. Typing and sending starts a new chat (or a Develop session) and the view becomes that session.
3. **Recent sessions** for the current mode: pinned first, then the newest six, each with its working dot or "Needs you" (the same `needsYou` the sidebar uses), tap to open. "Show all" goes to full view.
4. **Continue** is the first row of that list, picked out: "Continue: <title of the last session>".
5. **Develop** adds its project choice (the `ProjectBar`) as a row of the three most recent projects under the box, since a Develop session needs a folder.

Left out on purpose: the greeting, the arc and the generic suggestion pills (decorative at this size). A few words of greeting ("Good afternoon, Dvir") are one small line above the box, so it still feels like Celeste.

### 4.5 When the Workflows tab is active

The canvas editor cannot work in 520 px, and a small window is wanted for watching and starting, not designing. From top to bottom:

1. **Running now:** each live run with its workflow, the step it is on ("Step 3 of 6: Find old KBs"), elapsed time, **Stop**, and, when a run is at its approval card, that card inline with Allow and Deny. This is the workflow equivalent of "Needs you".
2. **Workflows:** a list, each row with a **Run** button, the last result and, once scheduling exists, the next time ("Daily 09:00"). Run opens a compact form for the inputs, then the usual card.
3. **Recent runs:** the last five, tap for the run's log in a compact `RunPanel` (steps folded, output at the end).
4. A footer line: "Edit, build with AI and import are in the full view" with the button.

# 5. How it is built

**Part 1:** `main/tray.ts` (the icon, the menu, the tooltip, the dot), changes in `main/index.ts` (`window-all-closed` no longer quits; `close` hides unless quitting; `second-instance` shows; the first-hide notice; the notification for a hidden window), and a small `shouldQuitOnClose(state)` function so the rule is tested without Electron. One setting (decision 2).

**Part 2:**
- `shared/bridge.ts` and `preload/index.ts`: `layout.set({ compact, pinned })`, `layout.onChange`.
- `main/compact.ts` (bounds maths, remembered file) and the `celeste:layout` handler.
- `stores/ui.ts`: `compact`, `compactPinned`. `App.tsx` chooses between the full layout and a `CompactApp`; both use the same stores. A short fade hides the moment the window changes size.
- New under `renderer/features/compact/`: `CompactApp`, `CompactHeader`, `CompactHome` (4.4), `CompactWorkflows` (4.5), `CompactControls` (the one-line row). `ConversationView` gets a `compact` flag (smaller padding, no 820 px column, folded blocks).
- Shortcut Ctrl+Shift+M (free: `App.tsx` uses Ctrl+B, Shift+B, K, comma, 1 to 3 and N).

**Tests:**
- `compactBounds` and `fitOnScreen`: taskbar at the bottom, left and top; a second monitor with a negative origin; a saved position on a screen that is gone; a 125% and 150% display; a work area smaller than the window.
- `shouldQuitOnClose`: close with the window visible, hidden, quitting, an update install.
- Renderer: the compact home shows Needs you first, recent sessions in order, pinned first; the workflows view shows a run waiting on its card.
- `verify:compact` (like `workflows-check.mjs`, with the stand-in Anthropic API): click the button, the window is about 520 wide at the bottom right, no sidebar; send a message, see the reply folded; an approval appears and is answered; click Full view and the old bounds and the open chat are back; close the window and the process is still running (checked from the script), then show it again.
- By hand on Windows 11 (the tray cannot be seen by the script): the icon in the overflow and when pinned, the menu, the quit question, the notification when a chat needs you with the window hidden.

# 6. Order of work

1. Tray and close behaviour, with the notifications (Part 1). Smallest, and it unblocks scheduled workflows.
2. Layout plumbing: the main-process handler, bounds maths, the store, the button, a bare compact shell showing the current session.
3. The compact conversation and the one-line control row.
4. The compact home (4.4).
5. The compact workflows view (4.5).
6. Dialogs that leave compact view, the pin, remembering the position, `verify:compact`, README and CHANGELOG.

# 7. Decisions, with the default I picked

| # | Question | Default | Why |
|---|---|---|---|
| 1 | Does closing the window keep Celeste running? | Yes, in the tray; Quit from the tray or Ctrl+Q | What was asked; also needed for the phone and schedules |
| 2 | Can the person turn that off? | One choice in Settings, General: "When I close the window: keep running / quit", told once in the first-hide notice | A few people will hate it; the owner wants few settings, so this is the only one |
| 3 | Hide or destroy the window? | Hide (instant, nothing lost); measure memory, destroy after some minutes only if it is large | Simplest first |
| 4 | Start with the computer? | Not in this plan's first step; offered when the first schedule is made | Not asked for |
| 5 | Always on top in compact view? | Yes by default, with a pin button to turn it off | It is what makes it a side window; it must be easy to undo |
| 6 | Size and place of the compact window | About 520 by 70% of the work area, bottom right with a 12 px margin, then wherever the person puts it | Matches the third picture |
| 7 | Same window or a second one? | Same window, changed shape | One state, no duplicated drafts |
| 8 | Where is the button? | Right of the avatar, left of minimise | **Confirmed by the owner, 15 November 2026** |
| 9 | Compact home with no session | Needs you, the box, recent sessions, Continue, (Develop: recent projects) | Replaces the sidebar |
| 10 | Compact Workflows | Running now with inline approval, a list with Run, recent runs; editing in full view | Watch and start, not design |
| 11 | Hiding the window while the assistant controls the computer | Stops control | The existing rule: no control with no chat in view |
| 12 | Shortcut | Ctrl+Shift+M | Free |

# 8. Not in this plan, for later

- A **global shortcut** (for example Ctrl+Alt+Space) that shows the compact window with the cursor in the box from anywhere, like a quick-ask bar. It needs a setting (the key can clash) so it is left out for now.
- **Attach what is on screen** (a screenshot or the clipboard) to a compact message. Useful beside other programs, but it touches privacy and deserves its own decision.
- **Docking to a screen edge** with the window snapping and the other windows making room.
- A tray icon on Mac, and a Linux tray fallback beyond minimising.
