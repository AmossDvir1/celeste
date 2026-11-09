# Changelog

All notable changes to Celeste. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Desktop control (Windows, off by default)

- The assistant can ask to see and use this computer's screen, mouse and keyboard, for tasks that have no command or tool. It is **off until you switch it on** in Settings, and even then it can do nothing until you press Allow on a card in the conversation.
- It lasts 15 minutes in one chat. A bar stays on screen with **Stop** and **+15 min**, and **Ctrl+Alt+Esc** stops it at once from anywhere. It cannot click or type into Celeste's own windows, and Celeste's windows are left out of the pictures it sees.
- Everything it does is listed in the conversation. What it sees on the screen goes to your AI vendor, so close anything private first.

## [1.0.0] - 2026-11-08

The first release.

### Talk to your assistants from one place

- **GitHub Copilot** and **Claude** work: streaming answers, tools, approvals, questions the assistant asks you, image attachments, switching model and effort in the middle of a conversation, and picking a conversation up again after a restart.
- OpenAI and Gemini are shown as **Coming soon**.
- Your own copy of Claude Code or the Copilot CLI is used when it is a version Celeste has been tried with; otherwise Celeste downloads its own, checked against npm's checksum. One switch in Settings turns that off.

### Chat and Develop

- **Chat** for questions and writing. Files an assistant makes appear as cards under its answer, to open, show in their folder or save a copy of.
- **Develop** works in a project folder: diffs in the conversation, a Changes panel, a review screen, a file tree you can drag files from into a message, going back to before any message (and undoing that), and separate copies of a project (git worktrees) so a session never touches your working folder.
- An **integrated terminal** in the project folder, next to the agent's own commands.

### Workflows

- Build a workflow on a **canvas** from commands, web requests, files, your own tools and assistant steps, with inputs, time limits and Stop / Try again / Carry on. Every change is a saved version you can go back to.
- **Before a run does anything, one card lists everything it will do**, with your answers filled in. Nothing happens until you allow it.
- Run from the screen or from a conversation with **`/`**; the result is folded into the conversation and the assistant is told how it ended. The assistant can run the workflows you allow, behind the same card.
- **Build with AI** drafts a workflow from a description, and **Make this a workflow** turns a conversation into one. Both give you a draft to look over.
- **Share** a workflow as a file (secrets and your devices left out) and **Import** one; an imported workflow never runs unseen.

### Tools and devices

- **Tools & Integrations:** add an MCP tool once and every vendor can use it, with secrets kept in your system's secure storage.
- **Devices:** other computers, virtual machines and Android phones as context or as places to work. Read-only unless you say otherwise; commands on a device show the exact command and ask first.

### Everything else

- Windows installer (`.exe`) and MSI, and macOS disk images. They are **not signed with a paid certificate yet**, so your system may warn you the first time (see the README). There is no automatic update: Settings → About has a manual *Check for updates*.
- Light and dark themes, an accessibility audit on every screen in both, and keyboard use throughout.
- No Celeste server, no account with us, no analytics: see [PRIVACY.md](PRIVACY.md).

### Known limits

- Tried by hand on Windows. On macOS it is checked by automatic tests only; no one working on Celeste has a Mac.
- Claude has been tried against the real Claude Code program and a stand-in for Anthropic's API, not yet against a real account.
- Linux is not released.
- Workflows run in one line (no branches yet); there are no schedules.
