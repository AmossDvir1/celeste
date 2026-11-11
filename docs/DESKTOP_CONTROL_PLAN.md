# Celeste: Desktop Control Plan

> **Status, 9 November 2026: step 0 (the spike), step 1 (the safe core) and most of step 2 (scope, never list, passwords, a second yes, the pause) are built for Windows, behind a switch that is off by default. Steps 3 to 5 are not.** The owner chose this as the next feature after 1.0.0 and accepted the defaults of D1 to D8. What step 1 is, and what it left out on purpose, is in section 11a; step 2 is in 11b. Referenced from `IMPLEMENTATION_PLAN.md` (decision 15 and section 7.14).

## 1. Summary

The agent gets a set of tools to **see and use this computer**: take a screenshot, move the mouse, click, drag, scroll, type and press keys. It cannot use them until the person says yes. When they do, it can carry out tasks that have no command line or API (clicking through a settings page, filling in a form, using an app that has no automation), with the person watching and able to stop it at any moment.

The idea is small. The safety design is most of the work, because an agent that can click and type can do anything the person can do: send messages, delete things, spend money, change settings. Everything below is built around making that safe enough to offer, and around saying plainly where it is not.

**What you asked for:** a tool the agent uses to ask whether it may control the PC's interface; if the person agrees, full control of the mouse and keyboard to do tasks for them.

**What I propose differently, and why:** "full control" is kept, but it is **granted per conversation, for a limited time, visibly, with a stop that the agent cannot press**. Section 3 explains each rail. Several are things I would not ship without.

## 2. The person's experience

1. The person asks something that needs the desktop ("set my default browser", "fill in this form in the other window").
2. The agent calls `desktop_request_control` with a reason ("I need to click through Windows Settings to change the default browser").
3. Celeste shows its own **consent card** in the conversation, with the reason and three choices:
   - **Allow for this chat, for 15 minutes** (the default button)
   - **Allow until I stop it** (still ends when the chat is stopped or deleted, or Celeste closes)
   - **Not now**
4. Once allowed, Celeste shows a **control bar** (a small always-on-top window) and a coloured border around the screen: "Celeste is controlling this computer. **Stop** (Ctrl+Alt+Esc)". The bar lists the last few actions as they happen.
5. The agent works. Each action is logged in the conversation as a card ("Click Start", "Type 'default apps'"), with a small screenshot of what it saw when it decided.
6. Control ends when: the agent says it is done, the time runs out, the person presses Stop or the hotkey, the person touches the mouse (see 3.4), the chat is stopped or deleted, or Celeste closes. A short summary of what was done stays in the conversation.

Desktop control is **off by default** and needs switching on in Settings (section 9). A denied request is remembered for that chat, so the agent cannot keep asking.

## 3. Safety design

These apply even after the person has said yes. They are the reason the feature is acceptable.

### 3.1 The rails

| Rail | What it does |
|---|---|
| **Off until enabled** | Settings has a master switch, off by default. With it off, the tools exist but every call is refused with a reason, and the agent is told to ask the person to enable it. |
| **Consent is Celeste's own card** | Not the vendor's approval, and not covered by "Auto-approve". Auto-approve never grants desktop control, the same rule that devices follow. |
| **Time limit** | A grant lasts 15 minutes unless the person picks "until I stop it". It can be extended with a click on the control bar. An idle grant (no action for 5 minutes) ends. |
| **One chat** | A grant belongs to one session. Other sessions cannot use it, and a workflow or a second window cannot borrow it. |
| **Visible, always** | The control bar and the border are on screen for as long as control is active. They cannot be turned off from the agent's side, and they are not part of what the agent can click (3.3). |
| **A stop the agent cannot press** | A global hotkey (Ctrl+Alt+Esc, changeable) registered by Celeste, and a Stop button on the control bar. Both end control at once and cancel the action in progress. |
| **The person's own input wins** | Before each action, Celeste compares where the mouse is with where it left it. If the person moved it, control **pauses** ("You moved the mouse. Continue or stop?"). Keyboard use is not detectable without a system-wide input hook, which would be a larger and more suspicious dependency, so the hotkey and Stop button are the keyboard answer. |
| **Action log** | Every action is written to the session log with its arguments, so what happened can be read afterwards. Screenshots are shown while it happens and are **not** stored in the log by default (only a small one with each action card, kept with the session, deletable with it). |
| **Rate limit** | At most a few actions per second, and a cap on actions per grant (for example 500), so a loop cannot run away. |

