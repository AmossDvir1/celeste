# Celeste: Implementation Plan

Draft for your review, 7 November 2026. Package versions and vendor behavior were checked on this date. Anything not yet confirmed is marked **Verify**.

## 1. Summary

Celeste is an open-source Electron desktop app built with React and Tailwind, to be published for personal users and teams at work. It gives one interface over Claude, GitHub Copilot, OpenAI and Google Gemini. Each vendor's own agent does the work underneath: editing files, running commands, browsing the web and calling tools. Celeste adds the interface, saved sessions, a shared tool list and workflows. It has no server of its own, so each user's usage goes to their own vendor account.

The work runs in nine phases. **Phase 1 is a clickable design with mock data and no real functionality, so you can approve it before anything else is built.**

| Topic | Decision |
|---|---|
| App | Electron, React, TypeScript, Tailwind |
| Vendor connection | The official route for each vendor, all of which run that vendor's CLI underneath (section 6) |
| Sign-in | One Connect button per vendor that opens the browser. Copilot, Claude and OpenAI complete sign-in there, while Gemini starts with a pasted API key under Google's rules (section 6.2) |
| Vendor runtimes | Downloaded when a vendor is first connected, because bundling them would add about 1 GB to the installer (section 6.4) |
| Saved sessions | Celeste keeps its own full record in SQLite and also stores each vendor's resume ID (section 7.6) |
| Chat vs Develop | Same agent and same abilities. They differ in where the agent works and how its activity is shown (section 3) |
| Glow line | Rebuilt from measurements of your picture, then checked against it by script (section 7.2) |
| Logo | Interim "C" without the star, kept in one file so your final logo is a simple swap (section 7.3) |
| Devices | VMs, other computers and Android phones, with a limited helper for iPhone, as extra context and as places the assistant can work. Every device needs approval, and read-only is the default. Built first, before the vendor adapters (section 7.11) |
| Mobile | Celeste can't run on iOS itself, so a companion app for iPhone, iPad and Android controls your desktop Celeste. It is built from the same React interface with Capacitor (section 7.12) |

## 2. Decisions for you

Each has a default that I'll use unless you say otherwise. The last column says when an answer is needed.

| # | Question | Default | Needed by |
|---|---|---|---|
| 1 | Which open-source license for Celeste's code? | Apache-2.0. It's permissive, includes the patent grant company legal teams look for, and matches Codex and Gemini CLI. The name and logo stay yours and aren't covered | Before the repository goes public |
| 2 | Which vendors come first? | Copilot, then Claude. Copilot has the fewest sign-in unknowns, is the default model in your picture, and is installed on your machine (1.0.95), as is Claude (2.1.259). Codex and Gemini are not. | Phase 4 |
| 3 | What should the light theme look like in the inner chat area? Your picture only shows dark. | I'll propose the same arc in softer tones on the light background, for you to judge in Phase 1 | Phase 1 review |
| 4 | Which platforms at launch? | Windows and Mac, with Linux soon after. Development stays Windows-first, with the code kept cross-platform | Phase 8 |
| 5 | Final logo | Interim logo until yours is ready | Any time |
| 6 | Should a device follow the global auto-approve setting? | **Confirmed by you on 7 November: devices need approval.** A new device starts **Read only**, commands on it ask first, and the global auto-approve default doesn't apply. A device can still be set to **Full** (no asking) behind a warning badge. That option is easy to remove if you'd rather not offer it | Settled |
| 7 | iPhone and iPad as devices? | Not as a remote shell, because Apple doesn't allow one. Two supported routes: a limited helper (open-source libimobiledevice tools: media files, logs and app install, after a USB pairing), and the Celeste Companion app (section 7.12), which shares folders and things you send, while it is open. A spike in Phase 3 decides whether the helper ships | Phase 3 |
| 8 | Which ways of connecting in v1? | SSH (Linux, Mac, Windows with OpenSSH Server), PowerShell Direct for Hyper-V VMs on this PC, and Android wireless debugging. WinRM, mounting remote drives, and Develop on a remote folder come later if wanted | Phase 3 |
| 9 | How should Celeste run on iPhone, iPad and Android? | A companion app that controls your desktop Celeste, not the full app, which can't run on a phone (section 7.12). Built with Capacitor from the same React interface, after the first public release. It needs an Apple Developer account (US$99 a year **Verify**) and a macOS builder | Before Phase 9 |
| 10 | Designs for the phone screens | Do you have designs, or want to make them? If not, I'll adapt the desktop design to a small screen and you review it | Phase 9 |
| 11 | Push notifications to the phone | None in v1. Apple and Google need a provider key that can't ship inside open-source code, so push needs a small relay run by the project. Without it the phone shows what needs you when you open the app | Phase 9 |

## 3. Chat vs Develop

Your comparison to the Claude desktop app is a good model, with one difference. There, Chat is a cloud conversation and Code runs locally against a folder you pick. In Celeste both modes run the same local agent, and you asked for all agent abilities in both. So the modes differ in **context and presentation, not capability**.

| | Chat | Develop |
|---|---|---|
| Purpose | Questions, analysis, writing, research, work across your tools | Working in a codebase |
| Where the agent works | A private scratch folder that Celeste creates for each session | A project folder you choose before the first message, optionally in its own git worktree |
| Agent abilities | All: files, web, commands, MCP tools | All: the same |
| Instructions to the agent | General assistant, plain language | The vendor's coding setup, plus project files such as `CLAUDE.md` or `AGENTS.md` |
| How activity looks | Collapsed into one-line summaries, with the answer and any output files in front | Tool calls visible, with inline diffs and commands |
| Side panels | Tools & Integrations, output files | Changes (diff), Files, Terminal, Tools & Integrations |
| Sidebar | Sessions by date | Sessions grouped by project |
| Composer extras | None | Project and branch indicator, "Plan only" approval option |
| Default effort | Vendor default | Higher |

The scratch folder is a default working location, not a security boundary. With auto-approve on, an agent can still reach other files your user account can access.

## 4. Tech stack

| Area | Choice | Current version | Why |
|---|---|---|---|
| Desktop | Electron | 45.x | Your requirement |
| Build | electron-vite with Vite | 6.x with 8.x | Fast reload across main, preload and renderer; peer range confirmed compatible |
| Packaging | electron-builder | 26.x | Mature Windows installer and auto-update |
| UI | React with TypeScript | 19.x | Your requirement |
| Styling | Tailwind with `@tailwindcss/vite` | 4.x | Your requirement. The light kit's `tailwind.config.js` is old-format and light-only, so I won't reuse it |
| Controls | Radix (`radix-ui`) | 1.x | Keyboard and accessibility behavior for dropdown, slider, hover card and dialog, with no visual style to fight |
| State | Zustand | 5.x | Small, and enough for this app |
| Workflow canvas | React Flow (`@xyflow/react`) | 12.x | Nodes, edges, pan and zoom are already solved |
| Database | `node:sqlite`, built into Electron's Node | SQLite 3.53 in Electron 45 | Local storage with FTS5 full-text search. Chosen over better-sqlite3 (13.x) in Phase 2: it needs no native rebuild per platform or Electron version, adds nothing for signing to cover, and its tests run in plain Node. It sits behind one small `Store` interface, so swapping it later is a one-file change |
| Remote machines | `ssh2` | 1.17 (MIT) | Pure-JavaScript SSH and SFTP client with a host-key check. It also has a server mode, so tests can run without a VM. Its native speed-ups are optional |
| Device discovery | `bonjour-service` | 1.4 (MIT) | Finds devices that announce themselves on the local network (mDNS) |
| Android | Google's `adb`, downloaded on demand, or `@yume-chan/adb` (MIT, 2.6) | | Settled by a spike at the start of Phase 3 (section 7.11) |
| Device tool server | `@modelcontextprotocol/sdk` | 1.32 (MIT) | The official TypeScript MCP SDK, for Celeste's own tool server (devices, then `ask_user`) |
| Phone app | Capacitor | 8.6 (MIT) | Wraps the React interface as an iPhone, iPad and Android app (section 7.12) |
| Markdown and code | react-markdown, remark-gfm, Shiki | | Message and code rendering |
| Icons | lucide-react | 1.x | The kits' icon sets lack several icons you need, such as paperclip and sliders. Lucide matches their line style |
| Fonts | Outfit, JetBrains Mono | | Outfit matches your inner chat picture. The dark kit's Liberation Sans does not |
| Tests | Vitest, Playwright for Electron | | Logic tests, plus screen and glow comparisons |

## 5. Architecture

```
+------------------------- Electron app ------------------------+
|                                                               |
|  Renderer (React UI)          no Node access, sandboxed       |
|       |  typed API: window.celeste                            |
|       v                                                       |
|  Main process                 windows, dialogs, credentials,  |
|       |                       auto-update                     |
|       |  MessagePort                                          |
|       v                                                       |
|  Core process                 SQLite, sessions, MCP list,     |
|  (Electron utilityProcess)    workflow runner, vendor adapters|
|       |                                                       |
+-------|-------------------------------------------------------+
        v  child processes, one per running agent
   Claude SDK     Copilot SDK     codex app-server    gemini --acp
```

