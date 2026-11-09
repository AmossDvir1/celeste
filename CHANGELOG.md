# Changelog

All notable changes to Celeste. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added
- **Celeste for Android (experimental)**: use Celeste from your phone on the same Wi-Fi.
  - **Settings → Phone** shows a QR code. The page it opens on the phone offers the app.
  - **Connecting**: the app finds the computer by itself. You compare three pictures on both screens and press Allow on the computer.
  - **On the phone**: follow your chats live, send messages, start a chat, stop a reply, and answer approvals and questions.
  - **With the app closed**: switch on "Stay connected" and approvals arrive as notifications with Approve and Deny.
  - **Security**: everything is encrypted end to end, with no server in between. A phone can't change settings, sign-ins or devices, and Remove cuts it off at once.
  - **Develop from the phone**: start a Develop session in a project you already used on the computer, optionally in a separate copy.
  - **Choose the model on the phone**: pick the model and thinking effort for a new chat, or change them in an open one.
  - **Celeste can use the phone**: it can read your notifications, reply to messages or clear them, open an app or a link, or set an alarm or timer. Each ability has a switch in the app, and every request asks you on the phone first.
    - **Location**: where the phone is, once each time you allow it.
    - **Photos and files**: you pick them on the phone, and they're copied to the computer for the assistant.
    - **Calendar**: read your next events, and add one.
    - **Texts and calls**: the messaging or phone app opens with everything filled in. You press Send or Call yourself.
  - **Use the phone in workflows**: a workflow step can use your phone, like **Use the computer**. The run checks the phone is connected before it starts, and the phone's cards name the step.
  - **`/phone`** in the chat starts a request for your phone, or opens Settings → Phone when none is connected.
  - **Phone control**: when no other tool can do a task, Celeste can ask to see your phone's screen and tap, swipe and type.
    - It asks on the phone, for 15 minutes at most.
    - While it works, a coloured border and a Stop button stay on screen. Pressing volume down three times also stops it.
    - Touching the screen pauses it until you press Continue.
    - It never types into password fields, never touches password managers or Android's installer, and does nothing while the phone is locked.
    - **Apps Celeste never uses**: add your bank or anything private in the app. Celeste won't read their notifications or touch their screens.
    - If you switch it on, it asks again before pressing buttons like Send, Pay or Delete.

## [1.1.0] - 2026-11-09

### Desktop control (Windows, off by default)

- The assistant can ask to see and use this computer's screen, mouse and keyboard, for tasks that have no command or tool. It is **off until you switch it on** in Settings, and even then it can do nothing until you press Allow on a card in the conversation.
- It lasts 15 minutes in one chat. A bar stays on screen with **Stop** and **+15 min**, and **Ctrl+Alt+Esc** stops it at once from anywhere. It cannot click or type into Celeste's own windows, and Celeste's windows are left out of the pictures it sees.
- Everything it does is listed in the conversation. What it sees on the screen goes to your AI vendor, so close anything private first.
- It can be limited to **one window or one program**: the rest of the screen is painted black in what it sees, and clicks or typing anywhere else are refused. A window in front of the one it was given is refused too.
- **Never touch these** (Settings, Desktop control): programs, or words in a window's title, that it never sees or touches, even when you let it use the whole screen.
- It does not type into a **password field**, and it asks you again before pressing a button called Send, Buy, Delete, Allow and the like.
- If you **move the mouse**, it pauses until you press Continue on the bar. It also waits while a question is open in Celeste.
- New tools to list the open windows and bring one to the front.
- Workflows: a **Use the computer** step, which asks you on the run's card before it uses the screen, and `/computer` in the message box.
- Workflows: each assistant step is now told what the steps before it were asked and what they produced, so “go to my friends list” after “go to my Facebook” knows which list. Before, every step started knowing only its own words.
- Settings: how long one yes lasts (15 minutes, 1 hour, or until you stop it), whether it may ask for the whole screen, and a list of the recent times it had the screen.

### Known limits

- Desktop control works on Windows only; on a Mac the assistant is told it is not available yet.
- It has been tried with a stand-in for the assistant on one screen at 100% scaling, not yet with a real assistant, on other monitors, at higher scaling, or with programs run as administrator.

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
