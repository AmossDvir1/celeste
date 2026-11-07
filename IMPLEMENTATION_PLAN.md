# Celeste: Implementation Plan

Draft for your review, 7 November 2026. Package versions and vendor behavior were checked on this date. Anything not yet confirmed is marked **Verify**.

## 1. Summary

Celeste is an open-source Electron desktop app built with React and Tailwind, to be published for personal users and teams at work. It gives one interface over Claude, GitHub Copilot, OpenAI and Google Gemini. Each vendor's own agent does the work underneath: editing files, running commands, browsing the web and calling tools. Celeste adds the interface, saved sessions, a shared tool list and workflows. It has no server of its own, so each user's usage goes to their own vendor account.

The work runs in seven phases. **Phase 1 is a clickable design with mock data and no real functionality, so you can approve it before anything else is built.**

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

## 2. Decisions for you

None of these blocks Phase 1. Each has a default that I'll use unless you say otherwise.

| # | Question | Default | Needed by |
|---|---|---|---|
| 1 | Which open-source license for Celeste's code? | Apache-2.0. It's permissive, includes the patent grant company legal teams look for, and matches Codex and Gemini CLI. The name and logo stay yours and aren't covered | Before the repository goes public |
| 2 | Which vendors come first? | Copilot, then Claude. Copilot has the fewest sign-in unknowns, is the default model in your picture, and is installed on your machine (1.0.95), as is Claude (2.1.259). Codex and Gemini are not. | Phase 3 |
| 3 | What should the light theme look like in the inner chat area? Your picture only shows dark. | I'll propose the same arc in softer tones on the light background, for you to judge in Phase 1 | Phase 1 review |
| 4 | Which platforms at launch? | Windows and Mac, with Linux soon after. Development stays Windows-first, with the code kept cross-platform | Phase 7 |
| 5 | Final logo | Interim logo until yours is ready | Any time |

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
| Database | better-sqlite3 | 13.x | Fast local storage, with full-text search for sessions |
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

Opened from the bottom-left button. Sections: General, Appearance, AI Vendors, Agent Defaults, Tools & Integrations, Data (storage location, export, delete all), About.

### 7.9 Tools & Integrations

Celeste stores one list of MCP servers and passes it to whichever vendor runs the session. MCP (Model Context Protocol) is the standard way agents connect to outside tools. Your internal tools are added once rather than per vendor. The panel matches `Design.jpeg`, with search and connection status. Phase 1 shows the pictured list as mock data.

Celeste also runs a small MCP server of its own, for `ask_user` on vendors with no native version. **Verify** long-wait behavior, because some MCP clients time out on tool calls that wait for a person.

### 7.10 Workflows

A workflow is saved as JSON and validated against a shared schema.

| Step type | What it does | Picture |
|---|---|---|
| Start | Defines inputs, such as `older_than_days` | Blue pill |
| **Tool step** | Calls an MCP tool or a built-in (shell command, HTTP request, file) directly, with no model involved. The input form comes from the tool's schema | Pink: Find old KBs, Install updates, Wait for service |
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

### Phase 3: Copilot end to end (M)

Full adapter: streaming, tools, approvals, `ask_user`, attachments, effort, models, resume, fallback, Connect button, runtime download. Also the adapter contract test suite.

**Done when:** real tasks complete in Chat and Develop, and force-quitting mid-task then resuming keeps the full conversation and agent context.

### Phase 4: Claude, OpenAI, Gemini (L)

A short test against each real CLI to settle the **Verify** items, starting with Claude's sign-out side effect, then each adapter in turn. Includes capability-driven UI and each vendor's Connect flow.

**Done when:** all four vendors pass the same contract suite, and any gaps appear clearly in the UI.

### Phase 5: Modes and tools complete (L)

- **Develop:** diff review, file tree, integrated terminal, git worktrees, vendor-neutral per-turn snapshots with revert.
- **Chat:** output file cards.
- **Tools:** real MCP configuration and status, passed to all vendors.
- **Search:** global search from the top bar.

**Done when:** a real change can be made, reviewed and reverted in Develop, and a real internal MCP server works with every vendor.

### Phase 6: Workflows (L)

Schema, runner, Tool and Agent steps, inputs and outputs, error handling, live run view and history, Build with AI, versions, share and templates.

**Done when:** your "Update old KBs" example runs end to end from the canvas, including a pause for a question.

### Phase 7: Public release (L)

- **Distribution:** Windows and Mac installers, code signing and Mac notarization, auto-update, then Linux. Unsigned apps trigger security warnings that would put off public users.
- **Vendor sign-off:** the confirmations in section 6.2 answered, and only approved sign-ins enabled.
- **Open source:** public repository, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` with a private way to report vulnerabilities, and release builds produced by CI from the public code. Code signing for an open-source project still needs a certificate and an Apple Developer account, so check free programs for open-source projects.
- **Legal:** third-party notices, a privacy policy stating there's no Celeste server, vendor branding review, a rights review before anything from `design/` goes public, and a trademark check and policy for the name "Celeste", which is already used by other products. The logo stays outside the code license.
- **Quality:** security review of credential handling and auto-approve, opt-in crash reporting, accessibility pass, and testing on a company network with a proxy.
- **Support:** user documentation and a place to report problems.

**Done when:** clean Windows and Mac machines can install Celeste, finish the wizard and run a session with every sign-in that ships.

### Testing throughout

- **Adapter contract suite:** one scripted scenario every vendor must pass (text, tool call, approval, `ask_user`, image, interrupt, resume). Recorded vendor events let it run without spending tokens.
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
| **Auto-approve by default.** The agent runs commands as the user, and content from web pages or MCP tools could try to steer it. A public audience, including company machines, raises the stakes | Kept as you asked. The current mode is always visible in the composer, the wizard explains it in one line, and Claude uses its classifier-checked `auto` mode where available. Reviewed again in Phase 7 |
| **Packaging.** better-sqlite3 needs rebuilding for Electron on each platform, and Mac signing covers everything in the app | Handle early with a packaged test build at the end of Phase 2 |
| **Vendor sessions can disappear** through cleanup or upgrades | Celeste's own log is the source of truth, and fallback reseeds the agent |
| **The glow can only be exact at one size** | Exact at the reference size, proportional elsewhere, and reviewed at common window sizes |
| **Licensing before the public release.** The kits' notes ask for a trademark and font review, and vendor logos appear in the UI | Review in Phase 7, including the name "Celeste" (section 6.4 covers runtime licenses). Outfit and JetBrains Mono are open-source fonts |

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
