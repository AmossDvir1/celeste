# Changelog

All notable changes to Celeste. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Two Moons: a chat with two assistants.** On the home screen, under the message box, **Add a second moon** lets you pick what should happen: **Build and review** (one builds, the other checks, and the first fixes what it found, or says why it will not), **Plan, then build** (you agree to the plan first), **Find and fix a bug** (one makes it fail, the other fixes it, and the first tries again) or **Two reviews** (both look at once without seeing each other, and you see what both found). Each moon can have its own model. Celeste gives them their turns, so you see who is working, what they hand over and what they say to each other; Stop ends the run, and Revert on your message undoes what both did.
- A **code signing policy** ([CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)): what will be signed, who approves a release, and how, ready for the application to the SignPath Foundation. Every release page now links to it and to the privacy notes. The installers are still unsigned.
- **Celeste stays in the tray** (Windows). Closing the window hides it and Celeste keeps running, so chats, workflow runs and the phone connection carry on. Click the tray icon to open it, right-click to quit (it asks first if something is still going). While the window is hidden, a notification tells you when a chat or a workflow needs you, and clicking it opens that chat. Hiding the window ends any desktop control. One choice, in Settings, General, turns it off.
- A **compact window**. A button in the top bar (next to the window buttons, or Ctrl+Shift+M, or the tray menu) turns Celeste into a small side window at the bottom right of the screen, kept above other windows (a pin turns that off). It shows the chat folded to one line per step, with the message box under it; with no chat chosen it shows what needs you, a box to type in, and your recent chats; the Workflows tab lists your workflows with a Run button and what is running. Settings and the setup wizard open in the full window, and Celeste always starts as the full window (the small one remembers where you left it, and its pin). The change between the two is animated.
- **The assistant can look at Celeste itself.** Four tools that only read: the plugins you added and how their last test went, a few settings (never a key or a password), the latest workflow runs, and one run's details, so "why did my backup fail?" gets a real answer from the run's own error. They work in plan mode, and take about 470 tokens from each message.
- **The assistant can draft a workflow and propose a plugin, and you decide.** Ask it for a workflow and a card shows the draft: Save, Try again (you type what should differ, up to three times) or Deny. Nothing is saved until Save. A plugin it finds is shown on a card with the whole command and where it came from; Install saves it switched off, tests it, and switches it on only if the test passes. Neither works in a workflow's own assistant step, where nobody could answer.
- **The assistant can turn a plugin on or off, change how Celeste looks, change a workflow and remove a plugin.** Turning a plugin on or off, and the theme, the side panel and your name, need no card: it does it and leaves one line in the chat (a plugin whose last test failed is never turned on, and every other setting stays yours to change in Settings). A change to a workflow is drafted from your words and shown on a card to save as a new version (the old one is kept), and removing a plugin asks first and also deletes the secrets stored for it. None of these works in a workflow's own assistant step.
- **A card for something the assistant wants to add.** It shows a workflow's steps with Save, Try again (you type what should differ) and Deny, or a plugin's whole command line and where it came from, with a hidden box for each secret, so a secret goes to Celeste's encrypted store and never to the assistant or the log. The phone shows it as words with the same buttons (a plugin that needs a secret can only be installed at the computer).
- **Steer.** While an assistant works there is a third way to send: **Steer** (or Alt+Enter), for Claude and Copilot. The message joins what the assistant is doing, at its next step, and the work so far is kept, where Send now stops it and Add to queue waits. If the answer ends first, it becomes the next turn. The phone has the same button.
- **Usage.** A strip above Settings shows how much of each connected assistant's allowance is used and when it comes back: for GitHub Copilot, the premium requests of the month. Click a row for every meter, its amounts and reset time. It updates when the window gains focus and every 5 minutes. (Claude shows nothing there: Anthropic reports plan limits only for a claude.ai subscription login, which Celeste does not offer.)