- **Core process.** Database work and agent streams stay out of the window process, so a vendor crash can't freeze or take down the UI.
- **Credentials.** API keys and the OpenAI tokens Celeste holds are encrypted with Electron's `safeStorage` (Windows DPAPI). Main decrypts them and hands them to Core in memory, and they never reach the renderer.
- **Devices.** From Phase 3, connectors for remote machines and phones live in Core and reach the agents through a small MCP server that listens on this computer only (section 7.11).
- **Security.** `contextIsolation` and `sandbox` are on, and there is a strict content security policy. Attachment images load through a custom protocol limited to Celeste's attachments folder.

### The vendor boundary

This is the most important interface in the app. The UI knows only these types and never sees a vendor's own format.

```ts
interface AgentAdapter {
  readonly vendor: VendorId;
  detect(): Promise<VendorStatus>;              // installed, signed in, version
  signIn(method: SignInMethod): Promise<VendorStatus>;
  listModels(): Promise<ModelInfo[]>;           // effort levels and image support per model
  startSession(options: SessionOptions): Promise<AgentSession>;
  resumeSession(vendorSessionId: string, options: SessionOptions): Promise<AgentSession>;
  deleteSession(vendorSessionId: string): Promise<void>;
}

interface AgentSession {
  readonly vendorSessionId: string;
  readonly events: AsyncIterable<AgentEvent>;
  send(input: UserInput): void;                 // text and attachments
  respond(requestId: string, answer: ApprovalAnswer | AskUserAnswer): void;
  setModel(model: string, effort?: Effort): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

type AgentEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "thinking.delta"; text: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; id: string; kind: ToolKind; title: string; input: unknown }
  | { type: "tool.output"; id: string; text: string }
  | { type: "tool.completed"; id: string; ok: boolean; result?: unknown; diff?: FileDiff[] }
  | { type: "approval.requested"; requestId: string; kind: ToolKind; title: string; detail: unknown }
  | { type: "ask_user.requested"; requestId: string; questions: Question[] }
  | { type: "usage.updated"; usage: Usage }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.failed"; turnId: string; error: AgentError };

// ToolKind: read | edit | write | shell | web | search | mcp | agent | other
```

Phase 1's mock is a `MockAdapter` that plays scripted scenarios through these same events. **The screens you approve are the screens real vendors later plug into**, with no rewrite.

### Folder layout

```
celeste/
  design/                 your pictures and both kits, moved from the root and git-ignored
  scripts/                icon generation, glow comparison
  src/
    shared/               AgentEvent, AgentAdapter, workflow schema, API contract
    main/                 window, menus, credentials, updater
    preload/              window.celeste bridge
    core/                 from Phase 2: database, sessions, MCP, workflow runner
      adapters/           claude, copilot, codex, gemini, mock
      devices/            ssh, hyper-v and adb connectors, and the device MCP server (Phase 3)
    renderer/
      app/                shell and navigation
      features/           chat, develop, workflows, wizard, settings, tools
      components/         Button, Select, Slider, ShimmerText, ...
      glow/               GlowArc
      assets/logo/        the single logo source
      styles/             tokens.css
      mocks/              scenarios and sample sessions
```

## 6. Vendor integration

### 6.1 How each vendor connects

You asked for a CLI or SDK, whichever fits better. In every case the vendor's CLI runs underneath, and Celeste uses the route that vendor documents for this kind of app.

| | Claude | GitHub Copilot | OpenAI | Google Gemini |
|---|---|---|---|---|
| Celeste uses | `@anthropic-ai/claude-agent-sdk` | `@github/copilot-sdk` (generally available) | `codex app-server` over JSON-RPC | `gemini --acp` with `@agentclientprotocol/sdk` |
| Underneath | Claude Code binary | Copilot CLI | `codex` CLI | `gemini` CLI |
| Why this route | Documented way to embed the agent, with approval callbacks and sessions | Official and stable. Its ACP mode is still in preview and can't set tools or effort per session | OpenAI points custom clients needing approvals and streamed events here | Interactive approvals over ACP. Headless JSON output documents no approval flow |

**Why not one shared protocol?** The Agent Client Protocol (ACP) is an open standard for connecting editors to agents, and it looked like a shortcut. Claude and Codex only support it through adapters, and Copilot's support is in preview, so it would limit the vendors with the strongest native options. Celeste uses ACP for Gemini only, and the adapter boundary keeps that choice reversible.

Each runtime downloads when its vendor is first connected, rather than shipping in the installer (section 6.4).

### 6.2 Sign-in for a public app

Celeste will be published for personal users and teams at work, so each vendor's rules for public apps apply. Celeste has no server of its own. Usage goes straight from the user's machine to their own vendor account, so Celeste never pays for or resells anyone's usage.

**Every vendor gets one Connect button.** It always opens the normal browser on the vendor's own page, never a window embedded in Celeste. What happens next depends on the vendor:

| Vendor | Connect button at launch | Token kept by | Billed to |
|---|---|---|---|
| Copilot | Runs `copilot login`: browser sign-in with a local callback | Copilot CLI, in the system credential store | The user's Copilot plan, including the free tier |
| Claude | Runs `claude auth login --console`: browser sign-in with a local callback | Claude CLI | The user's Claude Console account |
| OpenAI | "Continue with ChatGPT": Celeste runs the browser sign-in and receives the callback on `127.0.0.1`. A pasted API key is the alternative | Celeste, encrypted | The user's ChatGPT plan, or their API account with a key |
| Gemini | Opens Google AI Studio's key page, and the user pastes a key | Celeste, encrypted | The user's Gemini API account |

Two more sign-ins can be added later, each depending on a vendor's answer:

| Sign-in | Condition |
|---|---|
| Google sign-in through the official Gemini CLI | Once Google confirms it |
| Claude Pro, Max, Team or Enterprise plans | Only with Anthropic's approval |

**What each audience needs at launch:**

| Vendor | Personal user | Team at work |
|---|---|---|
| Copilot | Free or paid Copilot plan | Copilot Business or Enterprise seat |
| Claude | Claude Console account. A Pro or Max subscription alone isn't enough | Console organization, or Amazon Bedrock, Google Cloud or Microsoft Foundry credentials |
| OpenAI | ChatGPT plan or API key | ChatGPT workspace where its policy allows (**Verify**), or organization API key |
| Gemini | API key | API key or Vertex AI |

Copilot's card comes first in the wizard because its free tier needs no paid plan or API key.

**How the card behaves:**

1. Click Connect. If the vendor's runtime isn't on the machine yet, the card downloads it first, with progress (section 6.4).
2. The card shows "Waiting for you in your browser" with a Cancel button, or a key field for API key vendors.
3. When that finishes, Celeste asks the vendor for the sign-in status.
4. The card shows Connected with the account name, or a plain error: cancelled, timed out, blocked by your organization, or download failed.

**Rules where Celeste holds credentials:** keys and tokens are encrypted through `safeStorage` and never reach the renderer. "Continue with ChatGPT" uses PKCE with a fresh `state` and `nonce` on each attempt, a listener bound to `127.0.0.1` only, and no custom URL scheme. The access token goes only to the Codex child process.

**Vendor details:**

- **Copilot: the simplest vendor for a public app.**
  - GitHub documents this use. Each user needs their own Copilot plan and is billed through it, and the CLI's license explicitly allows shipping it with another app (section 6.4).
  - `copilot login` needs no registered app, no client secret and no server. The SDK's `useLoggedInUser` picks up the result, and users who are already signed in skip the step. The consent screen names the Copilot CLI rather than Celeste.
  - For teams, GitHub enforces enterprise policies such as SAML SSO and IP restrictions itself, and `copilot login --host` supports GitHub Enterprise Cloud with data residency. **Verify** whether organization admins can block Copilot CLI and what error that produces, so the card can explain it.
  - A later option is Celeste's own GitHub App, so the consent screen names Celeste. GitHub's browser flow requires a client secret, which can't be kept safe in a public desktop app, so this would use the device flow, where the user enters a short code in the browser. Celeste would then store and refresh tokens itself. **Verify** that such tokens work, because the SDK's OAuth guide and the CLI's help describe supported tokens differently.
  - I found no GitHub terms beyond these that address third-party apps directly, so read the current Copilot product terms before launch.
- **Claude: Console login and API keys only.**
  - A callback with a token isn't possible here. Anthropic doesn't let third-party developers offer claude.ai login in their apps, route requests through personal plan credentials on users' behalf, or collect or store those tokens. I also found no way to register an OAuth client.
  - Console login is Anthropic's own browser flow, billed as API usage, which matches the docs' guidance for SDK developers. The docs don't name this exact use, so confirm it (see below).
  - The legal page says a user may sign in to the unmodified Claude Code binary with their own subscription, while the SDK overview says products built on the SDK can't offer that login without approval. Shipped builds leave it out unless Anthropic approves it. During development you can test with your own terminal login, but no release includes that path.
  - **Side effect to test first:** Console sign-in without an API key signs out any claude.ai login on the machine, which would disturb a user's terminal `claude`. **Verify** whether a Celeste-owned `CLAUDE_CONFIG_DIR` prevents this, and how it affects user-level skills and the session paths in section 7.6. If it can't be isolated, a pasted API key becomes Claude's main option.
