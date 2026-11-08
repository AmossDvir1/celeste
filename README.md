<div align="center">

<img src="resources/icons/celeste-256.png" alt="Celeste" width="96" height="96" />

# Celeste

**One desktop workbench for Claude, GitHub Copilot, OpenAI and Google Gemini.**

Use each vendor's own agent from a single, fast interface, with your sessions saved on your computer and every
action under your control. No Celeste server, no account with us: your usage goes to your own vendor account.

[![CI](https://github.com/AmossDvir1/celeste/actions/workflows/ci.yml/badge.svg)](https://github.com/AmossDvir1/celeste/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-early%20development-c2417d)
![Electron](https://img.shields.io/badge/Electron-45-47848f?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)

<img src="docs/images/chat.png" alt="A Celeste conversation with a table, code and a numbered list of next steps" width="880" />

</div>

## Why Celeste

- **Your choice of model, one place to work.** Switch between Claude, Copilot, OpenAI and Gemini models in the same
  conversation, and pin the ones you use most to the top of the model menu.
- **Their agents, not a re-implementation.** Each vendor's official CLI or SDK does the work underneath (reading and
  editing files, running commands, calling tools), so you get the vendor's real behavior, and Celeste adds the interface.
- **You approve what matters.** Choose when the agent may act: automatically, ask before edits, ask for everything, or
  plan only. Commands on a remote machine always show the exact command and ask first.
- **Your data stays yours.** Sessions live in a local SQLite database. Keys are stored encrypted by your operating
  system. There is no Celeste backend to send anything to.
- **Chat and Develop.** Chat is for questions, analysis and writing. Develop works in a project folder, with inline diffs
  and a Changes panel.
- **Devices.** Give the agent other computers, VMs and Android phones as context or as places to work, read-only by default.

<table>
  <tr>
    <td width="50%"><img src="docs/images/develop.png" alt="Develop mode with inline diffs and a Changes panel" /></td>
    <td width="50%"><img src="docs/images/light.png" alt="The light theme" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Develop: tool calls and diffs next to the conversation</sub></td>
    <td align="center"><sub>Light and dark themes</sub></td>
  </tr>
</table>

## Status

Celeste is in early development and not released yet. Nothing in the app is pretended: a vendor is there only if it is connected, and what is not built yet says so.

| Area | State |
|---|---|
| GitHub Copilot | **Working.** Streaming, tools, approvals, `ask_user` questions, image attachments, model and effort switching, resuming a conversation after a restart |
| Claude | **Built.** Same features as Copilot. Checked against the real Claude Code program with a stand-in for Anthropic's API, not yet against a real account |
| OpenAI, Gemini | Not available yet: their cards say "Coming soon". Adapters are next |
| Sessions, settings, drafts, attachments | **Working.** Saved locally, and they survive a crash |
| Devices (SSH, Hyper-V, Android) | **Working against test fixtures**, not yet tried on a wide range of real hardware. Read-only by default, with approvals |
| Workflows, and the shared tool list (Tools & Integrations) | Not built yet. Devices attached to a chat are available |
| Installers and auto-update | Not yet |

The full plan, with the reasoning behind each decision, is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Getting started

You need [Node.js](https://nodejs.org) 22.13 or newer (the database is `node:sqlite`, built into Node and Electron).

```bash
git clone https://github.com/AmossDvir1/celeste.git
cd celeste
npm install
npm run dev
```

To use **GitHub Copilot**, open Settings, then AI vendors, and choose Connect. If you are already signed in to Copilot on
this computer it connects at once. Otherwise Celeste opens GitHub's sign-in page, or shows a code to enter at
github.com/login/device. The first time, Celeste downloads Copilot's runtime (about 180 MB) from npm and checks its
checksum. Disconnecting only makes Celeste stop using Copilot: it never signs you out of GitHub.

**Claude** connects through the Claude Console in your browser, or with an API key you paste. Celeste downloads Claude Code's
program (about 330 MB unpacked) from npm the first time, and starts doing so as soon as you open the key field.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl K | Search chats and sessions |
| Ctrl N | New chat |
| Ctrl 1 / 2 | Chat / Develop |
| Ctrl B | Show or hide the sidebar |
| Ctrl , | Settings |

## How it works

```
 Window (React)  ──message port──▶  Core process  ──▶  vendor adapters ──▶ Copilot SDK / CLIs
                                        │
                                        ├── SQLite: sessions are an event log, replayed on open
                                        ├── Devices: SSH, Hyper-V, adb, behind approvals
                                        └── Tool server (MCP, loopback only): lets agents use your devices
```

- Each session is an **event log**. Opening it replays the log through the same reducer that handles live events, so a
  restart or crash loses nothing. Each vendor's own resume id is stored too, so a conversation continues natively when the
  vendor still has it, and is rebuilt from Celeste's log when it does not.
- Vendors sit behind one small boundary (`AgentAdapter`, `AgentSession`, `AgentEvent`), so adding a vendor does not touch the interface.
- Secrets stay in Electron's main process. The Core process asks for a device password only when connecting.

```
src/
  shared/      the vendor boundary and the API between the window and Core
  main/        the Electron window, the Core launcher, secrets
  core/        the Core process: SQLite, sessions, vendor adapters, devices, the tool server
  preload/     the bridge the interface calls
  renderer/    the React interface: app shell, chat, develop, settings, stores
docs/          the implementation plan and images
scripts/       end-to-end checks that drive the built app, screenshot tools
```

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Start the app with hot reload |
| `npm run typecheck` | Type-check the interface, the main process and Core |
| `npm test` | Unit tests: storage, sessions, adapters, devices |
| `npm run build` | Production build into `out/` |
| `npm run verify:persistence` | Run the built app on one profile, restart and crash it, and check nothing is lost |
| `npm run verify:package` | Run the built app from an `app.asar`, as an installer lays it out |
| `npm run verify:devices` | Run the built app against an in-process SSH server that stands in for a VM |
| `npm run verify:claude` | Drive the real app with the real Claude Code program against a stand-in for Anthropic's API on this computer (no account, no cost) |
| `npm run verify:checkpoints` | Drive a Develop session in the real app: checkpoints before each message, revert, undo, and your project's own git left alone (no account, no cost) |
| `npm run verify:terminal` | Drive the real integrated terminal in the real app: a shell in the project folder, typing, the same shell after closing the panel (no account, no cost) |
| `npm run verify:files` | Drive a Chat that makes files in the real app: the cards, Open, Show in folder, Save a copy, and what is refused (no account, no cost) |
| `npm run verify:workflows` | Drive the Workflows tab in the real app: the empty start, building a workflow on the canvas, saving, versions, unsaved changes, deleting (no account, no cost) |
| `npm run verify:workflows-chat` | Start a workflow from a conversation with `/`: the menu, the card that asks first, the result, and the assistant being told (no account, no cost) |
| `npm run verify:workflows-ai` | Build with AI, Make this a workflow, and the assistant running a workflow only when allowed (no account, no cost) |
| `npm run verify:copilot` | Drive the real app with your real Copilot account (spends a few premium requests) |
| `npm run shots` | Screenshots of the key screens in both themes. They are the real app; Claude's answers come from a stand-in for the API, so the pictures cost nothing |

The Copilot live tests are opt-in (`CELESTE_LIVE_COPILOT=1`) because they use a real account. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Roadmap

1. Design, foundation (storage, sessions), devices, **Copilot** (done)
2. Claude adapter (built), then OpenAI and Gemini adapters
3. Modes and tools: Plan, tool catalog, MCP
4. Workflows
5. Public release: installers, signing, auto-update
6. A companion app for phones that controls your desktop Celeste

## License

Celeste's code is licensed under the [Apache License 2.0](LICENSE). The name "Celeste" and the logo are not covered by it.
The vendors' programs that Celeste downloads (Claude Code, the GitHub Copilot runtime) stay under their own terms and are not part of this
repository.

## Trademarks

Claude, GitHub Copilot, OpenAI and Gemini are trademarks of their owners. Celeste is an independent project and is not
affiliated with or endorsed by them. Their marks appear only to say which service a control talks to; the marks come from
the MIT-licensed [@lobehub/icons](https://github.com/lobehub/lobe-icons) set.
