# Contributing to Celeste

Thanks for your interest. Celeste is early, so the most useful contributions right now are bug reports, testing on
platforms the maintainer cannot reach (macOS, Linux, real remote machines and phones), and small, focused fixes.

## Run it from source

You need [Node.js](https://nodejs.org) 22.13 or newer (the database is `node:sqlite`, built into Node and Electron).

```bash
git clone https://github.com/AmossDvir1/celeste.git
cd celeste
npm install
npm run dev
```

Connecting GitHub Copilot or Claude works as described in the [README](README.md#getting-started). In development Celeste
finds a vendor program installed on your computer if it is a version Celeste has been tried with.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Both must pass. If you changed something the running app depends on, also run the matching check against the built app
(`npm run verify:persistence`, `verify:package`, `verify:devices`, `verify:checkpoints`, and so on, below). Please do not run
`npm run verify:copilot` or the Copilot and Claude live tests unless you mean to: they use your own accounts and spend your
quota. `npm run verify:claude` is safe: it talks to a stand-in for Anthropic's API on your own computer.

## Guidelines

- Keep a change focused, and explain what it fixes or adds and how you checked it.
- Match the style of the code around your change: naming, comments, and how much of each.
- Add a test with a behavior change. Vendor adapters are tested against recorded or hand-written events, and the app checks run Claude against a stand-in for Anthropic's API, so no account is needed. Test stand-ins live in `src/core/testing`, never in the app.
- Never log or commit keys, tokens, passwords or recordings that contain account details.
- A change to the database is a new migration in `src/core/migrations.ts`, never an edit to a shipped one.
- A device must never run a command without the approval rules in `src/core/devices`. Changes there get extra review.
- Phone control and the phone's abilities keep the rails in [docs/PHONE_PLAN.md](docs/PHONE_PLAN.md) (section 5.1): changes there get extra review too.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app with hot reload |
| `npm run typecheck` | Type-check the interface, the main process and Core |
| `npm test` | Unit tests: storage, sessions, adapters, devices, workflows, the phone bridge |
| `npm run build` | Production build into `out/` |
| `npm run verify:persistence` | Run the built app on one profile, restart and crash it, and check nothing is lost |
| `npm run verify:package` | Run the built app from an `app.asar`, as an installer lays it out |
| `npm run verify:devices` | Run the built app against an in-process SSH server that stands in for a VM |
| `npm run verify:claude` | Drive the real app with the real Claude Code program against a stand-in for Anthropic's API on this computer (no account, no cost) |
| `npm run verify:checkpoints` | Drive a Develop session in the real app: checkpoints before each message, revert, undo, and your project's own git left alone (no account, no cost) |
| `npm run verify:worktrees` | Separate copies of a project (git worktrees) in the real app |
| `npm run verify:terminal` | Drive the real integrated terminal in the real app |
| `npm run verify:files` | Drive a Chat that makes files in the real app: the cards, Open, Show in folder, Save a copy, and what is refused |
| `npm run verify:mcp` | Add and use a tool (MCP server) in the real app |
| `npm run verify:workflows` | Drive the Workflows tab in the real app: building a workflow on the canvas, saving, versions, deleting |
| `npm run verify:workflows-chat` | Start a workflow from a conversation with `/`: the card that asks first, the result, and the assistant being told |
| `npm run verify:workflows-ai` | Build with AI, Make this a workflow, and the assistant running a workflow only when allowed |
| `npm run verify:phone` | Pair the phone app with the real app, chat, start a chat, answer a question, start Develop, approve a command, refuse and remove a phone (no account, no cost) |
| `npm run verify:desktop` | Windows only: moves the real mouse. Not run in CI |
| `npm run verify:browser` | The browser pane in the real app: it opens beside a chat, loads real pages in tabs of its own for each chat, goes back, shows errors and a page's questions, steps aside for dialogs, hands the window's keys back, and opens links from the chat (no account, no cost; a download is only checked to start, because Playwright takes downloads over) |
| `npm run verify:preview` | Files shown inside Celeste, in the real app: the check makes real Word, Excel, PowerPoint, OpenDocument, RTF, Markdown, notebook, JSON, CSV, code, zip, PDF, image and web page files, opens each in a tab of the browser pane and looks at what shows (and the accessibility of each viewer page, in both themes), and that the viewer cannot reach Celeste, the web or other files, and that no viewer tab is visible to the assistant's tools (set `CELESTE_PREVIEW_SHOTS=<folder>` to save a picture of each) |
| `npm run verify:browser-tools` | The assistant's use of the browser in the real app: Claude (the stand-in) opens a page, reads it, clicks, types, fills, takes a picture, reads the console and network, opens and closes tabs, cannot use another chat's tabs, works with the panel closed, is switched off by its setting; asks (Allow for this chat, Always allow, Deny) before acting on a site that is not this computer, and that is listed and removed in Settings; and another program (Playwright, from the check) can connect only while allowed and sees only the browser's tabs |
| `npm run verify:perf` | A conversation of about 150 turns in the real app: how fast it opens, how smoothly a long reply is drawn into it compared with an empty chat, and that the session list holds still while two sessions write (no account, no cost) |
| `npm run verify:ui` | An accessibility audit (axe, WCAG 2.2 A and AA) of every screen in both themes, plus keyboard checks |
| `npm run dist:win` / `dist:mac` | Make the installers (`release/`). See [RELEASING.md](RELEASING.md) |
| `node scripts/installer-check.mjs` | Install what `dist:win` made, run it, and uninstall it (on a Mac: open the packed app and check it) |
| `npm run verify:copilot` | Drive the real app with your real Copilot account (spends a few premium requests) |
| `npm run shots` | Screenshots of the key screens in both themes. Claude's answers come from a stand-in for the API, so the pictures cost nothing |
| `npm run notices` | Write `THIRD_PARTY_NOTICES.md` (run again when dependencies change; `--check` says whether it is current) |
| `npm run mock:phone` | Serve the phone app's clickable HTML mock on your Wi-Fi |

The Copilot live tests are opt-in (`CELESTE_LIVE_COPILOT=1`) because they use a real account.

## Celeste for Android

The app is in `phone/`: a Capacitor app (React screens, with Java for the Android parts). It shares the desktop's protocol, types
and event reducer from `src/`. You need Node, the Android SDK (`ANDROID_HOME`) and Java 21 (the one in Android Studio is found by
itself); [phone/README.md](phone/README.md) has the steps.

```bash
npm --prefix phone install
npm --prefix phone run typecheck
npm --prefix phone run apk        # phone/android/app/build/outputs/apk/debug/app-debug.apk
```

Celeste on the computer hands that APK to phones (Settings → Phone). To try it without a phone, use an Android emulator and type
`10.0.2.2:<port>` for the address, since the emulator cannot see the computer's mDNS announcement. Never use a real Copilot account
in an automated check: app checks start Celeste with `copilotKnowsNoOne` and a stand-in for Anthropic's API.

## How it works

```
 Window (React)  ──message port──▶  Core process  ──▶  vendor adapters ──▶ Copilot SDK / Claude Code
                                        │
                                        ├── SQLite: sessions are an event log, replayed on open
                                        ├── Devices: SSH, Hyper-V, adb, behind approvals
                                        ├── Tool server (MCP, loopback only): devices, workflows, desktop and phone control
                                        └── Phone bridge (Wi-Fi only, off by default): the Android app, encrypted end to end
```

- Each session is an **event log**. Opening it replays the log through the same reducer that handles live events, so a
  restart or crash loses nothing. Each vendor's own resume id is stored too, so a conversation continues natively when the
  vendor still has it, and is rebuilt from Celeste's log when it does not.
- Vendors sit behind one small boundary (`AgentAdapter`, `AgentSession`, `AgentEvent`), so adding a vendor does not touch the interface.
- Secrets stay in Electron's main process (`safeStorage`). Core asks for a device password only when connecting.

```
src/
  shared/      the vendor boundary, the API between the window and Core, and the phone protocol
  main/        the Electron window, the Core launcher, secrets, desktop control
  core/        the Core process: SQLite, sessions, vendor adapters, devices, workflows, the phone bridge, the tool server
  preload/     the bridge the interface calls
  renderer/    the React interface: app shell, chat, develop, workflows, settings, stores
phone/         Celeste for Android
docs/          the plans and images
scripts/       end-to-end checks that drive the built app, screenshot tools
```

## Reporting a bug

Use the bug report form. Include your operating system, what you did, what you expected and what happened. For anything
security related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