- **OpenAI: a true callback with a token, through OpenAI's open-source route.**
  - OpenAI's guide covers open-source, locally hosted apps. Each user's copy registers itself on first sign-in, so the repository holds no client secret or partner key. Each registered client is tied to one user and one workspace, and the host ID Celeste generates must not contain identifying data.
  - Celeste validates the ID token, checks that the plan usage permission was granted, and passes the access token to `codex app-server` as `ACCESS_TOKEN`, using the provider settings in OpenAI's guide. No separate Codex sign-in is needed.
  - To refresh an expired token, Celeste gets a new one, restarts the app server and calls `thread/resume`. Where possible, it does this between turns, ahead of expiry.
  - This is a preview with limits. `model/list` may return a bundled list rather than what the user's plan allows, so only a completed turn proves access, and a rejected model needs a clear message. Configurations that use `tool_search` fail, so Celeste must avoid them. Local shell, MCP and child agents work.
  - OpenAI's guidelines also shape the interface: "Continue with ChatGPT" in an approved format, a one-time welcome message on first sign-in, and "Using ChatGPT plan" near the composer or model selector with a "Manage usage" link.
  - This route doesn't cover paid or remotely hosted apps, which use a separate interest form. Adding a paid or hosted version later would change this.
  - Celeste won't use the app server's own `account/login/start` for ChatGPT sign-in. OpenAI says that route was never permitted for commercial or hosted services and steers apps to Sign in with ChatGPT.
  - For teams, `clientInfo.name` must be accurate, and OpenAI asks enterprise integrations to contact them about its known-clients list.
- **Gemini: API key at launch, Google sign-in once confirmed.**
  - Google's terms target third-party software reaching Gemini's backend directly, such as reusing the CLI's OAuth login in another tool. Letting the official CLI sign itself in is different, and Zed works this way without seeing tokens. But Google doesn't explicitly approve it, and a wrong call could get your users' accounts suspended, so it waits for confirmation.
  - **Verify** whether ACP's `authenticate` can trigger the browser sign-in, or whether Celeste must open the CLI in a terminal as Zed does.
  - Vertex AI sits under an Advanced option. A Google OAuth client of your own is possible for the Gemini API, but it requires Google's scope verification and the docs don't connect it to the CLI, so it isn't planned.

**Confirmations to get before launch.** These need to come from you, as the publisher:

1. **Anthropic** (its legal page points to sales for these questions): Celeste runs the unmodified Claude Code binary through the Agent SDK, sign-in completes in Anthropic's own flow, and Celeste never sees a token. May it offer Console login? And separately, may it offer Claude subscription login?
2. **OpenAI:** The docs don't define "open-source client". Does a free, Apache-2.0 desktop app in a public repository qualify for ChatGPT plan usage, with no hosted or paid version?
3. **Google:** May a public desktop app start the official Gemini CLI's Google sign-in over ACP, without ever touching the token?

**Branding:**

- Anthropic asks for "Claude Agent" in dropdowns. "Claude Code" can't be part of your product or feature names, though plain text may say Celeste runs it.
- GitHub's license allows its trademarks and logos only to identify the software.
- OpenAI's sign-in button and plan usage labels follow its own guidelines.

This is my reading of the public docs, not legal advice. Have the sign-in rules and licenses reviewed before launch.

### 6.3 Feature mapping

This is the starting map. Each adapter begins with a short test against the real CLI to confirm its column, especially the **Verify** cells.

| Celeste feature | Claude | Copilot | OpenAI | Gemini |
|---|---|---|---|---|
| Auto-approve (default) | `permissionMode: "auto"` where the model supports it, otherwise `bypassPermissions` | `onPermissionRequest` approves all | `approvalPolicy: never` | `setSessionMode` to auto-approve |
| Auto-approve edits only | `acceptEdits` | Handler approves edits, asks for the rest | Handler accepts `fileChange` requests, asks for commands | `auto_edit` **Verify** |
| Ask first | `default` with `canUseTool` | Handler asks | `item/*/requestApproval` | `session/request_permission` |
| Plan only (Develop) | `plan` | `permissionMode` **Verify** | Read-only sandbox | **Verify** |
| `ask_user` | `AskUserQuestion` through `canUseTool` | `onUserInputRequest` | `tool/requestUserInput` (experimental) | Not found over ACP, so Celeste's own MCP tool **Verify** |
| Thinking effort | `effort`: low to max | `reasoningEffort`: low to max | `effort`, per model from `model/list` | No ACP option found, so the slider is disabled **Verify** |
| Model list | `supportedModels()` | `listModels` | `model/list` | `unstable_setSessionModel` to switch; list **Verify** |
| Images | Image blocks in the message **Verify** | `attachments` with a file path | `localImage` input | Check `promptCapabilities` **Verify** |
| Resume | `resume` | `resumeSession` | `thread/resume` | `loadSession` |
| Delete | `deleteSession` | `deleteSession` | `thread/delete` | None documented, so Celeste forgets the ID |
| MCP tools | `mcpServers` | `mcpServers` | Config plus `config/mcpServer/reload` | Passed at ACP session setup |
| Extra folders (device snapshots, section 7.11) | `additionalDirectories` | `--add-dir`, per session, so Celeste adds it again on resume | `--add-dir`, which grants write access and only in workspace-write sessions **Verify** | `--include-directories` **Verify** the limit on how many |

Two details the docs confirm for Claude:

- `AskUserQuestion` still reaches Celeste under auto-approve, so questions keep working.
- It allows 1 to 4 questions with 2 to 4 options each, and isn't available inside subagents.

**Missing features are shown, not hidden.** If a model has no effort setting, the slider is disabled with a tooltip. If a model can't take images, the composer says so when you attach one.

### 6.4 Vendor runtimes and licenses

Bundling every vendor's CLI would add about 1 GB to the installer. Windows x64 unpacked sizes:

| Runtime | Size | Package |
|---|---|---|
| Codex | 478 MB | `@openai/codex` Windows build |
| Claude | 328 MB | `@anthropic-ai/claude-agent-sdk-win32-x64` |
| Copilot | 172 MB | `@github/copilot-sdk-win32-x64` |
| Gemini | 94 MB | `@google/gemini-cli` |

**So runtimes download on demand.** The installer stays small, and Connect downloads only that vendor's runtime:

- Versions are pinned to what Celeste was tested with and checked against the package's integrity hash. They're stored in `runtimes/<vendor>/<version>/` under Celeste's app data.
- Users don't need to install Node or any CLI themselves. Gemini runs on Electron's built-in Node through `ELECTRON_RUN_AS_NODE`. **Verify** the Node version requirement.
- The adapters point at the downloaded runtime through `pathToClaudeCodeExecutable` for Claude, `COPILOT_CLI_PATH` for Copilot, and a spawned process for Codex and Gemini.
- For locked-down company networks, an Advanced setting uses a CLI that's already installed.

**License conditions.** These apply however the runtime reaches the user:

| Component | License | Conditions for Celeste |
|---|---|---|
| Claude Agent SDK and binary | Anthropic Commercial Terms | Binary unmodified, built-in sign-in methods left in place, each user authenticates with their own credentials, and no paying for or reselling usage |
| Copilot CLI | GitHub Copilot CLI license | Unmodified, part of an app with substantial functionality beyond the CLI, not your main product, license and notices included, and your app has its own license. Celeste's own license can be open source |
| Copilot SDK | MIT | Include the notice |
| Codex, Gemini CLI, ACP SDK | Apache-2.0 | Include the license and notices |

Celeste's About screen lists all third-party notices.

**Open source alongside proprietary runtimes.** Celeste's code can be open while the Claude and Copilot runtimes stay proprietary. Those runtimes aren't in the repository or the installer, and their vendors' terms still apply to them.

## 7. Feature specifications

### 7.1 Which picture defines what

| Area | Source | Notes |
|---|---|---|
| Top bar: logo, name, tagline, Chat/Develop/Workflows tabs, search, avatar, window controls | `Design.jpeg` | Native Windows controls through `titleBarOverlay`. **The gear moves out**, see below |
| Left sidebar: new session, panel toggle, search, Today/Yesterday, Show more | `Design.jpeg` | On the Workflows tab it shows both chats and workflows, as pictured |
| **Settings button** | Your request | Bottom-left, under the sessions. Replaces the top-right gear |
| **Chat center area** | `Inner chat design.jpeg` | Replaces the hero banner, quote, three cards and "Try these examples" from `Design.jpeg` |
| Develop center area | `Inner chat design.jpeg` layout | No picture exists, so I'll adapt it and add a project picker |
| Tools & Integrations panel | `Design.jpeg` | Opens from the composer's sliders menu |
| Workflows screen, canvas, node details | `Design.jpeg` | Followed closely |
| Colors | Your palette, then both kits | Brand colors `#1F306E #553772 #8F3B76 #C7417B #F5487F` |