### 3.2 Things the agent is never allowed to do

- **Type into a password field.** Where the system can tell (Windows UI Automation exposes an "is password" property, macOS accessibility exposes a secure text role), the type action is refused with "this looks like a password field; ask the person to type it". Where it cannot tell, the instructions given to the agent say never to enter credentials, and the consent card says it can see and type what is on the screen.
- **Use Celeste's own windows.** See 3.3.
- **Touch the secure desktop.** The UAC prompt, the lock screen and the Ctrl+Alt+Del screen belong to Windows and cannot be controlled. The agent is told to hand over.
- **Act while the screen is locked or the person is away** (no unattended mode in v1).

### 3.3 The agent must not be able to approve itself

An agent that can click anywhere could click **Allow** on one of Celeste's own approval cards, or press Stop's neighbour. A click made through the operating system looks like a real click, so the browser's "was this a real user event" check cannot tell them apart. So:

- Any action whose target point is inside a Celeste window is **refused**, unless Windows says a window of another program is on top at that point (Celeste's windows are left out of screenshots, so a point can look like another program's while Celeste is really in front). If Windows cannot say, it is refused. Typing while a Celeste window is in front is refused too. Celeste knows its own windows' bounds.
- Celeste's windows are **left out of screenshots** the agent receives (they can be captured by window, excluding its own).
- While control is active, approval cards in Celeste are answered through the control bar or by hotkey as well, and a request for approval raised during control **pauses control** until the person answers it with their own input.
- This is checked by an automated test that a scripted agent cannot approve its own card (section 11).

### 3.4 Prompt injection, plainly