- **Scheduled workflows.** A **Schedule** button next to Run (or the clock chip on a workflow, and a **Scheduled** list under your workflows) makes a workflow run by itself. You pick when (once, every so often, every day or weekdays, on chosen days of the week, once a month), see the next times and the same card as for a run, worded for repeating ("Daily at 09:00, Celeste will do this, without asking again"), and pressing **Schedule** is the approval: its runs then start at their time with no card. Each schedule has a switch, Change, Run now (an ordinary run with the usual card), a log of what it missed or skipped, and Delete; **Pause all** on the list, or **Pause all schedules** in the tray menu, stops every one from starting anything new. A schedule needs Celeste running: closing the window leaves it in the tray, the computer waking from sleep runs what came due, and in the installed Windows app a checkbox in the dialog starts Celeste when you sign in, with its window left in the tray. A failed scheduled run, or one that pauses itself, is told in a notification on the computer (a click opens the run) and on the phone; "Also when it finishes" is a choice on the schedule. The phone lists the schedules and switches them off and on; making or changing one stays on the computer. How it behaves: it runs once, every N minutes, daily, on chosen weekdays or on a day of the month, in the time zone it was made in (a time the clock skips runs just after the gap, one it repeats runs once). It runs once, every N minutes, daily, on chosen weekdays or on a day of the month, in the time zone it was made in (a time the clock skips runs just after the gap, one it repeats runs once). If you change the workflow, the schedule pauses at once and needs your OK again. A run that is late by more than two hours is skipped, not run late; one that overlaps the last is skipped; three failures in a row pause it; a run that waits for you for 30 minutes is stopped. A workflow can use `{{run.date}}` and `{{run.time}}`. A workflow with a step that uses the computer's mouse and keyboard cannot be scheduled.

- **Diagrams, charts and guided steps in the chat.** When an assistant answers with a diagram (Mermaid), a chart (bar, line or pie from a small list of numbers) or a how-to as steps, Celeste draws it in the answer instead of showing code: in both themes, with a text summary for screen readers, and a quiet "Drawing…" while it is still arriving. Steps can be ticked off (kept across restarts), have a Copy button for values and open links only through your browser choice. If a diagram cannot be drawn there is a short note with **Try again**, which asks the assistant to fix it (twice at most), and the source folded away. Nothing in a drawing can run a script. The phone shows what a picture says in words. The diagram library loads only when a diagram appears and adds about 8 to 9 MB to the installer.

