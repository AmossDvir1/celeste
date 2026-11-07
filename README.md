# Celeste

Your AI workbench: one desktop app for Claude, GitHub Copilot, OpenAI and Google Gemini.
Built with Electron, React and Tailwind. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full plan.

## Status: Phase 3, devices

**Nothing talks to a real AI vendor yet**: the assistant, the Connect button's steps, the tools list and the
workflow runs are scripted samples. What is real now: your sessions, settings, drafts and attached files are
saved on this computer (SQLite, in the app's data folder, shown under Settings → Data), and survive closing the
app or a crash. Delete has Undo, search looks inside conversations, and a pasted API key is stored encrypted by
your operating system and never shown again. The window, themes, glow line, composer, workflow canvas, wizard
and settings are as in the design preview.

The sample sessions in the sidebar are added on the first start only. Delete them like any other.

**Devices (new):** Settings, Devices adds other computers and VMs (over SSH, including Windows with its OpenSSH Server),
Hyper-V VMs on this PC, and Android phones (wireless debugging, by QR code or code). A device starts read only. Commands on it
ask for your approval, shown with the exact command, unless you give that device full access, and a device only reaches a chat
you attach it to. A folder on a device can be read live or copied as a read-only snapshot. Passwords are kept encrypted by your
operating system. Android needs Google's `adb` installed (Android Studio's platform-tools), or its path in `CELESTE_ADB`.
Only the scripted assistant uses devices so far, through the same tools the vendors will use. It has not been tried against a
real VM or phone yet; see the plan for what is still to test.

## Run it

```bash
npm install
npm run dev
```

Requires Node 22.13 or newer (the database is `node:sqlite`, built into Node and Electron). `npm run dev:web` runs
only the interface in a browser at http://localhost:5199, with the session code in memory, so nothing is saved
there. It is handy for quick visual checks.

## Looking around

Press **Ctrl+Shift+D** (development only) for the scenario switcher. It jumps straight to each state so you
don't have to wait: thinking, a running tool, `ask_user`, an approval prompt, an error, a long conversation,
a Develop session with diffs, an image attachment, and the setup wizard. It is not part of release builds.

You can also type these in a chat to steer the sample assistant: `ask me` (asks questions),
`simulate error`, or mention a PR, a Jira issue, or a workflow.

| Shortcut | Action |
|---|---|
| Ctrl K | Search chats and workflows |
| Ctrl N | New chat |
| Ctrl 1 / 2 / 3 | Chat / Develop / Workflows |
| Ctrl B | Show or hide the sidebar |
| Ctrl , | Settings |

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-checks the interface, the main process and Core |
| `npm test` | Unit tests: database, migrations, session logic, replay |
| `npm run verify:persistence` | Runs the built app three times on one profile (normal restart, then a crash) and checks that nothing is lost |
| `npm run verify:package` | Runs the built app from an `app.asar`, with its run-time libraries, the way an installer lays it out |
| `npm run verify:devices` | Runs the built app against an in-process SSH server that stands in for a VM: add, confirm the key, attach, approve a command, snapshot, changed key, restart |
| `npm run build` | Production build into `out/` (the app and the Core process) |
| `npm run shots` | Screenshots of the key screens in both themes: `scripts/.output/shots/` |
| `npm run glow:compare` | Renders the Chat home at the reference picture's size and measures the glow line against it |
| `npm run icons` | Regenerates the app icons from `src/renderer/assets/logo/celeste-mark.svg` |

## Logo

`src/renderer/assets/logo/celeste-mark.svg` is the only place the logo lives, and it is an interim trace of the
"C" without the star. To use the final logo, replace that file and run `npm run icons`.

## Vendor logos

`src/renderer/components/VendorLogo.tsx` holds the GitHub Copilot, Claude, OpenAI and Gemini marks, taken from the
MIT-licensed [@lobehub/icons](https://github.com/lobehub/lobe-icons) set. The marks are trademarks of their owners and are
shown only to say which service a control talks to. Before a public release, check each vendor's brand guidelines.

## Layout

```
src/
  shared/      the vendor boundary: AgentEvent, AgentSession, AgentAdapter
  main/        the Electron window, the Core process launcher, secrets, the attachment address
  core/        the Core process: SQLite, sessions, the scripted assistant (core/mock), devices (core/devices)
  preload/     the bridge the interface calls: a message port to Core, and secrets
  renderer/
    app/       shell: top bar, sidebar, layout, scenario switcher
    features/  chat, develop, workflows, settings, wizard, search, tools
    components shared pieces: buttons, menus, dialogs, markdown
    glow/      the glow line
    api/       the client for Core (and an in-memory copy of it for dev:web)
    mocks/     model and tool catalogs for the preview (replaced by real adapters later)
    stores/    app state
    styles/    design tokens for both themes
design/        your pictures and design kits (git-ignored: they belong to their creators)
```