Not carried over: the microphone (it's in `Design.jpeg` but not your inner design), `celeste-orbit.svg` (a soft blob, not your arc) and the kits' logos (they have the star).

### 7.2 The glow line

I measured the arc directly from `Inner chat design.jpeg`. It is a true circle, with 0.83px average error across 201 of 230 sampled points.

**Geometry at the picture's size of 1261 x 668:**

- Center (1229.8, 540.9), radius 475.5. Its top touches y = 65.
- Anchored to the panel's top-right corner, and scaled by `panelHeight / 668`. It is exact at the reference size and proportional at others.

**Color along the arc.** Angles are in screen coordinates, where 270° is straight up.

| Angle | Position | Core color | Character |
|---|---|---|---|
| 210° | (819, 304) | `#141B3F` | Fading into navy |
| 225° | (894, 205) | `#442865` | Violet |
| 240° | (993, 130) | `#7E3775` | Plum |
| 250° | (1067, 93) | `#944183` | Magenta |
| 260° | (1147, 73) | `#8D4F9C` | Brightest, pink-violet |
| 270° | (1230, 68) | `#673A90` | Violet |

**Layers, back to front:**

1. Background `#080C17`, slightly lifted toward the center (`#0E1122`).
2. Wide haze **outside** the circle. It is clearly stronger than the inner side: 30px either side at 240° reads `#492158` outside and `#2C1A46` inside.
3. Darker planet interior, falling off quickly from the edge.
4. Soft bloom around the line.
5. Thin bright core, about 2px, using the colors above.
6. Tiny stars at the measured points, including (1092, 131), (1123, 168) and (1045, 207).
7. Very fine grain so the gradients don't show banding.

**Build and acceptance.** `GlowArc` is a React component using inline SVG and CSS gradients. If live blur slows window resizing, I'll pre-render it to an image at build time. A script samples the rendered app at the angles above and compares them to your picture. The target is arc position within 2px and colors that are visually indistinguishable, plus a side-by-side for you to judge.

During a conversation the glow stays behind the messages at reduced strength, so text stays readable. The workflow canvas's planet glow at bottom-left in `Design.jpeg` reuses the same component, measured separately.

### 7.3 Logo

- The interim logo is a hand-traced SVG of the star-less "C" from `Logo examples.png`, with its two shapes: the outer crescent and the inner fold.
- It lives in one file, `src/renderer/assets/logo/celeste-mark.svg`, and everything uses a `<Logo>` component.
- `npm run icons` generates the `.ico` and PNG set from that file. When your final logo is ready, replace the file and run the script.

### 7.4 Themes

There is one `tokens.css`, with CSS variables switched by `data-theme` and exposed to Tailwind through `@theme`. Components use names such as `bg-surface` and never raw colors. The options are Dark, Light and System.

Starting values are below, to be tuned at review:

| Token | Dark | Light |
|---|---|---|
| Background | `#080C17` (measured; the kit's `#07111F` is too blue) | `#F7F8FC` |
| Panel | `#0D1929` | `#FFFFFF` |
| Composer | `#111A29` (measured) | `#FFFFFF` |
| Border | `#233654` | `#DDE2F0` |
| Text | `#F7F8FC` | `#111B4C` |
| Muted text | `#AEB8D1` | `#526080` |
| Accent | `#F5487F` | `#F5487F` |

### 7.5 Chat experience

**Composer**, left to right, following your inner design:

| Control | Behavior |
|---|---|
| Paperclip | Attach files |
| Sliders | Popover with the **thinking effort slider** and a link to Tools & Integrations |
| Model dropdown | Grouped by vendor, showing connected vendors only. "Copilot Auto" from your picture maps to Copilot's `auto` model. Effort stops come from the selected model |
| **Approval dropdown** | One small addition to your design. **Auto-approve** is the default; also Auto-approve edits, Ask first, and Plan only in Develop. It can change mid-session |
| Send | Becomes Stop while the agent is working |

When a session runs on a ChatGPT plan, the composer also shows "Using ChatGPT plan" with a "Manage usage" link, as OpenAI's guidelines ask.

**Shimmer labels.** A `ShimmerText` component shows a light sweep moving across the text, driven by real events: "Thinking", "Reading auth.ts", "Editing 3 files", "Running npm test", "Searching the web". "Waiting for your answer" doesn't shimmer, because nothing is working. It respects the system's reduced-motion setting.

**`ask_user` card.** Appears in the conversation and takes keyboard focus:

- Question text and option rows with descriptions.
- Single or multiple choice, and an "Other" field for free text.
- Number keys and Enter to answer. Multiple questions step through one at a time.
- Once answered, it collapses to a one-line summary.
- The session shows a "needs you" marker in the sidebar.

**File drop and image preview:**

- Three ways in: drag anywhere onto the chat panel (a full-panel overlay appears), paste from the clipboard, or use the paperclip.
- Attachment chips show a thumbnail for images, or an icon, name and size for other files, with a remove button.
- **Hovering or keyboard-focusing an image chip shows a larger preview** with file name and dimensions. This works in the composer and in sent messages.
- On send, files are copied to `attachments/<sessionId>/` under Celeste's app data, so reopened sessions still show them after the originals move.

**Agent abilities.** Editing, creating files, web access and MCP tools come from the vendor's agent. Celeste doesn't reimplement them. It groups each vendor's tool calls by `ToolKind` and renders them with a consistent icon, label, output and diff.

### 7.6 Sessions and persistence

Three layers provide "pick up exactly where I left off":

1. **Celeste's event log** is the source of truth for what you see. Every `AgentEvent` is written to SQLite before it reaches the screen. Reopening rebuilds the conversation with no vendor call.
2. **The vendor's resume ID** is what restores what the agent remembers. The next message resumes natively.
3. **A fallback** covers a vendor session that's gone. Celeste starts a new one seeded with a summary of the log, and shows a small notice so the difference isn't hidden.

```
sessions      id, mode, title, vendor, model, effort, approval_mode, cwd, worktree_path,
              branch, vendor_session_id, status, pinned, draft, usage_json,
              created_at, updated_at, last_opened_at
events        session_id, seq, turn_id, type, payload_json, created_at
attachments   id, session_id, event_seq, name, mime, bytes, sha256, path, width, height
workflows     id, name, description, version, definition_json, created_at, updated_at
workflow_runs id, workflow_id, status, inputs_json, started_at, finished_at
run_events    run_id, seq, node_id, type, payload_json, created_at
mcp_servers   id, name, transport, config_json, enabled
settings      key, value_json
```

Plus a full-text index on message text for search.

**Edge cases:**

| Case | Behavior |
|---|---|
| App quits mid-turn | A confirmation first. On restart, the turn is marked interrupted with a Continue button |
| Unanswered `ask_user` at restart | The card is still there. Answering resumes the session and sends your answer |
| Unsent draft | Saved with the session, including attachments |
| Delete | Disappears immediately with an Undo toast. After that, Celeste removes the rows, the attachments and the vendor's copy |
| Changing vendor mid-session | Not allowed in v1. A session stays with its vendor, though models within that vendor can change |

**A Claude-specific choice.** Claude transcripts on disk are swept automatically by the `cleanupPeriodDays` setting, so Celeste keeps its own copy of each `.jsonl` and restores it before resuming, which the docs support. I'm deliberately not using the SDK's `SessionStore`. A run resumed from it uses a temporary config folder with plugin settings stripped, so a resumed session could behave differently from the original.

### 7.7 Setup wizard

Five short steps, one idea each, over the glow background, with a progress indicator. Everything can be changed later in Settings.

| Step | Content |
|---|---|
| 1. Welcome | "What should we call you?", prefilled from your OS username. Used for the greeting and avatar initials |
| 2. Appearance | Dark, Light or System, with the app changing live |
| 3. Connect | Four vendor cards, Copilot first, with live status: Ready to connect, Downloading, Waiting for you in your browser, or Connected. Each has one Connect button (section 6.2), and the Copilot, Claude and OpenAI cards also have a quiet link for an API key or your own provider key. One vendor is enough, and you can skip |
| 4. Defaults | Default model, auto-approve on with a one-line explanation of what it means, and an optional default projects folder |
| 5. Ready | Short summary and three starter suggestions |

Left out on purpose to keep it light: MCP tools, shortcuts and advanced agent options.

### 7.8 Settings

Opened from the bottom-left button. Sections: General, Appearance, AI Vendors, Agent Defaults, Tools & Integrations, Devices (from Phase 3), Data (storage location, export, delete all), About.

### 7.9 Tools & Integrations

Celeste stores one list of MCP servers and passes it to whichever vendor runs the session. MCP (Model Context Protocol) is the standard way agents connect to outside tools. Your internal tools are added once rather than per vendor. The panel matches `Design.jpeg`, with search and connection status. Phase 1 shows the pictured list as mock data.

Celeste also runs a small MCP server of its own, for `ask_user` on vendors with no native version, and for the device tools in section 7.11. **Verify** long-wait behavior, because some MCP clients time out on tool calls that wait for a person.

### 7.10 Workflows

A workflow is saved as JSON and validated against a shared schema.

| Step type | What it does | Picture |
|---|---|---|
| Start | Defines inputs, such as `older_than_days` | Blue pill |
| **Tool step** | Calls an MCP tool or a built-in (shell command, HTTP request, file) directly, with no model involved. The input form comes from the tool's schema. A shell command can run on a device from section 7.11 | Pink: Find old KBs, Install updates, Wait for service |
| **Agent step** | Runs a prompt with a chosen model, effort, tools and approval mode, with optional structured output | Blue-violet: Summarize |
| End | Sets the final output | Pink pill |

**Runner:**

- Lives in Core and uses the same vendor adapters as chat.
- Runs steps in order in v1, with parallel branches later.
- Later steps use earlier results, such as `{{nodes.find_kbs.output}}`.
- The Advanced settings panel holds timeout and model. The Error handling panel holds Stop, Retry or Continue.
- `ask_user` pauses the run until answered. Nodes light up live, and every run is saved.

**Toolbar buttons from your picture:**

- **Build with AI:** describe the workflow, the agent returns JSON, and it's validated and opens as a draft for you to review.
- **Save:** creates a new version.
- **Share:** exports a `.celeste-workflow.json` file without secrets.
- **Run:** asks for inputs, then starts.
- **Templates:** the five pictured ones ship as starter definitions.

Scheduling isn't in v1.

### 7.11 Devices: remote machines and phones

**What you asked for.** Connect to a VM by its IP address, or to devices on your Wi-Fi such as your phone. Detect them. Run operations on them, with PowerShell for Windows. Add a folder that lives on a device as context. Research on 7 November 2026 says this is possible, with one exception: the iPhone.

**What works**

| Device | Works? | How it connects | What the assistant can do |
|---|---|---|---|
| Linux or Mac VM, Raspberry Pi, NAS, another computer | Yes | SSH, with a key or a password | Run commands, read, write and list files |
| Windows VM or PC | Yes, once its OpenSSH Server is on (Windows 10 build 1809 or Server 2019 and later) | SSH. Commands run as PowerShell, sent encoded so quoting never breaks. This should work with Windows PowerShell 5.1 and PowerShell 7 **Verify** | PowerShell commands and files |
| Hyper-V VM on this PC | Yes, with no network and no IP address | PowerShell Direct, which needs a Hyper-V administrator and the VM's login. Windows 10 or Server 2016 and later guests | PowerShell commands and file copy |
| Windows machine that only offers WinRM | Later, if wanted | WinRM. Outside a domain it needs HTTPS or a TrustedHosts entry, which is a security setting on your computer **Verify** | |
| Android phone, tablet or TV | Yes, on Android 11 and later (TV and Wear OS: 13) | Wireless debugging over Wi-Fi, paired by QR code or six-digit code, then ADB | What Android's `shell` user can do, which is not root: files in shared storage, logs, screenshots, installing an app, device information |
| iPhone and iPad | Not as a shell. Two supported routes instead | **A limited helper:** the open-source libimobiledevice tools run on Windows, Mac and Linux, and work over Wi-Fi once the phone is paired by USB (iOS 11 and later). They reach files in the media area, logs, crash reports and app install, not a shell, and on Windows they need Apple's iTunes drivers. For iOS 17 and later `pymobiledevice3` adds Developer Mode and tunnel steps **Verify**. **The Celeste Companion app** on the phone (section 7.12) | The helper: device information, logs and media files. The Companion: folders you pick, photos you choose, and anything you send from the share sheet, while the app is open |

**On every desktop.** Celeste runs on Windows, Mac and Linux, so each piece has to as well:

| Piece | Windows | Mac | Linux |
|---|---|---|---|
| SSH connector (`ssh2`, pure JavaScript) | Yes | Yes | Yes |
| Finding devices (mDNS, `bonjour-service`) | Yes. The firewall asks once | Yes. macOS asks for Local Network permission **Verify** | Yes |
| Android `adb` | Google's Windows build | Mac build | Linux build |
| Local VMs listed | Hyper-V (`Get-VM`), WSL (`wsl -l -v`), VirtualBox (`VBoxManage list vms`), VMware (`vmrun list`) | Parallels (`prlctl list -a -j`), UTM (`utmctl list`), VMware Fusion (`vmrun list`), VirtualBox, Multipass (`multipass list --format json`) | libvirt (`virsh list --all`), VirtualBox, Multipass |
| PowerShell Direct | Yes. Hyper-V is Windows only | No | No |
| iPhone helper (libimobiledevice) | With Apple's iTunes drivers | Yes | Yes |

Listing a VM only finds it. Connecting is by SSH to its address, which Celeste fills in when the tool reports one. Only `prlctl`, `VBoxManage` and `utmctl` are confirmed from documentation. The commands for `multipass`, `vmrun` and `virsh` are marked **Verify**.

**One shell per device.** Each device reports its operating system, shell and path style, and `devices_list` passes that to the model. Linux and Mac use a POSIX shell, Windows uses PowerShell, Android uses `adb shell`, and the iPhone Companion has no shell, only file and share actions. The tool descriptions say so, so the model writes the right syntax for each device.

**Why not let the agent run `ssh` itself?** It already can, through its normal shell tool, if your computer has the keys. A built-in feature adds what that lacks: credentials the model never sees, a permission level for each device, an approval card with the exact command, a limit to the devices you attached to this session, a record of every call, folder context, and phones.

**How the assistant reaches a device**

- **Connectors in Core.** One small contract (`probe`, `connect`, `run`, `readFile`, `writeFile`, `list`, `disconnect`) with three implementations: SSH (with `ssh2`, SFTP included), Hyper-V (a PowerShell process on this PC), and Android (ADB).
- **One MCP server for every vendor.** Celeste's own MCP server listens on `127.0.0.1` only, on a random port, and each session gets its own secret token. All four vendors accept MCP servers (section 6.3), so one implementation covers them, and the permission rules live in Celeste instead of in four different permission systems. It is built in Phase 3 with the official MCP SDK, before any vendor adapter exists, and tested with a real MCP client and with the scripted assistant. Each adapter connects to it in Phases 4 and 5.
- **Tools it offers:** `devices_list`, `device_run`, `device_read_file`, `device_list_dir`, `device_write_file`, `device_pull`, `device_push`, and on Android `device_screenshot`. A session sees only the devices you attached to it.
- **The approval gate is Celeste's own.** The vendor's approval mode treats MCP tools in its own way, so `device_run` and `device_write_file` ask through Celeste's approval card whatever the vendor's mode is. **Verify**, adapter by adapter in Phases 4 and 5, that each vendor keeps a tool call open while the card waits, which is the same long-wait question as `ask_user`.
- **Android's `adb` is downloaded on demand**, the same way as vendor runtimes (section 6.4), not bundled. **Verify** Google's redistribution terms for platform-tools. A spike settles whether to drive Google's `adb` or the TypeScript client `@yume-chan/adb`, which depends on whether the latter supports Wi-Fi pairing.

**Folders from a device as context.** Every vendor's extra-folder option takes a local path (section 6.3), so a folder on another machine needs one of these:

| Way | What happens | Needs | Phase 3? |
|---|---|---|---|
| **Browse live** | The assistant lists and reads the folder through the device tools, when it needs to | Nothing | Yes |
| **Snapshot** | Celeste copies the folder into a read-only local cache, and the vendor gets it as an ordinary extra folder, so its own file and search tools work at full speed. The chat says which device it came from and when | Nothing | Yes |
| **Mount** | The remote folder appears as a drive (a network share on Windows, or SSHFS) | Software you install yourself. SSHFS on Windows needs WinFsp and SSHFS-Win, which are GPL-licensed, so Celeste never bundles them | No |

Snapshot rules: skip `.git`, `node_modules` and build folders; skip files over 25 MB; ask before copying more than 200 MB or 10,000 files; a Refresh button shows the snapshot's age; the cache is deleted with the session or the device. A snapshot is a copy, so changing the real files goes through `device_write_file`, which asks. Develop working directly in a remote folder is later work.

**Safety.** The assistant is acting on machines that may be shared or in production, and a command there can't be reverted the way a local edit can.

- **Three access levels per device, and a new device starts at the first.**
  - **Read only:** only the file tools (`read`, `list`, `pull`). The command tool isn't offered at all, because a shell can't be made read-only.
  - **Ask first:** commands and writes are allowed, and each one shows an approval card with the exact command or file.
  - **Full:** commands and writes run without asking. Every chip, card and the composer show a warning badge while a device is at Full.
- **The global auto-approve default does not apply to devices** (decision 6).
- **Attach per session.** A device is invisible to a session until you attach it, so text on a web page or in a file can't send the assistant to another machine.
- **SSH host keys:** trusted on first use. Celeste shows the SHA-256 fingerprint to confirm, pins it, and refuses a changed key with a plain explanation until you re-trust it.
- **Credentials:** passwords and key passphrases are encrypted with the system store (section 5) and never reach the window or the model. A private key is used from the path you choose and is never copied. A device can also be set to ask for the password each time.
- **Limits:** output is cut at 64 KB per call (the start and the end are kept), commands time out after 60 seconds (10 minutes at most), one command runs per device at a time, and Stop closes the channel.
- **Untrusted content:** file contents and command output from a device can contain instructions meant for the model. The approval card and the per-session attach are the backstops, and a device at Full is the risky case.
- **Your data goes to your AI vendor.** What the assistant reads on a device is sent to your vendor like any local file. The Add dialog and the attach step say so, because on a work machine or a phone that may matter.
- **Celeste never changes a remote machine or your own system settings.** It doesn't turn on sshd, edit TrustedHosts or touch a firewall. It shows the exact steps for you to run.
- **Record:** every device call is in the session log and in a per-device activity list.
- **Phones:** wireless debugging is a developer setting you switch on, and you can revoke Celeste's pairing from the phone ("Forget").

**Finding and adding a device.**

| Source | How it is found | Notes |
|---|---|---|
| Android phone | Celeste browses the local network for the services Android announces: `_adb-tls-pairing._tcp` while the pairing screen is open and `_adb-tls-connect._tcp` while wireless debugging is on. It shows its own QR code, so scanning it on the phone pairs it | If nothing is announced, enter the address and six-digit code the phone shows |
| Mac, Linux, Raspberry Pi, NAS | Services that announce `_ssh._tcp` or `_sftp-ssh._tcp` | Windows machines don't normally announce SSH **Verify**, so add them by address |
| Local VMs on this computer | The VM list from each product's command line (table above). Hyper-V on Windows also connects with PowerShell Direct, which needs no address | Hyper-V needs administrator rights, and Celeste says so if it lacks them |
| Anything else | Type a name or IP address and a port | Always available |
| Subnet scan for SSH | Off by default, and you start it yourself | Company networks may flag a port scan, so Celeste says that first |

Announcements are blocked by VPNs, guest Wi-Fi and router client isolation. That is why typing an address always works.

**Screens**

- **Settings, Devices:** one card per device with online status, kind, address, access level (changeable), last seen, and Test, Edit and Remove.
- **Add device** (a dialog, not part of the setup wizard): choose Find on my network, Enter an address, Android phone, or VM on this computer, then credentials, confirm the fingerprint, run a test (it shows the operating system and user), then a name and an access level.
- **In a session:** the Tools & Integrations panel gets a **Devices** section with an attach switch for each device. Attached devices show as chips in the session header, and tool cards show which device ran them.
- **Add a folder from a device:** a remote folder picker, then a choice of Browse live or Snapshot. The folder shows under its device in the panel.

**Data (a migration in Phase 3):**

```
devices          id, name, kind, host, port, username, auth_method, secret_ref, host_key_sha256,
                 os, access_level, created_at, last_seen_at
session_devices  session_id, device_id
device_folders   id, device_id, path, mode (live | snapshot), snapshot_path, snapshot_at, bytes
device_activity  id, device_id, session_id, tool, summary, ok, bytes, at
```

Workflows (section 7.10) can run a Tool step's shell command on a device.

### 7.12 Mobile companion: iPhone, iPad and Android

**The straight answer.** Celeste itself can't run on iOS. It is built on Electron, which targets Windows, Mac and Linux only, and the agents underneath are desktop programs (the Claude, Copilot, Codex and Gemini CLIs) that an iPhone can't run. Android is the same. What can run on a phone is a **companion app** that controls the Celeste on your computer, which does the work. It puts the Celeste screens on your phone: see your sessions, send a message, answer a question, and approve or deny a command while you're away from your desk.

**What the companion does**

| It can | It cannot |
|---|---|
| Show your sessions and their live activity | Run an agent on the phone |
| Start a Chat or Develop session on your computer, and send messages | Work while your computer is off or asleep |
| Answer `ask_user` questions, and approve or deny commands | Change vendors, sign-ins, devices, access levels or auto-approve |
| Send things to the assistant: files, photos, links and text from the share sheet | Delete sessions in bulk |
| Share folders from the phone as a device (below) | |

**How it connects**

- **Pairing.** Mobile access is off by default. In Settings you turn it on, and your computer shows a QR code holding its address, a one-time secret and its certificate's fingerprint. The phone scans it. From then on the phone holds a device key in the iPhone Keychain (or Android's keystore) and proves it on every connection. Each phone is listed in Settings and can be revoked at once.
- **Same Wi-Fi.** The phone finds your computer on the local network. iOS asks permission for that (Local Network), and the app declares the service it looks for.
- **Away from home.** Through a tunnel you set up yourself, such as Tailscale or Cloudflare Tunnel. Celeste has no server of its own, so it doesn't offer one. The plan shows the steps.
- **The same interface.** The desktop screens already reach Core through one typed channel (section 5), and the browser preview already swaps in another way to reach it. The phone adds a third, an encrypted WebSocket that pins the certificate. The phone screens are the same React code, with layouts made for a small screen.
- **Narrower permissions than the desktop.** Every Core method carries a scope (read, chat, approve, admin), and a phone is never given admin. Risky actions can be set to need approval on the phone.

**The phone as a device.** The companion can also act as a device for the assistant (section 7.11), within what iOS and Android allow:

| | iPhone and iPad | Android |
|---|---|---|
| Folders you choose (Files, iCloud Drive, On My iPhone) | Yes, while the app is open | Yes, with storage access you grant |
| Photos you choose | Yes | Yes |
| Send to Celeste from the share sheet | Yes | Yes |
| Clipboard | Only while the app is on screen | Only while the app is on screen |
| Commands | No | Through ADB, as in section 7.11 |
| Reachable with the app closed | No. iOS suspends an app soon after it leaves the screen, and background pushes are throttled **Verify** | Yes, with a background service you allow **Verify** |

A phone whose app is closed shows as asleep, and the assistant is told so instead of waiting.

**How it is built.** Capacitor 8 (MIT) wraps the React interface as a native iPhone, iPad and Android app and gives it native plugins (Keychain, QR scanner, share extension, local network discovery). The alternatives fit worse. React Native would mean rewriting every screen. A web app saved to the home screen needs a trusted HTTPS address for a computer on your Wi-Fi, which is awkward without a server. The share extension and local discovery need a little Swift.

**No push notifications in v1.** Apple and Google deliver push only with a provider key, and that key can't ship inside an open-source app. So a closed phone gets no "needs you" alert. It shows when the app is opened. An optional small relay run by the project could come later, and it would carry no message content (decision 11).

**Cost and rules.** An iOS app needs an Apple Developer Program account (US$99 a year **Verify**), builds on macOS (a cloud macOS builder in CI is enough), review before the App Store, and TestFlight for betas, whose builds expire after 90 days **Verify**. Android needs a Google Play developer account. Celeste's Apache-2.0 license is fine for both stores.

**What earlier phases do now so this stays easy**

- Everything the interface needs from Core keeps going through the one typed channel, never through anything Electron-only.
- Each Core method gets a scope as it is added.
- New screens avoid layouts that only work on a wide window where avoiding that costs nothing.

## 8. Phases

Sizes are relative: S, M or L.

### Phase 1: Design prototype, for your approval (L)

**Goal:** see and click through the whole app. No vendor calls and no database.

| Real in this phase | Mock in this phase |
|---|---|
| Window, navigation, all three tabs | Everything the agent says or does |
| Dark and light themes, switching live | Vendor connection status and the Connect button's browser step |
| Glow line and its comparison script | Tools & Integrations status |
| File drop, paste and image hover previews | Sessions, which reset on restart |
| Dropdowns, effort slider, approval selector | Workflow runs, which are simulated |
| Workflow canvas: drag, zoom, select, edit details | |
| Wizard and settings flows | |

**Steps:**

1. Set up the project: `git init`, electron-vite, React, TypeScript, Tailwind, frameless window. Move your pictures and kits into `design/`, which is git-ignored so it can't be published by accident.
2. Build tokens, fonts, theme switching and base components.
3. Build the glow line and verify it against your picture.
4. Trace the interim logo and generate icons.
5. Build the shell: top bar, tabs, sidebar, bottom-left settings button.
6. Build the Chat home screen and composer from your inner design.
7. Build the conversation screen, driven by `MockAdapter`: streaming, shimmer labels, tool cards, `ask_user`, approval prompts, errors, stop and continue.
8. Build attachments: drop overlay, chips, hover preview.
9. Build Develop: project picker, conversation with diffs, changes and files panels.
10. Build Workflows: list, canvas, node details, toolbar, simulated run.
11. Build the Tools & Integrations panel, wizard and settings.
12. Compare screens side by side with your pictures and fix differences.

**Scenario switcher.** A dev-only menu (Ctrl+Shift+D) jumps straight to any state, so you can review them all without waiting: Empty, Thinking, Tool running, `ask_user`, Approval prompt, Error, Long conversation, Wizard. It isn't included in release builds.

**You review by running** `npm run dev`.

**Done when:** you've approved the screens in both themes and any change list is resolved.

### Phase 2: App foundation (S)

Core process, SQLite and migrations, typed API, real session create/rename/delete/search using `MockAdapter`, saved settings and wizard, credential storage.

**Done when:** after closing and reopening, every mock session, draft and setting is intact, and delete with Undo works.

**Status: built and verified** (53 unit tests, plus `npm run verify:persistence` and `npm run verify:package` against the real app).

What was built, and the choices made along the way:

- **Core process.** A utility process owns the database and the scripted assistant. Each window gets its own message port straight to it, so conversations never pass through the main process. If Core dies, the main process restarts it and reloads the windows. Closing the window or the app first makes the window save its unsent text, then Core closes the database.
- **One log per session.** Every event is written to SQLite, then pushed to the window. Opening a session replays its log with the same reducer that handles live events, using each event's recorded time, so "Thought for 4s" survives a restart. Besides the agent's events, the log holds what you did (your messages, approval and question answers) and one note Celeste writes itself, `turn.abandoned`.
- **Same code in the browser preview.** The session logic runs on a `Store` interface with a SQLite and an in-memory implementation. One contract test runs against both, and `npm run dev:web` uses the in-memory one (nothing saved).
- **Migrations** use SQLite's `user_version`, run in a transaction, keep a `.v<N>.bak` copy of the old file before an upgrade, and refuse data made by a newer Celeste without touching it.
- **Delete** hides a session at once and removes it for good after 10 seconds. Anything still waiting when Celeste closes is removed at the next start. Delete all has no undo.
- **Attachments** are saved when added (so an unsent draft with files survives a restart), linked to the session on send, and shown through `celeste-file://attachments/`, which serves that one folder only. Only known file types keep their extension.
- **Credentials.** API keys go to `safeStorage` in the main process. The window can store, remove and ask for the last four characters, and never read a key back. If the system cannot encrypt, nothing is stored.
- **Search** is FTS5 over titles, your messages and the assistant's answers, with prefix matching.
- **After a restart:** a turn that was running is marked cut off and the session is idle. A question or approval that was waiting stays on screen. Answering it starts a new turn with the answer as a message, which is the fallback the plan describes. Real resume of the vendor's own session is Phase 4.
- **Still sample content:** the assistant, the sample sessions (added on the first start only), the Connect button's steps, and workflows. Workflows are saved in Phase 7.

### Phase 3: Devices (L)

Brought ahead of the vendor adapters at your request. It needs only Phase 2 (the database, Core and secrets). The device tools are served by Celeste's own MCP server, built here with the official SDK and tested with a real MCP client and with the scripted assistant. Each vendor adapter in Phases 4 and 5 then connects to the same server.

**Steps:**

1. **Spikes first**, to settle the **Verify** items in section 7.11:
   - SSH to a Windows machine's OpenSSH Server and run encoded commands in Windows PowerShell 5.1 and in PowerShell 7 (quoting, exit codes, output encoding).
   - Pair and connect an Android phone over Wi-Fi from Celeste, with Google's `adb` and with `@yume-chan/adb`, and browse mDNS from Core on Windows (firewall prompt, multicast).
   - From Windows, with Apple's drivers, list a paired iPhone and read its syslog and media files with libimobiledevice, then decide whether the iPhone helper ships here or waits for the Companion in Phase 9.
   - Copy a 100 MB folder of many small files over SFTP, to size the snapshot limits.
2. **Connector contract and tests that need no VM:** a fake connector, and an in-process SSH server built with `ssh2`'s server mode.
3. **Storage:** the migration, secrets, and host-key pinning.
4. **The device MCP server:** on loopback only with a token for each session, the access levels, the approval gate and the activity record.
5. **Connectors:** SSH (with PowerShell for Windows), Hyper-V, Android, and the local VM lists for each desktop.
6. **Discovery:** network announcements, local VM lists, manual entry.
7. **Screens:** Settings, Devices; the Add dialog; the panel section; chips; the remote folder picker; snapshots. The scripted assistant gets a devices scenario, so you can review all of it before any vendor is connected.

**Done when:** with a real Linux VM, a Windows VM, a Hyper-V VM and an Android phone, you can add each one, and a real MCP client and the scripted assistant can run a command and read a file on it. The approval card shows the exact command. A snapshot of a folder opens as local context. A changed host key is refused. Dropping Wi-Fi in the middle of a command gives a clear error and nothing hangs. A Read-only device offers no command tool. Everything shows in the session log.

**Status: built, and verified except for what needs your devices** (132 unit tests, plus `npm run verify:devices`, `verify:persistence` and `verify:package` against the real app).

What was built, and the choices made along the way:

- **Connectors** behind one contract: SSH (`ssh2`, with SFTP, host-key pinning, output cap, timeout, Stop, one command at a time, and a clear error when the connection drops), PowerShell Direct for Hyper-V, and Android through Google's `adb`. SSH is tested against an in-process SSH server with real SFTP, posing as Linux or Windows. Hyper-V and Android are tested against canned tool output, which proves the commands and the error messages, not that they work on a real VM or phone.
- **The tools** (`devices_list`, `device_run`, `device_read_file`, `device_list_dir`, `device_write_file`, `device_pull`, `device_screenshot`) enforce everything themselves: a session sees only devices attached to it, a Read only device has no command or write tool, and an Ask first device raises an approval card with the exact command before anything runs. The card names the device and has no "allow for this session" button.
- **One MCP server for every vendor**, built with the official SDK. It listens on `127.0.0.1` only, each session has its own token, and it refuses requests from web pages or with the wrong address. No vendor is connected to it yet: each adapter in Phases 4 and 5 does that. Until then the scripted assistant uses the same tools, so you can review everything.
- **Secrets stay in the main process.** Core asks for a device's password only when it is about to connect, and the main process answers only for device passwords.
- **Snapshots** copy a folder into a local cache, skipping build folders and files over 25 MB, and ask first above 200 MB or 10,000 files. A refresh and a delete remove the old copy.
- **Finding devices:** announcements on the network (SSH machines, and Android phones ready to pair), and the VM lists of Hyper-V, WSL, VirtualBox, VMware, Parallels, UTM, Multipass and libvirt.
- **Android pairing** by QR code or six-digit code, and the phone is found again when it moves to a new port.
- **Screens:** Settings, Devices; the Add dialog; the folder picker; the Devices section of Tools & Integrations; device chips in a chat's header. The browser preview runs the same code with pretend devices.
- Also fixed on the way: a render loop (a store selector returning a new list each time), and the app now has an error boundary, so a screen that fails to draw shows a message and a Reload button instead of a blank window. The interface's libraries moved to `devDependencies`, so the installer carries only what the main process and Core load.

**Not done, and why:**

- **The spikes that need real hardware.** This PC has no phone connected, no running VM, no WSL distro, a stopped `sshd`, and no administrator rights for Hyper-V, and Celeste does not change those. Still to try: SSH to a real Windows machine with Windows PowerShell 5.1 and 7, a real Android pairing, the Hyper-V connector on a real VM, the iPhone helper, and the macOS and Linux VM commands.
- **`adb` is found, not downloaded.** Celeste uses Google's `adb` if it is installed (it looks in the Android SDK folders and the PATH, and honors `CELESTE_ADB`). Downloading platform-tools when first needed waits for a decision on Google's redistribution terms.
- **"Ask for the password each time"**, `device_push`, WinRM, mounting, and Develop on a remote folder.
- **The iPhone helper.** Its spike is one of those that need a phone.
- **Vendor connections** to the tool server (Phases 4 and 5).

### Phase 4: Copilot end to end (M)

Full adapter: streaming, tools, approvals, `ask_user`, attachments, effort, models, resume, fallback, Connect button, runtime download. Also the adapter contract test suite, which includes a call to a device tool through Celeste's device server (Phase 3), approval card included.

**Done when:** real tasks complete in Chat and Develop, and force-quitting mid-task then resuming keeps the full conversation and agent context.

### Phase 5: Claude, OpenAI, Gemini (L)

A short test against each real CLI to settle the **Verify** items, starting with Claude's sign-out side effect, then each adapter in turn. Includes capability-driven UI and each vendor's Connect flow. Each adapter also connects to the device server (Phase 3) and passes device snapshots through the vendor's extra-folder option.

**Done when:** all four vendors pass the same contract suite, and any gaps appear clearly in the UI.

### Phase 6: Modes and tools complete (L)

- **Develop:** diff review, file tree, integrated terminal, git worktrees, vendor-neutral per-turn snapshots with revert.
- **Chat:** output file cards.
- **Tools:** real MCP configuration and status, passed to all vendors.
- **Search:** global search from the top bar.

**Done when:** a real change can be made, reviewed and reverted in Develop, and a real internal MCP server works with every vendor.

### Phase 7: Workflows (L)

Schema, runner, Tool and Agent steps, inputs and outputs, error handling, live run view and history, Build with AI, versions, share and templates.

**Done when:** your "Update old KBs" example runs end to end from the canvas, including a pause for a question.

### Phase 8: Public release (L)

- **Distribution:** Windows and Mac installers, code signing and Mac notarization, auto-update, then Linux. Unsigned apps trigger security warnings that would put off public users.
- **Vendor sign-off:** the confirmations in section 6.2 answered, and only approved sign-ins enabled.
- **Open source:** public repository, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` with a private way to report vulnerabilities, and release builds produced by CI from the public code. Code signing for an open-source project still needs a certificate and an Apple Developer account, so check free programs for open-source projects.
- **Legal:** third-party notices, a privacy policy stating there's no Celeste server, vendor branding review, a rights review before anything from `design/` goes public, and a trademark check and policy for the name "Celeste", which is already used by other products. The logo stays outside the code license.
- **Quality:** security review of credential handling and auto-approve, opt-in crash reporting, accessibility pass, and testing on a company network with a proxy.
- **Support:** user documentation and a place to report problems.

**Done when:** clean Windows and Mac machines can install Celeste, finish the wizard and run a session with every sign-in that ships.

### Phase 9: Mobile companion for iPhone, iPad and Android (L)

After the first public release. It needs your decisions 9 to 11 and a design for the phone screens.

**Steps:**

1. **Network access to Core:** an authenticated, encrypted channel, pairing by QR code, scopes for each method, revocation of a phone, and a record of what a phone did.
2. **Phone layouts** for the screens, from your design.
3. **The Capacitor app,** iOS first with Android following from the same code: secure storage, QR scanner, finding your computer on the local network.
4. **The phone as a device:** shared folders, "Send to Celeste" from the share sheet, clipboard, and on Android ADB or the Companion.
5. **Distribution:** TestFlight beta, then the App Store, and an internal track on Google Play.

**Done when:** a paired iPhone on the same Wi-Fi can open a session, send a message, answer a question and approve a command on your computer, and removing the phone from Settings cuts it off at once.

### Testing throughout

- **Adapter contract suite:** one scripted scenario every vendor must pass (text, tool call, approval, `ask_user`, image, interrupt, resume). Recorded vendor events let it run without spending tokens.
- **Connector contract suite (Phase 3):** one scenario every device connector must pass (run a command, output cut at the limit, timeout, Stop, read, write and list, odd paths, a changed host key), plus tests that Read only never offers the command tool and that Ask first always asks. They run against the fake connector and the in-process SSH server.
- **Vitest:** event reducers, session restore, workflow runner.
- **Playwright for Electron:** startup, core flows, and screenshot comparison of key screens and the glow.

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Vendor tools change quickly.** Some pieces are explicitly unstable, such as Codex `tool/requestUserInput` and Gemini `unstable_setSessionModel` | Pinned versions, contract suite, all vendor code behind one interface |
| **Sign-in terms limit what you can ship.** Personal users with only a Claude subscription can't use it in Celeste without Anthropic's approval | Launch with the sign-ins that are safe today (section 6.2), lead with Copilot's free tier as the easy start, and get the vendor confirmations before launch. Celeste never reads a token held by a vendor's CLI |
| **ChatGPT plan usage is a preview** and its limits could change | API keys remain the alternative, and the flow sits behind the OpenAI adapter |
| **A public repository exposes everything committed.** The kits' notes say the reference images belong to their creators | `design/` is git-ignored from the first commit, no vendor secret is needed anywhere, and `SECURITY.md` gives researchers a private channel |
| **Connecting in Celeste could disturb a user's other CLI logins**, such as signing out their terminal `claude` | Test each login against a throwaway config folder before running it on a real one |
| **Runtime downloads can fail**, especially on company networks | Clear errors with retry, integrity checks, and an Advanced setting to use an installed CLI |
| **Auto-approve by default.** The agent runs commands as the user, and content from web pages or MCP tools could try to steer it. A public audience, including company machines, raises the stakes | Kept as you asked. The current mode is always visible in the composer, the wizard explains it in one line, and Claude uses its classifier-checked `auto` mode where available. Reviewed again in Phase 8 |
| **Packaging.** Mac signing covers everything in the app, and the app is two programs (main and Core) | `node:sqlite` removes the native-module rebuild this row was about. `npm run verify:package` runs the built app from an `app.asar` as an installer would lay it out. Real installers, signing and notarization are Phase 8 |
| **Vendor sessions can disappear** through cleanup or upgrades | Celeste's own log is the source of truth, and fallback reseeds the agent |
| **The glow can only be exact at one size** | Exact at the reference size, proportional elsewhere, and reviewed at common window sizes |
| **Licensing before the public release.** The kits' notes ask for a trademark and font review, and vendor logos appear in the UI | Review in Phase 8, including the name "Celeste" (section 6.4 covers runtime licenses). Outfit and JetBrains Mono are open-source fonts |
| **Devices can be damaged, or their data leaked.** An assistant with a shell on a shared or production machine can do harm that can't be reverted, and prompt injection from remote content makes that more likely | A new device is Read only, commands ask by default and ignore the global auto-approve, the assistant sees only devices attached to its session, every call is recorded, and Full carries a warning badge. Reviewed again in the Phase 8 security review |
| **Setup on the other machine is the user's job.** OpenSSH Server on Windows, the PowerShell 7 subsystem and WinRM trust all need steps there | Celeste shows the exact steps to copy, tests the connection and explains each failure. It never changes a remote machine or your system settings itself |
| **Finding devices is unreliable on some networks.** VPNs, guest Wi-Fi and client isolation block the announcements, and Windows machines rarely announce SSH | Typing an address always works, QR pairing falls back to the pairing code, and a subnet scan is optional |
| **Android pairing from a client other than Google's `adb` is less proven**, and platform-tools redistribution terms are unchecked | A spike at the start of Phase 3. The fallback is Google's own `adb`, downloaded on demand and not bundled |
| **What the assistant reads on a device goes to your AI vendor**, which may break a company policy for work machines or phones | Said plainly when adding a device and when attaching one, and controlled per device |
| **iPhone expectations.** People may expect an iPhone to behave like a Linux machine | Stated up front: no shell, only the helper and the Companion's shared folders and share sheet, and only while the app is open |
| **Celeste can't run on iOS itself.** Electron is a desktop framework, and the vendor agents are desktop programs an iPhone can't run | The companion app controls your desktop Celeste instead (section 7.12), and the plan and the app say so plainly |
| **A paired phone can steer a desktop agent that runs commands** | Mobile access is off by default, each phone is paired by QR code and can be revoked at once, its permissions are narrower than the desktop's (no settings, vendors, devices or deletion), and risky actions can require approval on the phone |
| **No push notifications without a server.** Apple and Google need a provider key that can't ship inside open-source code | None in v1: the phone shows what needs you when opened. An optional small relay run by the project can come later and would carry no message content |
| **Apple's rules and costs.** A paid developer account, builds on macOS, review, and TestFlight builds that expire | Planned in decision 9. Betas through TestFlight first, with a macOS cloud builder in CI |
| **iOS and macOS ask permission before an app finds devices on the network**, and iOS suspends apps in the background | Celeste explains the prompt first and typing an address always works. A phone shows as asleep when its app is closed |

## 10. Sources

**Claude:**
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[Approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input),
[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
[External session storage](https://code.claude.com/docs/en/agent-sdk/session-storage),
[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[Desktop app](https://code.claude.com/docs/en/desktop),
[Authentication](https://code.claude.com/docs/en/authentication),
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

**GitHub Copilot:**
[Copilot SDK](https://github.com/github/copilot-sdk/blob/main/README.md),
[Node.js SDK](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md),
[Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
[SDK GitHub OAuth setup](https://github.com/github/copilot-sdk/blob/main/docs/setup/github-oauth.md),
[SDK bundled CLI setup](https://github.com/github/copilot-sdk/blob/main/docs/setup/bundled-cli.md),
[SDK authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/README.md),
[Copilot CLI license](https://github.com/github/copilot-cli/blob/main/LICENSE.md),
[About Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli),
[GitHub OAuth flows](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

**OpenAI:**
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk),
[App server](https://learn.chatgpt.com/docs/app-server),
[Authentication](https://learn.chatgpt.com/docs/auth.md),
[Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart),
[ChatGPT plan usage for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source),
[Sign-in for open-source clients](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[Plan usage with Codex app server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server),
[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[UI and UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

**Gemini:**
[Headless mode](https://geminicli.com/docs/cli/headless.md),
[ACP mode](https://geminicli.com/docs/cli/acp-mode.md),
[Terms and privacy](https://geminicli.com/docs/resources/tos-privacy.md),
[Authentication](https://geminicli.com/docs/get-started/authentication.md),
[Gemini API OAuth](https://aistudio.google.com/docs/oauth),
[Zed external agents](https://zed.dev/docs/ai/external-agents)

**Agent Client Protocol:**
[Supported agents](https://agentclientprotocol.com/get-started/agents)

**Secondary sources on Claude client registration:**
[Moltis on Anthropic OAuth](https://docs.moltis.org/anthropic-oauth.html),
[Third-party OAuth feature request](https://claudeissues.com/issue/32335-feature-feature-request-third-party-oauth-support-for-consumer-subscriptions)

**Devices:**
[Android Debug Bridge, wireless debugging](https://developer.android.com/tools/adb),
[ADB over Wi-Fi design (AOSP)](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/dev/adb_wifi.md),
[PowerShell remoting over SSH](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/ssh-remoting-in-powershell?view=powershell-7.5),
[PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct),
[ssh2](https://github.com/mscdex/ssh2),
[bonjour-service](https://www.npmjs.com/package/bonjour-service),
[@yume-chan/adb](https://www.npmjs.com/package/@yume-chan/adb),
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3),
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
[Copilot CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference),
[Codex CLI reference](https://developers.openai.com/codex/cli/reference),
[WinFsp licensing](https://winfsp.dev/com/),
[SSHFS-Win](https://github.com/winfsp/sshfs-win).
WinRM details come from secondary sources and are marked **Verify**.

**Mobile and iPhone:**
[Capacitor](https://capacitorjs.com/docs),
[libimobiledevice](https://libimobiledevice.org),
[Local network permission (Apple)](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription),
[MCP TypeScript SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk),
[Parallels command line](https://docs.parallels.com/landing/parallels-desktop-developers-guide/command-line-interface-utility/manage-virtual-machines-from-cli/general-virtual-machine-management/list-virtual-machines),
[UTM scripting](https://docs.getutm.app/scripting/scripting/),
[Apple Developer Program renewal](https://developer.apple.com/support/renewal),
[Background pushes (Apple forum)](https://developer.apple.com/forums/thread/757094).
Apple's fee, the TestFlight 90-day expiry and iOS background limits come from secondary sources or general knowledge and are marked **Verify**. That Electron has no iOS or Android target is from its documentation of supported platforms and general knowledge.