- **A vendor at its limit is said so in the chat, and your waiting messages go on by themselves.** When Claude, Copilot, OpenAI or Gemini runs out of its allowance, the chat says which one and when it comes back ("Claude is at its limit (5-hour session). It comes back in 2 h 30 min, around 4:30 PM."). Messages you queued wait with "Waiting for the limit to lift, around 4:30 PM" and are sent at that time (**Send it now** is still there); a limit that is more than six hours away, or one that does not say, leaves them paused for you. On the computer and on the phone.
- **The assistant can start helpers.** In a chat, the assistant can hand a piece of work to a helper: another assistant session (the same one or another vendor and model) that does the task and gives back its last message. A helper is a real session, listed under its chat in the sidebar (folded behind "N helpers", open while one works), that you can open, watch, answer, stop and carry on with. The chat shows a card for each: working, waiting for you, done, stopped. The assistant can wait for a helper (its answer comes back as the result of its call), or let it work in the background: when background helpers end, the chat is woken once, with all their answers. A helper is never looser than its chat's approval mode, cannot start helpers, and has no desktop control or phone tools; in Ask mode a card asks before one starts. Stop in the chat stops its helpers, and deleting the chat deletes them (Undo brings them back). In Develop a helper works in the project folder, or in a separate copy of it. The phone shows the cards and can answer a helper's question. Gemini's chats cannot wait for a helper (its program ends a tool call after a minute), so its helpers always work in the background.
- **A smaller program.** What the drawing board does not use is left out of the build: the library's other languages, its glyph-subsetting program (1.8 MB that was no longer used), and its own second copy of Mermaid. The program's pages and scripts went from 26.9 MB to 19.5 MB. The one thing that went with them is the board's own "Mermaid to Excalidraw" menu entry (Celeste draws Mermaid in the chat itself), which is hidden.
- **Pinch to zoom on the phone.** Two fingers zoom a diagram or drawing around the place between them, one finger moves it, and a double tap zooms in and out (the Zoom buttons are still there).
- **Diagrams, charts, steps and drawings are drawn on the phone** instead of a line saying to open them on the computer. A diagram is drawn by the same library as on the computer, a chart is a real chart with its numbers a tap away, steps can be ticked and copied, and a drawing the assistant makes is drawn as clean shapes and arrows. A tap opens a diagram or drawing large, with Zoom in and out. They follow the phone's light and dark theme, and a picture that cannot be drawn offers Try again. The app grows by about 2 MB; the diagram and chart code loads only when one appears.
- **A + in the phone's message box, and a sketch pad.** One **+** button (as on the computer) opens a small menu: **Attach files**, **Take a photo** or **Draw a sketch**. The sketch pad is a white page to draw on with a finger or a pen, with colours, an eraser and Undo; **Add to message** sends it to the assistant as a picture. The message box's hint while the assistant works is now one short line instead of a clipped two.
- **A drawing board in the chat.** A **+** button in the message box now offers **Attach files** and **Draw**. Draw opens a canvas beside the chat (the open-source Excalidraw, with its hand-drawn look): pen and touch, shapes, arrows and text, undo, Clear, Save as a picture, SVG or Excalidraw file, and **Add to message**, which puts a picture and the drawing's file on your message so an assistant can look at it and answer. Each chat keeps its own drawing while Celeste is open. An assistant can answer with a drawing too: you ask for a sketch, it writes the shapes and which are joined, and Celeste places them and draws the arrows, so it is shown in the answer with **Expand** and **Edit** (which opens it in the canvas for you to change and send back). Nothing in a drawing can run or open a link, it works with no network, and its fonts are in the program. The installer grows by about 8 MB.
- **Assistants now draw a diagram, chart or steps by themselves when one helps**, without being asked, and keep to plain text for short or factual answers. Claude and Copilot are told in their own instructions; OpenAI and Gemini at the start of a new conversation. A workflow's own assistant steps are not told.

### Fixed

