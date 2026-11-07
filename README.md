# Celeste

Your AI workbench: one desktop app for Claude, GitHub Copilot, OpenAI and Google Gemini.
Built with Electron, React and Tailwind. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full plan.

## Status: Phase 1, design preview

This build is for reviewing the design. **Nothing talks to a real AI vendor yet**: the assistant, the vendor
connections, the tools list and the workflow runs are scripted samples, and sessions reset when you quit.
What is real: the window, navigation, both themes, the glow line, the composer (effort slider, model and
approval pickers), file drop / paste / image hover previews, the workflow canvas, the setup wizard and settings.

## Run it

```bash
npm install
npm run dev
```

Requires Node 20.19 or newer. `npm run dev:web` runs only the interface in a browser at http://localhost:5199,
which is handy for quick visual checks.

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
| `npm run typecheck` | Type-checks the app and the main process |
| `npm run build` | Production build into `out/` |
| `npm run shots` | Screenshots of the key screens in both themes: `scripts/.output/shots/` |
| `npm run glow:compare` | Renders the Chat home at the reference picture's size and measures the glow line against it |
| `npm run icons` | Regenerates the app icons from `src/renderer/assets/logo/celeste-mark.svg` |

## Logo

`src/renderer/assets/logo/celeste-mark.svg` is the only place the logo lives, and it is an interim trace of the
"C" without the star. To use the final logo, replace that file and run `npm run icons`.

## Layout

```
src/
  shared/      the vendor boundary: AgentEvent, AgentSession, AgentAdapter
  main/        the Electron window
  preload/     the small bridge the interface can call
  renderer/
    app/       shell: top bar, sidebar, layout, scenario switcher
    features/  chat, develop, workflows, settings, wizard, search, tools
    components shared pieces: buttons, menus, dialogs, markdown
    glow/      the glow line
    mocks/     the scripted assistant and sample data (replaced by real adapters later)
    stores/    app state
    styles/    design tokens for both themes
design/        your pictures and design kits (git-ignored: they belong to their creators)
```