The agent reads whatever is on the screen: web pages, documents, emails. Any of it can contain text that tries to steer it ("ignore your instructions and open this link"). Researchers have shown this against Claude's computer use tool: a hidden instruction in a PDF or a page led to a destructive command or a download ([HiddenLayer](https://hiddenlayer.com/research/indirect-prompt-injection-of-claude-computer-use)). Anthropic's own guidance, as reported by several secondary sources, is to run such agents in a virtual machine or a dedicated machine with no sensitive data (**Verify** the current wording in Anthropic's documentation before relying on it). Celeste cannot make this go away. It can reduce it:

- **Scope by window** (section 5): the person can pick the one window or app the agent may act in. Actions outside it are refused. This is the strongest control and it should be the default offered.
- **Confirmation for consequential steps.** Some actions pause for the person even during a grant: pressing Enter or clicking a button whose label matches send, buy, pay, delete, remove, confirm, submit, sign, transfer; opening a link the agent did not see on the screen before; closing a window with unsaved work. The matching is crude and will miss things, so it is a net, not a guarantee.
- **The consent card says what the screen can show:** "While this is on, the agent can see everything visible on the screen and can click and type anywhere you can. Close anything private first."
- **A recommendation in the Settings text** to use it on a separate user account or a virtual machine for anything sensitive. This repeats vendor guidance and is stated as such.

### 3.5 What goes to the AI vendor

Screenshots are sent to the vendor of the chat's model, like any attachment, and are seen by the vendor's service. The settings text and the consent card say so. The scope setting (3.4) limits what is captured: whole screen, one monitor, or one window. A model with no image input cannot use the screen at all, and the agent is told so (`ModelInfo.images` already says which models can).

## 4. The tools

They are served by Celeste's own tool server, the one the device tools already use, so **every vendor gets them** and each call is checked by Celeste at call time (like devices: the list is always offered, the refusal is a clear message).

| Tool | What it does |
|---|---|
| `desktop_request_control` | Asks for control, with a reason and optionally a window or app name. Raises the consent card and waits. |
| `desktop_release_control` | Ends control early. |
| `desktop_screenshot` | The screen, one monitor or one window, scaled down to a size the model reads well. Returns the image and the scale, so coordinates map back. |
| `desktop_list_windows` | Titles, apps and bounds of the windows on screen, so the agent can aim at one. |
| `desktop_focus_window` | Brings a window to the front (refused for Celeste's own). |
| `desktop_move`, `desktop_click`, `desktop_double_click`, `desktop_drag`, `desktop_scroll` | Mouse actions at screen or window coordinates. |
| `desktop_type` | Types text (refused in a password field and while a Celeste window is in front). |
| `desktop_key` | Presses a key or a combination (Enter, Ctrl+C, Alt+Tab, and so on). Some combinations are refused (Ctrl+Alt+Del cannot be sent anyway; Win+L, shutdown and sign-out shortcuts are blocked). |
| `desktop_wait` | Waits a short time for something to appear. |
| `desktop_ui_tree` (later) | The accessibility tree of a window: buttons, fields and their names, so the agent can click "Save" by name instead of by pixel. More reliable than pixels, and it also gives the password-field check. |

Vendor-neutral tools mean Celeste owns the safety rails regardless of model. Claude also has its own computer-use tool; Celeste should **not** enable that one, because its calls would bypass these checks. (**Verify** how each vendor's agent treats MCP tools that return images; the device tools return text only so far.)

## 5. Scope

| Scope | What it limits | Use it when |
|---|---|---|
| **One window** (recommended) | Screenshots show only that window; clicks and keys are refused unless that window is in front and the point is inside it | The task is in one app |
| **One app** | The same, for all the app's windows | A task spans a few dialogs of one app |
| **One monitor** | Screenshots show that monitor | A task crosses apps |
| **Everything** | The whole desktop | Rarely; the consent card makes the person choose it on purpose |

The agent can ask for a scope in `desktop_request_control`; the person can change it on the card.

## 6. Seeing and doing

### Seeing

- **Screenshots** with Electron's `desktopCapturer`, which works on all three systems (on macOS it needs the Screen Recording permission). Images are scaled so the longer side is about 1,500 pixels, and the scale is returned with each image, because models aim poorly on very large images and DPI scaling would otherwise move every click.
- **Windows and their bounds** from the system (a small native helper or Electron's own APIs for Celeste's windows only).
- **Accessibility tree** (Windows UI Automation, macOS AX, Linux AT-SPI): later, and the best way to be exact and to detect password fields.

### Doing

| Option | For | Against |
|---|---|---|
| **nut.js** (the `@nut-tree-fork/nut-js` package, listed as Apache-2.0 on the registry page I found) | A maintained-looking API for mouse, keyboard and screen on all three systems | The fork's maintenance and the licence of the original were not confirmed, and Electron use is untested here: **Verify** before choosing |
| **robotjs** | Well known | Upstream is effectively dead and the nut-tree fork of it is archived; avoid |
| **Our own small native helper** (Windows `SendInput`, macOS `CGEvent`, Linux XTest) | No third-party risk; exactly the calls we need; easy to refuse unsafe ones | Real work to write, sign and test on three systems |
| **PowerShell with `Add-Type` on Windows** | No dependency for a first spike | Antivirus products dislike it; slow; Windows only |

**Proposal:** spike on Windows with the nut.js fork. If it is healthy and installs cleanly in a packaged build, keep it behind our own driver interface. If not, write the small native helper. Either way, all input goes through **one driver interface** (`move`, `click`, `type`, `key`, `scroll`, `screenshot`) so the tests can use a fake and the library can be replaced.

## 7. Each system

| System | Works | Limits |
|---|---|---|
| **Windows** (the development system) | Capture and `SendInput` work for normal windows. | **UIPI:** input sent from a normal program to an elevated window (run as administrator) is dropped. The agent cannot control those windows, and is told why. Working around it needs a signed build with the UIAccess setting installed in a protected folder, which is a decision of its own (**Verify**, [Microsoft's UAC policy notes](https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/user-account-control-only-elevate-uiaccess-applications-that-are-installed-in-secure-locations)). The UAC prompt and lock screen are never controllable. |
| **macOS** | Works once the person grants **Accessibility** and **Screen Recording** to Celeste in System Settings. | Celeste must be signed and notarized, or the permissions are lost on each update. The wizard must explain the two prompts before they appear. **Verify** the exact Electron calls to check and request them. |
| **Linux** | On X11, synthetic input through XTest works. | On **Wayland**, applications cannot send input to others by design, except through the desktop's remote-desktop portal, which asks the person and varies by desktop. Out of the first version. (**Verify**) |

Multiple monitors and mixed DPI are handled in the driver: coordinates given to the tools are in the screenshot's own pixels and converted there.

## 8. How it fits the rest of Celeste

| Feature | How |
|---|---|
| **Approval modes** | Desktop control is outside them: Auto-approve never grants it, and the consent card is its own. |
| **Devices** (section 7.11 of the main plan) | Different thing. Devices are other machines reached by SSH; this is the screen of the computer Celeste runs on. A later extension could control a VM's screen through the hypervisor's console, which has the same tools and rails. |
| **Shared sessions** (7.13) | A guest can never grant, use or see a desktop control grant. The feature is host-only, and screenshots would not be shown to guests unless the host chooses. |
| **Phone companion** (7.12, Phase 9) | Control cannot be granted from a phone. The consent must be given at the computer, because a stolen or compromised phone must not be able to hand an agent the mouse. A phone may see that control is active and press Stop. |
| **Workflows** (7.10) | A step can use the computer (a **Use the computer** step, built: section 11c), but never unattended: the person is asked on the run's own card each time the step starts, the Settings switches apply, and control ends with the step. A run that starts from `/` in a chat gets its own grant per step, not the chat's. |
| **Checkpoints and review** (Phase 6) | Cover the project folder, not the desktop. A click cannot be undone by Revert. The consent card says so. |
| **Vendors** | The same tools for all. Models without image input cannot use the screen tools. |

## 9. Settings

A **Desktop control** section in Settings:

- A master switch, **off by default**, with a short explanation.
- Default scope offered on the consent card (window, app, monitor, everything).
- Default duration (15 minutes) and the hotkey.
- A list of apps that are **never** controllable (empty by default, with a few suggestions: password managers, banking apps), and a note that the list is only as good as what the person adds.
- On macOS, a status line for the two permissions, with buttons that open the right System Settings pages.
- A **log** of recent grants: when, which chat, how long, how many actions.

An organisation that does not want this at all can disable it for everyone through a managed setting (**decide later**, with the other company features).

## 10. Privacy

- Nothing is captured while no grant is active.
- Screenshots go to the chat's vendor while a grant is active (3.5). The log keeps actions, not screens; each action card keeps one small image, deleted with the session.
- Celeste has no server and sends nothing to anyone else.

## 11. Build plan and tests

**Step 0, a spike (Windows only, about a day).** Prove the driver: capture a window, move and click, type, press the hotkey to stop, from a throwaway script inside Electron. Decide nut.js or the native helper. Check that a packaged build still works.

**Step 1, the safe core.** The driver interface and a fake driver; grants (per chat, time limit, stop); the consent card; the control bar, border and hotkey; the action log; the tools through the tool server; refusing Celeste's own windows; rate limits. Windows only.

**Step 2, scoping and checks.** Scope by window and app; password-field detection through UI Automation; the confirmation list for consequential actions; pause when the person moves the mouse.

**Step 3, macOS.** Permissions flow in the wizard and Settings, signing and notarization dependency, the same driver tests on a Mac.

**Step 4, Linux on X11.** Wayland stays out until the portal route is understood.

**Step 5, the accessibility tree tool** and polish.

**Tests**

- **Fake driver:** every tool, every refusal, the time limit, the rate limit, the release on stop, and that a grant cannot be used by another session.
- **A test window of our own:** a small window that the real driver clicks and types into, and that reports what arrived. This checks the real input path without touching the person's real desktop.
- **The self-approval test:** a scripted agent tries to click Celeste's Allow button and press its Stop; both must be refused.
- **Contract suite:** the desktop tools join the vendor contract tests (a call from each vendor's agent reaches the tool server and is refused or allowed correctly).
- **A manual safety review** before release: the checklist in section 3, tried by hand on a clean Windows account and a clean Mac.

## 11a. Step 1: what is built (9 November 2026)

**Built and tried (Windows):**

- **The tools** on Celeste's own tool server (so every vendor has them): `desktop_request_control`, `desktop_release_control`, `desktop_screenshot`, `desktop_move`, `desktop_click`, `desktop_double_click`, `desktop_drag`, `desktop_scroll`, `desktop_type`, `desktop_key`, `desktop_wait`. None is marked read only, so an agent that is only planning cannot use them.
- **Off until switched on**: Settings, Desktop control (off by default). With it off, every call is refused with the reason.
- **Consent is Celeste's own card** (the same kind of card the device commands use, which Auto-approve never answers): the reason, what the screen can show, where the stop is. Choices today: **Allow** (15 minutes, one chat) and **Deny**. A "no" is remembered for that chat. "Until I stop it" is **not built**: the bar's **+15 min** button extends instead.
- **The rails:** one chat at a time; 15 minutes, 5 minutes idle, 500 actions; at least 250 ms between actions (a loop is slowed, not refused); one action at a time; the stop ends it and drops anything waiting; control ends with the chat, with Celeste's last window, and when Core restarts.
- **A stop the assistant cannot press:** the control bar (always on top, not focusable, with **Stop** and **+15 min**, the time left and the last three actions), a border round the screen, and a global **Ctrl+Alt+Esc**. If the key is taken by another program, control does not start. The assistant cannot send that key, Win+L or Ctrl+Alt+Delete.
- **Celeste's windows are untouchable:** a click, move, scroll or drag that starts or ends on a Celeste window (the bar included) is refused, and so is typing or a key while one has the keyboard. A point inside a Celeste window's bounds is allowed only where Windows says another program's window is in front of it (so a big Celeste window behind Photoshop does not block Photoshop). While control is on, every Celeste window is left out of screenshots (Windows' capture exclusion). Checked in the real app: a click on Celeste's own Settings button was refused and Settings did not open.
- **The record:** `desktop.started`, `desktop.action` and `desktop.ended` events in the session log, shown as one card in the conversation (why it asked, each action or refusal, how it ended). Screenshots are not stored.
- **Seeing and aiming:** the main display only, as a JPEG with the longer side at most 1,500 pixels; the assistant aims in the picture's pixels and Celeste converts them (a display scaled above 100% is handled in the conversion, **not yet tried on one**).
- **Input** by koffi calling `SendInput` (decision D4), behind one driver interface; koffi's binary is unpacked from the archive (checked in the packed app and by the installer check).

**Tried:** 54 + 28 unit tests (the rails with a fake computer; the main-process decisions with the screen, windows and input stood in for) and `npm run verify:desktop`, which runs the built app (and, with `CELESTE_ENTRY`, a packed one) and the real mouse and keyboard against a window of its own: off by default, the card, a "no" remembered, a real click and real typing arriving, a click on Celeste refused, the stop key refused as a key, Stop on the bar and Ctrl+Alt+Esc each ending it at once, no window left behind. It moves the real mouse for about a minute and is not part of CI.

**Left out of step 1 on purpose (most of it is built in step 2: see section 11b):** scoping to one window or app (the whole main display today); other monitors; `desktop_list_windows`, `desktop_focus_window` and the accessibility tree; **password-field detection** (today only the instructions and the card's warning); the **confirmation list** for send, buy, pay, delete and similar; **pausing when the person moves the mouse**; pausing control while another approval card is waiting; the settings for default scope, duration, hotkey and the never-control list; the log of recent grants; "until I stop it"; a small image kept with each action card; macOS and Linux (on those the request says plainly that it works on Windows for now).

**Not verified:** a real vendor's agent using it (the checks use a stand-in for Anthropic's API, which returns the screenshot as an image in a tool result; whether each real model reads it well, and how Copilot treats an image from a tool, is still **Verify**); a display scaled above 100%; programs running as administrator (expected to be refused by Windows, and the tool says so if `SendInput` is rejected); antivirus products' reaction to `SendInput` from an installed copy; vendor terms (section 12).

## 11b. Step 2: what is built (9 November 2026)

**Built and tried (Windows):**

- **Scope.** `desktop_request_control` takes `app` (a program, such as "notepad") or `window` (part of a title), not both. Core finds it among the open windows before any card is raised (and does not say which windows exist when none matches: titles can be private). The card names it ("Let the assistant use “notes.txt - Notepad” for 15 minutes", "and nothing else"), and so do the bar ("Can use: …") and the text the assistant gets back. With neither, it is the whole main screen, and the card says more strongly to prefer one window. The tool text tells the assistant to ask for one program or window whenever the task is in one.
- **What the picture shows.** The window and anything it owns (a Save As dialog, a menu) as one box, cropped to it; the rest is painted black. A window in front of it, another program, the desktop and the taskbar are black. A program's scope is the whole display with everything else black. The whole screen is the whole display, except windows on the never list, which are black. The picture comes from the screen, so it is what a person would see.
- **What it may click and type in.** Each point (a click, a move, a scroll, both ends of a drag) is asked of Windows when the action runs: which window is there? It must belong to the scope (a window and what it owns; a program by name) and not be on the never list. Typing and keys check the window that has the keyboard the same way. A window in front of the one it was given is refused, and the refusal says so and points to `desktop_focus_window`. A closed window ends it (the assistant is told).
- **The never list** (Settings, Desktop control, "Never touch these"): program names or words in a window's title, comma separated. It applies whatever scope was given, hides those windows in pictures, refuses clicks and typing, and is left out of `desktop_list_windows` and of the window the assistant may ask for. A change counts at the next action. Empty by default.
- **`desktop_list_windows` and `desktop_focus_window`.** The list has a number, the program, the title, and which is in front, and only what is inside the scope and not on the never list (Celeste's own windows never). Bringing one forward is refused for anything outside that.
- **Password fields.** Before typing, Celeste asks Windows (UI Automation, called through koffi: no extra program) whether the field that has the keyboard takes a password, twice, 200 ms apart, because a browser's page describes itself to the system only after it has been asked once (a first look is also taken whenever a picture is taken). If so, the typing is refused with a message that tells the assistant to ask the person; what it tried to type is **not** written to the conversation or shown on the bar ("Type into a password field"). If Windows cannot say, typing goes ahead (the instructions and the card already say never to type a secret).
- **A second yes.** A left click on something called Send, Buy, Pay, Order, Delete, Remove, Confirm, Submit, Sign, Transfer, Post, Share, Accept, Agree, Allow, Install and a few more words (also Enter or Space when the field that has the keyboard is called that) raises another card of Celeste's own, with the name and a warning. Deny is passed back as a refusal and "do not try again". A net, not a guarantee: it goes by the name Windows gives the button.
- **The person's hand wins.** The place the mouse was left is compared with where it is before every action. More than 12 pixels away means the person moved it: the action is held back, the bar shows "You moved the mouse" with **Continue** (and Stop), and the same action is made after Continue, from where the mouse now is. Keyboard use is not detected (the stop key and Stop are the answer). If the person does not come back for a minute, the assistant is told and the pause stays.
- **A question in Celeste holds control.** While any approval or question of that chat is open (the agent's own, or one of Celeste's cards), the next action waits (up to a minute, then the assistant is told to try again), and the bar says why.
- **The conversation** shows a pause and a Continue as notes (a pause icon, not a tick or a refusal).
- **Settings text** explains scope, the second yes, passwords and the pause.
- **How long one yes lasts** (Settings): 15 minutes (the start), 1 hour, or "until I stop it". The card says which. "Until I stop it" is twelve hours at most, and every choice still ends after five minutes with nothing done and after 500 actions. The bar's **+15 min** never shortens a longer grant; for the long choice the bar says "until you stop it" instead of a clock.
- **Let it ask for the whole screen** (Settings, on to start with). Off: a request that names no program or window is refused before any card, and the assistant is told to name one.
- **Recent times the assistant had the screen** (Settings): the last twenty grants, newest first: when, why, what it could use, how long, how many actions, how it ended. Kept in Celeste's own settings table, written when control ends; a list that cannot be kept does not stop control ending.

**Tried:** 77 more unit tests (the scope, never list, window list, focus, inspection, the pause and the waits, with Windows' answers stood in) and, in `npm run verify:desktop`, in the real app with the real mouse: a window of our own with a second window over part of it. The picture is the window's size; the covered part is black in the picture and the rest is shown; a click there is refused and never reaches the window in front; the window list has the one window; bringing the other forward is refused; a password field in a real page is recognised (Chromium answers through UI Automation) and nothing is typed; a button called "Delete everything" asks first, a Deny does not press it, an Allow presses it once; moving the real mouse pauses the next click, Continue makes it; a program on the never list is refused even with the whole screen and is black in the picture.

**Left out (still to do):** a setting for the stop key (it is Ctrl+Alt+Esc, fixed); a small image kept with each action card; changing the scope on the card (today the person denies and asks again); other monitors for the whole-screen scope (a window's picture is taken from the monitor it is on); choosing a window that is minimized (the assistant is told to bring it forward, but cannot ask for it as the scope); the accessibility tree tool (step 5); macOS and Linux (steps 3 and 4).

**Not verified:** a real vendor's agent using any of this (as in 11a); a display scaled above 100%; programs run as administrator; a browser page's password field in Chrome or Edge rather than our own Electron page (same engine, not tried); a password field in a program whose controls do not report it; rounded window corners (the black boxes are rectangles); what the names of buttons are in languages other than English (the net is English words).

## 11c. In workflows and in chats (9 November 2026)

- **A "Use the computer" step.** An assistant step with a switch, **Use the computer**, and a choice of the whole screen, one program or one window (the palette's "Use the computer" makes one). Before the step runs, the run's card lists it ("Use the computer (only the window “…”; you are asked when it starts)"). The step is told to call `desktop_request_control` with that program or window and a reason, and to release when done. The person's yes is asked **on the run's own card** (a step has no chat); a no ends the step's use of the screen. The run refuses to start when Desktop control is off in Settings, or when the step asks for the whole screen and Settings does not allow it. Control ends with the step. Such a step has fifteen minutes before it times out (the usual five for others), since it waits for a person and then works through a screen.
- **Any step** that asks for control by itself (it has the tools like a chat does) is asked the same way in the run; before this, its card went to a chat that does not exist and the step would have hung.
- **A shared workflow file** with such a step says on opening that it will ask to use the screen.
- **In chats** the tools were already there. `/computer` in the message box starts a sentence ("Use my computer to "), or opens Settings, Desktop control when it is off.
- **Not done:** the run's panel does not list the actions (the bar on screen and the grant list in Settings do); desktop control does not pause for a question that is open in a run; a schedule or other unattended start cannot use it, and must not.

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Prompt injection through the screen** steers the agent to do harm | Scope by window, confirmations for consequential actions, time limits, visible control and Stop, advice to use a separate account or VM; it cannot be eliminated and the consent card says so |
| **The agent approves itself or hides the stop** | Celeste's windows are untouchable and left out of screenshots; approvals pause control; tested |
| **Typing a secret** | Password-field refusal where detectable; instructions; the card's warning |
| **The person cannot stop it** | Hotkey and button the agent cannot reach, mouse movement pauses, time limit, and control ends with the chat or the app |
| **Library trouble** (maintenance, packaging, antivirus) | One driver interface, a spike first, a native helper as the fallback |
| **Permissions confuse people** (macOS prompts, Windows elevation) | Explain before asking, say plainly what cannot be controlled and why |
| **Vendor terms** | Desktop control through our own tools is the person's own use of their own agent; a vendor's own computer-use product has its own terms. **Verify** that none of the three vendors' terms restrict an agent that drives a desktop through a tool |
| **Liability** | The feature is opt-in, says what it can do, and logs what it did. Have the wording reviewed before release |

## 13. Decisions for you

| # | Question | Default |
|---|---|---|
| D1 | Should this ship in the first public release, or after it? | After it. It is the riskiest feature in the plan, and the release should not wait on it |
| D2 | Default scope offered on the consent card | One window, with "Everything" a deliberate choice |
| D3 | Grant length | 15 minutes, extendable, with "until I stop it" available |
| D4 | The input library | Spike nut.js first, native helper if it is not healthy |
| D5 | Use Claude's own computer-use tool as well? | No: our tools carry our rails for every vendor |
| D6 | Allow unattended control (screen locked, person away)? | No |
| D7 | Windows UIAccess (control elevated windows) | No; say plainly that elevated windows cannot be controlled |
| D8 | Where it sits in the phases | Proposed after Phase 7 (Workflows), as its own phase, starting with the spike |

## 13a. Spike log

**9 November 2026, step 0 started.**

- **nut.js fork: not healthy.** `@nut-tree-fork/nut-js` 4.2.6 and its native part `libnut` were last published on 15 March 2025, about twenty months ago, and the native part has to match Electron's version. D4's default ("native helper if it is not healthy") applies.
- **A third option found: `koffi`** (MIT, no dependencies, prebuilt for Windows, macOS and Linux, last published 5 November 2026). It lets Node call the system's own functions (Windows `user32.dll`: `SetCursorPos`, `SendInput`, `GetCursorPos`) with no compiling and no helper program to sign. It fits behind the one driver interface, and the same library can later call `CGEvent` on macOS and XTest on Linux.
- **Worked:** from plain Node on this PC, koffi read the pointer position, moved it 40 pixels and put it back exactly.
- **Worked, inside Electron 45.2.3 on this PC, against a test window of our own** (a throwaway script outside the repo): a real `SendInput` click on a button (the page counted one click); a click into a text field and typing `Hello from Celeste ✓` as Unicode key events (it arrived intact, including the tick mark); capture of that one window with `desktopCapturer` (1500 pixels wide, and the window's media source id matched, so one window can be picked out of eleven); and Ctrl+Alt+Esc registered with `globalShortcut` and fired when the keys were sent by `SendInput`.
- **Worked from a packaged archive:** koffi and its Windows binary packed into an `app.asar` with `*.node` unpacked, then run by Electron from the archive: `GetCursorPos` returned the pointer. So the packaging need is the same `asarUnpack` as for the terminal's pty.
- **Packaging detail:** koffi 3 keeps its binary in a per-platform package (`@koromix/koffi-win32-x64`, and one each for the other systems), the same shape as the packages that broke `npm ci` on CI earlier. The lockfile must list every platform's package, and `scripts/lib/runtime-packages.mjs` must carry the right one into each installer.
- **Decision for D4:** koffi behind our own driver interface. No helper program.
- **Not yet proven:** a display scaled above 100% (this PC is at 100%, so the DPI conversion is untested), macOS and Linux calls, how antivirus products treat `SendInput` from an installed copy, and the installed app rather than a script. A screen-capture size cap and the window-list call (`EnumWindows`) are step 1 work.

## 14. Sources

- HiddenLayer, [Indirect prompt injection of Claude computer use](https://hiddenlayer.com/research/indirect-prompt-injection-of-claude-computer-use).
- Simon Willison, [Anthropic's new Computer Use capability](https://simonwillison.net/2024/Oct/22/computer-use) (a summary of the launch and its warnings).
- Microsoft, [User Account Control: Only elevate UIAccess applications that are installed in secure locations](https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/user-account-control-only-elevate-uiaccess-applications-that-are-installed-in-secure-locations).
- The nut.js author's notes on moving from robotjs to libnut ([DEV Community](https://dev.to/s1hofmann/nut-js-two-years-recap-39gh)) and the archived [nut-tree/robotjs](https://github.com/nut-tree/robotjs).
- Anthropic's computer-use documentation: **not read directly for this plan.** Everything above attributed to it comes from secondary sources and must be checked against the current documentation first.

## 15. Changes after the first release (11 Nov 2026)

- **How long one yes lasts is asked on the card.** The setting (15 minutes, 1 hour, until I stop it) is gone. The card has a slider: 20 minutes to start, 5 minutes to 2 hours in steps of 5, and a tick box **Until I stop it** (twelve hours at most, and it still ends after five minutes of nothing). A step of a workflow, which has no slider, gets 20 minutes.
- **+15 min on the bar** still adds time (at least 15 minutes from now) and never shortens a grant.
- **The whole-screen switch is gone.** A request that names no program or window raises the card with the strong warning and the way out (say no, ask for one window). A workflow step that names no window is no longer refused up front.
- **Settings, Desktop control** keeps the master switch and "Never touch these". The recent grants appear only when there are some, and the long text is two lines and a fold.