- **A long tool call of Celeste's ended after five minutes in a Claude chat**, whatever the ten-minute limit Celeste gave it (Claude Code also ends a call that sends nothing for five minutes). It now ends at ten.
- **A card nobody answered stops asking when you press Stop.** Its buttons used to stay on screen and do nothing.
- **Typing a new message while the assistant waits for your answer lets go of the question.** The message used to wait in the queue behind a question that was never going to finish, and the question stayed on screen (also after Stop). Now the turn is stopped, the question reads "You skipped" and your message goes at once. The same goes for an approval card.
- **A message sent while the assistant worked, after you had skipped its question, no longer stopped the work.** A skipped question stayed on a list of things Celeste waits for, so every later message was sent as "stop and send".
- **A command Claude starts in the background no longer loses its answer.** When a command ended after the turn, Claude Code carried on by itself and said something about the result, but Celeste threw that away, so the chat looked finished and silent. Now a one-line card follows the command ("Running in the background: …", then how it ended), and what Claude says when it ends is shown, as a turn of its own. Each card has a **Stop** for that one command (the chat's own Stop leaves it running), the tray's tooltip and the question before quitting count such commands, a notification says when one ends while the window is hidden, and the phone can stop one too. **Show output** on the card shows the end of what the command has written, also while it runs, and the phone has the same Show output and Stop.

### Changed

- The README says what Windows's **Smart App Control** does with an unsigned installer (it blocks it, with no way past, unlike SmartScreen), and how to connect OpenAI and Gemini.

## [1.3.0] - 2026-11-14

### Added

- **OpenAI is a vendor.** Celeste runs OpenAI's Codex program (`codex app-server`, downloaded from npm the first time you connect, pinned to 0.169.0 and checked against its published checksum) with a settings folder of its own, so it never touches the `codex` you use in a terminal. Two ways in, both billed by OpenAI:
  - **Continue with ChatGPT** uses your own plan, through OpenAI's route for open-source local apps: the sign-in happens in your browser, Celeste registers itself with OpenAI the first time (no secret and no partner key in the repository), checks OpenAI's answer (signature, issuer, audience, nonce, and that plan use was allowed), renews the sign-in before it ends, and asks OpenAI to cancel it when you disconnect. The sign-in is kept in the system's secret store and Codex is only handed the access token, as an environment variable. It needs a paid ChatGPT plan: OpenAI does not let the Free plan be used by other apps.
  - **An OpenAI API key**, checked with OpenAI as soon as you paste it.
  - Streaming, tools, approvals, questions, file changes with diffs, images, stopping, resuming after a restart, your tools (MCP) and the device tools all work. The four approval modes become Codex's own policies; plan mode is a read-only sandbox. Not yet tried against a real ChatGPT account.
- **Gemini is a vendor.** Celeste runs Google's Gemini CLI in its Agent Client Protocol mode (`gemini --acp`, downloaded from npm the first time you connect, pinned to 0.68.0 and checked against its checksum, run with Electron's own Node) with a settings folder of its own: no usage statistics sent to Google, no updating itself, few retries. You connect with an API key from Google AI Studio, which has a free tier: "Get a free key" opens the page and the field for the key together, and the menu keeps "I already have a key". The same features as the others; Gemini's own approval modes (Default, Auto Edit, YOLO, Plan) are the four modes. Not yet tried with a real key. Google ended the free "sign in with Google" of the Gemini CLI for personal accounts on 18 June 2026, and its replacement, Antigravity, is a separate program whose terms for other apps are not settled, so there is no Google sign-in.
- **The Connect button is a split button.** The main part does the usual thing for that vendor ("Continue with ChatGPT", "Get a free key", "Connect") and the chevron, which turns when it opens, offers the other way in (a pasted key).
- `npm run dev:clean` starts the app from source with a brand-new profile (the setup wizard opens as on a first run) that ignores the sign-ins on this computer.
- `npm run verify:openai`, `verify:openai-app`, `verify:gemini` and `verify:gemini-app` run each vendor against its real program and a stand-in for its API (the programs are downloaded once into `scripts/.output`; no account, no cost).

### Changed

- Menus open above dialogs (one opened from Settings used to open behind it).

## [1.2.0] - 2026-11-14

### Added

- **Phone app: see the files and pictures the assistant made.** The files an answer produced in a Chat now appear as cards under it on the phone (name, size, new or changed). A picture opens full screen, fetched from the computer in 1 MB parts with a progress bar (a 15 MB photo took about 30 seconds on mobile data), and zooms with a pinch, a drag and a double tap. Other kinds of file show as "on the computer" for now; opening them and saving a copy are not built yet. Only files inside that chat's own folder can be fetched, up to 100 MB.
- **Pin chats to the top, on the computer and the phone.** "Pin" and "Unpin" are in a chat's menu in the sidebar, and a long press on a chat in the phone's list opens a menu with Pin, Rename and Delete. Pinned chats sit under a Pinned heading, the newest pin first, and the order does not shuffle when you pin one again. Needs a database change (migration 5), made automatically.
- **Phone app: take a photo straight into a message.** A camera button beside the paperclip opens the camera and attaches the photo like any picked file.
- **Phone app: paste pictures and files into a message, as in a messaging app.** Open the keyboard's clipboard (Gboard and others) and tap any copied picture or file, not only the latest, or use the keyboard's Paste: it joins the message like the paperclip does (the same limits). Pasting text works as before.
- **Live video of the computer's screen on the phone.** While the assistant uses the computer, a phone you allowed (Settings, Phone, "Show my screen on it", off by default) can **Watch** the computer's screen as smooth video. It works away from home through the direct link, stops with Stop, and goes black while an app on the never list is on the screen.
- **The phone app away from home: a direct link, and a backup.** Away from home the phone now opens a direct WebRTC connection to the computer (the relay only helps the two find each other) and uses it for calls, notifications and files, which go in 1 MB parts instead of 192 KB; if it closes, the relay carries on and the app catches up. The relay hands out Cloudflare's STUN and, once the project adds a key, TURN. If the relay itself cannot be reached, the phone and the computer open the same link through public MQTT brokers, with every message sealed with the pairing key (no wake-ups this way, so only while the app is open). `node-datachannel` is the computer's end.
- **Prompt queue and "Send now", on the computer and the phone.** While the assistant works you can keep typing: Enter (or "Add to queue") puts the message in a list above the box, and it is sent when the answer ends. Ctrl/Cmd + Enter, or "Send now", stops the answer and sends that message straight away. Each waiting message can be edited (Up arrow in an empty box edits the newest), removed or sent now. Stop holds the queue (and so does a failed answer or a restart); nothing waiting is sent by itself until you choose "Send" or "Clear". A waiting message keeps the model it was typed with. Steer (adding to the running answer), reordering by dragging and an "Enter should…" setting are not built yet (`docs/QUEUE_AND_USAGE_PLAN.md`).
- **Phone app: attach to a session, as on the computer.** A paperclip beside the message box sends files from the phone (up to 10, 25 MB each; images show a thumbnail) with the message, in a new chat or an existing one, and a message may be only files. In a Develop session a "Project files" button lists the project folder by folder, and the files and folders you tick (up to 20) go with the message as names only; the computer still checks that each stays inside the project. Files travel in parts over the same sealed link, are saved on the computer as attachments only when they finish, and are let go if the message is never sent. The phone can name only files it sent itself.
- **Phone app: how long, on the "take control" card.** The slider and the "Until I stop it" tick box from the computer's card are on the phone's card too, and the answer carries the minutes.
- **Phone app: thinking and tool calls fold, as on the computer.** A conversation on the phone uses the computer's own folding rules (Chat folds all thinking and tool calls into one line such as "Read 3 files · 2 s" or "Thought for 4 s"; Develop folds only reading, searching and finished thinking), closed until tapped. Develop's edits and commands stay as cards, opening by themselves when they change files or are running, and a thought still being written shows its last lines.
- **Phone app: which chats are working.** A working chat has an accent dot with a halo beside it and "Working…" in the accent colour, a chat waiting for you a still dot, and the Chats tab gets a pulsing dot while something works and you are on another tab.
- **The phone app away from home: the relay (first part).** A small relay in `relay/` (a Cloudflare Worker, deployed to the project's account) lets the phone reach the computer when they are not on the same Wi-Fi. The computer and the phone each connect outward to it, and it passes sealed messages it can't read. The phone tries the Wi-Fi first and goes back to it by itself. Pairing still happens only on the Wi-Fi. `CELESTE_RELAY_URL` points Celeste at another relay, or (empty) switches it off. Not tried on a real phone yet. 
- **Waking a phone with the app closed (not yet tried with real Firebase).** When Celeste needs your answer (an approval or a question), or the assistant wants the phone to do something, your computer asks the relay to send one message through Firebase Cloud Messaging; the phone wakes, opens it and shows the notification, even away from home. The message holds one sealed block, so Google and the relay see only that something was sent. The app's background parts now reach the computer through the relay when the Wi-Fi does not. Abilities can start a closed app. Needs the project's Firebase key on the relay (`relay/README.md`). Large files away from home come next (`docs/PHONE_PLAN.md`, 7.1).

### Added
- **A browser inside Celeste.** The Browser button (or Ctrl+Shift+B) opens a real browser beside the chat, in Chat and in Develop.
  - **A real page**, not a picture: it is Chromium, so sites, sign-ins, video and typing work as in any browser. It has tabs, an address bar (a search if it is not an address), Back, Forward and Reload, a right-click menu, and Developer tools.
  - **A browser for each chat.** Each chat has its own tabs, and they close with it. The panel can be dragged wider.
  - **It asks first**: a page that wants your location, camera, microphone or notifications asks in the panel, and a download asks where to save.
  - **Starts signed out**, like Claude's browser. "Keep cookies" in the ⋮ menu keeps sign-ins after you quit, and "Clear browsing data" removes them.
  - **Links in a chat** open in the browser or in yours, as you choose (it asks the first time; Ctrl+click always uses yours). A page on your own computer, such as a dev server, always opens in Celeste.
  - **The assistant can use it.** Claude and Copilot can open pages, read them, click, type, fill in forms, take pictures, read the console and the network, and open and close tabs, in their own chat's tabs only. The browser comes up beside the chat the first time. It works with the panel closed. 21 tools.
  - **Other programs can use it too** (Playwright, or Playwright MCP with `--cdp-endpoint`), only when switched on, and they see only the browser's tabs, never Celeste's windows. Switch it on in Settings, Browser, which shows the address to give them.
  - **It asks about a new site only in a chat set to Ask**, as Claude's own browser does in its manual mode. In Auto and Edits it goes where you send it. In Ask, a card appears the first time it opens, clicks or types on a site that is not on your own computer: Allow for this chat, Always allow that site, or Deny, and a no is final for that chat. Settings, Browser lists the sites you always allow once there are any, each with a way to take it back.
  - **Settings, Browser** is short: let the assistant use the browser, keep cookies, the sites always allowed, and other programs. Where links open and clearing browsing data are in the pane's menu.
  - **Care with your files.** The assistant opens a file in the browser freely from its own chat's folder and your attachments. Elsewhere on the computer it asks first only in a chat set to Ask (the other modes have the run of your files anyway); a yes holds for that file in that chat, a no is final. A page cannot open a file, and a sign-in popup cannot go to one.
  - Checked with the real Playwright MCP against the browser's address, and with sign-in popups that talk back to their page.
  - `npm run verify:browser` and `npm run verify:browser-tools` check it. Playwright (about 14 MB) and the `ws` library now ship with the app.
- **Files open inside Celeste.** Open on a file under an answer, a file in Develop's Files panel, or "Open a file…" in the browser's menu shows it in a tab of the browser pane.
  - **Documents:** Word (`.docx`), Excel (`.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv`: a sheet at a time, with column letters and row numbers), PowerPoint (`.pptx`: all slides, or one at a time), OpenDocument text and presentations, and RTF (a simplified view). Old `.doc` and `.ppt` say so and offer your own program.
  - **Everything else useful:** PDF, images, video, audio and web pages (Chromium shows them itself), Markdown (with a contents list), notebooks, JSON (as a tree), source and text files (line numbers, wrapping, find), and zip archives (what is inside).
  - **Safe by design:** a file is shown by a page that has no connection to Celeste and cannot reach the web or any other file. The assistant's browser tools never see a file tab, and "Open in your own program" still opens only documents.
  - `npm run verify:preview` opens a real file of every kind and checks what shows. Details: docs/FILE_VIEWER_PLAN.md.
- **Chat can open the files you attach.** Asked to open an attached PDF or deck, the assistant used to say the browser only opens files in the chat's folder. Now:
  - **A new tool, `browser_open_file`**, shows any file to you in the pane (documents in the viewer, PDFs and images as they are), by an absolute path or one relative to the chat. A file outside the chat's folder asks first in a chat set to Ask.
  - **Click a file in a message to open it.** The chips of sent messages open in the pane, under the name you attached (in Hebrew or any other language too).
  - **Attachments keep their kind of file** on disk (`.pdf`, `.pptx`, `.csv`...), so the assistant and the viewer know what they are; programs and scripts are still stored inert.
  - **A path is an address:** `browser_navigate` and `browser_new_tab` take `C:\Users\Dana\a.pdf` as well as `file:///...`.
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
    - The chat on the computer shows a card while it works: why, what it did, when you paused it, and how it ended.
  - **Workflows from the phone**: start one, answer what it asks to start, and approve the list of everything it will do.
  - **Share to Celeste**: share text or a link from any app, and a new chat opens with it written in.
  - **Keys kept safer**: the phone keeps its pairing encrypted with the Android Keystore, and the computer keeps its own key in the system's secure storage.
  - **This phone** says when the computer has a newer Celeste, with a link to get the new app.
  - **Settings → Phone** says when Windows treats your Wi-Fi as Public, which can keep phones out.
  - A released Celeste fetches the matching Android app from its GitHub release the first time phones are switched on, and checks it before handing it out.

### Changed

- **Settings are much smaller.** Eleven sections became nine and about 30 controls became 14, because most were questions with one sensible answer. This follows what Grok Bot, Claude and Copilot do: few settings, and the question asked on a card when it matters.
  - **Gone, always on:** naming new chats automatically, and using the Claude and Copilot programs already on your computer when they pass Celeste's check.
  - **Gone, moved to the browser pane's menu or fixed:** where links from chats open and clearing browsing data (both were already in the pane's menu), and the search engine (Google).
  - **Gone, nothing used them:** the projects folder, and the Export button that did nothing yet. Also gone: Run the setup again, the sidebar switch (Ctrl B and the sidebar button remain), and the shortcut list.
  - **General** now holds your name, the theme, the default model and the default approval (Appearance and Agent defaults are folded into it).
  - **The assistant no longer asks before using a site** unless the chat is set to Ask. You sent it there; Claude's browser works the same way. "Ask before it uses a new site" is gone.
  - **Desktop control: how long is asked on the card.** A slider on the card, 20 minutes to start, up to 2 hours, replaces the setting, and a tick box on the card keeps **Until I stop it** (it still ends after 5 minutes with nothing done, and after 12 hours at most). +15 min on the bar still adds time and never shortens a grant. "Let it ask for the whole screen" is gone: the card for the whole screen already warns and offers No. The long text in Settings is two lines and a "More" fold, and the list of recent times appears only when there are some.
- **A dot shows which sessions are working.** A small dot beside a session in the list breathes while an assistant is writing in it (with Working… instead of the time), and a dot on the Chat or Develop tab says something is going on in the one you are not looking at.
- **The list holds still.** Sessions are ordered by your last message and by when an answer ended, not by every word being written. Before, two sessions answering at once kept trading places.
- **Long conversations are fast.** A reply that streamed in about 2 seconds took almost two minutes to draw in a conversation of 150 turns, because every few characters redrew everything in it. Now it draws as fast as in an empty chat, the window does not freeze, and a long conversation opens in a fraction of a second (the newest messages first, older ones as you scroll up). Under the hood: tokens are logged in runs, not one by one; only what changed is drawn again; a long reply is drawn in pieces; the browser skips what is far off screen.
- **Chat keeps the working out out of the way.** Thinking and tool calls are folded into one line (Thought for 4 s, Read 3 files · 2 s) that you can open, also while they are still going. Develop shows thinking while it streams, but only the last few lines, and folds runs of reading and searching.

### Fixed

- **Phone app: a long chat made the connection drop and reconnect every few seconds on mobile data.** Opening a chat sent its whole log in one message, and one tool had printed 18 MB; the relay refuses any message over 6 MB and closed the computer's line, so the phone showed "Can't reach" and tried again, forever. On Wi-Fi nothing limits it, so it only showed away from home. The phone now gets the last 8,000 characters of each tool's output (all it ever shows); the full log stays on the computer.
- **Phone app: file changes opened as stacked, overlapping layers.** A style for the new long-press menu was also applied to the unchanged lines of a diff. The menu has its own style name now.

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
