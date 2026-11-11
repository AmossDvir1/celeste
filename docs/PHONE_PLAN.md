# Celeste: Phone Plan (Android)

> **Status, 10 November 2026: steps A1 (the app as a remote), A2 (phone abilities and the Use the phone step, without the `phone` device kind) and A3 (phone control) are built and merged into `main`. A4 (away from home) is not; see "Remaining work" for what is left and what must happen before it ships.** The owner wants two-way control between Celeste and a phone on the same Wi-Fi: the person drives the assistant from the phone, and the assistant does things on the phone with the person's approval. Second version of this plan: the owner chose **an app, not a web page**, and **Android only** for now. Android's wireless debugging (what Celeste has today, `IMPLEMENTATION_PLAN.md` section 7.11) works, but it needs Developer options and isn't simple, so it stays only as an advanced option. This plan updates section 7.12 of `IMPLEMENTATION_PLAN.md` and borrows the safety design of `DESKTOP_CONTROL_PLAN.md`.

### What A1 built

**On the computer:**
- **Phone bridge** (`src/core/phone/`): an HTTP server on the Wi-Fi, only while Settings → Phone is on. It serves the install page and the APK, and announces `_celeste._tcp`.
- **Pairing**: a commitment, then the computer's key and nonce, then the phone's reveal. Both screens show three pictures, and the person presses Allow on the computer.
- **Requests and pushes**: requests are sealed with AES-GCM and refused when replayed; pushes are a sealed Server-Sent Events stream.
- **Limits**: a short list of methods (`PHONE_METHODS`). A message from the phone carries text, files the phone sent itself (`phone.upload`, in parts, then named by id), and, in Develop, project files as relative paths that the computer re-checks.
- **Settings → Phone**: the switch, the QR code, the phones with Remove, and the "wants to connect" prompt.

**The app** (`phone/`, Capacitor 8 + React, the reviewed mock's design):
- **Setup**: finds the computer by mDNS, or takes a typed address.
- **Chats**: the greeting, search and a "needs you" banner. A chat follows live with the desktop's own reducer: Markdown, tools, approval and question cards, Stop.
- **New chat**: uses the newest chat's assistant and model.
- **Workflows**: runs, read only.
- **This phone**: notifications, Stay connected, theme, and Disconnect.
- **Stay connected**: a foreground service with its own encrypted line. It shows approvals as notifications whose Approve and Deny reach the computer without opening the app.
- **Older phones**: when the WebView has no X25519, `@noble/curves` stands in.

**Checked:**
- `src/core/phone/*.test.ts` and `src/shared/phone.test.ts`.
- `npm run verify:phone`: 15 checks against the real built app, with the Claude stand-in and Copilot isolated.
- An Android 15 emulator (WebView 124): installed from the APK, paired, chatted, then an approval arrived as a notification with the app closed and Approve ran the command.

### Since then (A1 fixes, Develop, and the first phone abilities)

- **Fixes from the owner's first try on the S24:**
  - The glow stays still.
  - "Thinking" shows under the newest message.
  - Questions take a typed answer.
  - The message box answers a waiting question, or is locked while an approval waits, so nothing queues behind it.
- **Develop from the phone**: in a project already used for Develop on the computer (`phone.projects`), optionally in a separate copy. A phone can never name another folder.
- **Model and effort on the phone**: a chip above the message box opens a sheet with the connected assistants' models (pinned first) and the effort. `phone.models` asks only connected vendors. New chat picks any of them; an open chat changes model within its own assistant (`phone.setModel`, model and effort only). The computer checks every choice against its own list. Checked on the emulator.
- **Phone abilities (A2, first slice)**: `phone_status`, `phone_notifications`, `phone_notification_reply`, `phone_open` and `phone_alarm`.
  - **On the computer** (`src/core/phone/tools.ts`): listed while Settings → Phone is on. A request goes on the phone's stream, and the answer comes back with `phone.reply`, only from that phone. There's no second card on the computer.
  - **On the phone** (`Abilities`, `AbilityActivity`, `AbilityReceiver`, `CelesteNotificationListener`): each ability has a switch in This phone. Every request shows a card with Approve and Deny.
- **Checked on the emulator**: an alarm was set, notifications were read, and Settings was opened, each approved from the card. Replying to a notification is not checked yet (it needs a messaging app's notification).
- **Not in this slice**: location, calendar, photos and files (added in the second slice below).

### More abilities and the Use the phone step (A2, second slice, 9 November 2026)

- **New tools**: `phone_notification_dismiss`, `phone_location`, `phone_photos`, `phone_files`, `phone_calendar`, `phone_calendar_add`, `phone_message` and `phone_call`. Each asks on the phone first, as before.
- **New switches in This phone**: Location, Photos and files, Calendar, and Texts and calls. Dismissing goes with the Notifications switch. Android's own permission is asked when the person first approves a request.
  - **Location**: one fix each time, with how close it is, when it was taken, the address when the phone can tell, and a map link. If no fresh fix comes within 15 seconds, the last known one, saying so.
  - **Photos and files**: Android's own picker, so only what the person picks leaves the phone. Photos come as smaller JPEG copies (1600 px), shown to the assistant and saved; files come as they are, saved only.
  - **Calendar**: the events from a day (today unless asked) for 7 days (31 at most), and adding one after the person approves its title, time and place.
  - **Texts and calls**: the messaging or phone app opens with the number and text filled in. The person presses Send or Call; Celeste never sends or calls by itself. A contact's name is looked up on the phone.
- **Files to the computer**: the phone sends them in 1 MB parts (`phone.attach`), up to 10 files and 40 MB per request, then answers with `phone.reply`. The computer saves them in Celeste's data folder, under `phone/received/<date>/`, and tells the assistant where.
- **Use the phone step** in workflows, like **Use the computer**: a switch on an AI step, or **Use the phone** in the Add list. A run is refused at the start, with the reason, when phones are off, no phone is paired, or the paired phone isn't connected. The step gets the phone tools and a note to use the typed abilities first and phone control only when none will do. The phone's cards name the workflow and the step, and when the step ends, anything it left waiting on the phone is cancelled with the reason.
- **`/phone`** in the chat's slash menu: starts "Use my phone to …" when a phone is connected, or opens Settings → Phone.
- **Checked**: the tool and step tests, and the new switches on the S24. Each new ability's request, card and answer still needs a real-phone check (listed in Remaining work).

### Phone control (A3, first version)

**Tools:** `phone_request_control`, `phone_screen` (numbered elements, and a screenshot when asked), `phone_tap`, `phone_type`, `phone_swipe`, `phone_key` and `phone_release_control`.

**On the phone:** `CelesteAccessibilityService` reads the screen and acts, `PhoneControl` holds the grant and the rails, and `ControlReceiver` handles the buttons on its notifications.

**Rails built:**
- **Turning it on**: an app switch, plus Android's Accessibility switch (the app guides people there, restricted settings included).
- **The grant**: a consent card that shows the reason and the AI-vendor note. It lasts 15 minutes, with 5 idle minutes and 500 actions at most, for one chat.
- **While it runs**: a gradient border and a Stop button over everything, an ongoing notification with Stop, and volume down three times also stops it.
- **Never**:
  - taps on Celeste's own Stop: the pill's place is measured in screen coordinates (the first version measured it in the window's own, so the guard never matched, and a tap on a tab at the top of an app, where the pill sits, pressed Stop twice in the owner's first real task). A tap aimed at the pill's spot now moves the pill to the other end of the screen first, and is refused if the spot is still under it
  - typing into password fields (it says to ask the person)
  - the never list: Celeste itself, Android's installer and permission screens, common password managers and authenticators
  - anything while the phone is locked
- **Asked again** (a switch under Phone control in This phone, **off by default**, the owner's choice on 10 November 2026, so one Allow covers the whole task): before buttons named Send, Pay, Buy, Delete, Install, Allow and the like.
- **Screen text** is labelled as information, not instructions.
- **The person's touch wins**: the Stop pill's window watches for touches outside it (`FLAG_WATCH_OUTSIDE_TOUCH`). A touch from the person pauses control: the border fades and Continue shows beside Stop (and on the notification). A request that arrives while paused is **held on the phone** (up to two minutes), not refused, so the assistant never has to ask in the chat (the first version refused, Claude asked in the chat, and Continue on the phone could not answer it). On Continue, reading the screen goes ahead; an action is answered "not done, look again", because the screen may have changed. Stop, or two minutes, ends the wait. Celeste's own gestures are told apart by time; touches while a card waits, for three seconds after one is answered, or in Celeste itself, don't pause. Each pause writes a line to the log (`CelesteControl`: the app on screen and the time since Celeste's last action), because the owner's first real task paused once with no clear cause (an Approve tap on a card is the suspect; one touch gives the pill's window exactly one outside-touch event, checked on the emulator). Celeste can't press Continue.
- **The person's never list**: This phone → Apps Celeste never uses, a searchable list of the phone's apps. Those apps' notifications are left out, and control refuses their screens. Home, Back and Recents still work there, as the way out.

**Checked on the emulator:**
- consent, then reading the screen with a screenshot, Home, and release, with the border and Stop on screen;
- a person's tap and a swipe paused control; the next request waited (its tool row kept running), and Continue on the phone finished it and Celeste went on, with no question asked;
- Celeste's own tap did not pause it;
- with Gallery on the person's never list, reading its screen was refused.

## Remaining work (9 November 2026)

Two lists, so nothing is lost: what is left in the phone app and its link to the computer, and what is left in the main Celeste app and the repository (also listed in `IMPLEMENTATION_PLAN.md`, section 7.12). Then what must happen before it ships.

### In the phone app (and the bridge it talks to)

**Checked on the owner's real phone** (Galaxy S24, Android 17, 9 November 2026):
- ✅ touching the screen pauses control (pulling down the notification shade too), and Continue on the phone lets the held request go on (held 13 seconds, then answered)
- ✅ Stop while a request is held: the held request is answered "the user pressed Stop"
- ✅ the second yes before buttons like Send, by element number; ✅ the password-field refusal
- ✅ the volume-down-three-times stop
- ✅ Celeste's own app is refused (it is on the fixed never list); Home still works there, as the way out
- ✅ Wi-Fi discovery: the app's own search found "Celeste on Amoss" at its Wi-Fi address
- ✅ Chrome and the APK over plain `http` from the Wi-Fi: it warns the file "can be harmful" and offers **Download anyway**. The install page now says so in its steps.
- ✅ the model picker with Copilot connected: the computer's models are listed, and a change sticks
- Fixed after the check: a tap **by point** on a Send button did not ask again (only taps by element number did); it now reads the words on what is under the point. And the screen read straight after Home was still the closing app; `phone_key` now waits for the app on screen to change.
- Not tried: replying to a real message notification (the owner chose to skip it, as it sends a real message).

**Phone control, left over:**
- turning the accessibility service off between grants: **not possible as planned** (Android has no way for an app to pause its own accessibility service; `disableSelf()` switches it off until the person switches it on again in Android's settings). It already does nothing between grants: it reads nothing and draws nothing until control is allowed.
- ✅ control's state in the computer's chat (10 November 2026): the desktop-control card, marked as the phone's, with the reason, each action, the person's pause and Continue (reported by the phone with `phone.control`), minutes left, and how it ended. Checked on the emulator.
- what is on screen in an app that is not on the never list goes to the AI vendor (the consent card says so); decide whether a "hide private fields" option is wanted
- ✅ a tap on an empty spot reads only the words right there (`labelAt`), not the whole screen's (10 November 2026)
- if control pauses with nobody touching the phone again, read the `CelesteControl` line in the phone's log (it names the app on screen and the time since Celeste's last action)

**Abilities, small fixes (found in review, 10 November 2026):**
- ✅ photos shown to the assistant in one answer are capped at 8 MB together; the rest are saved and named in the answer (10 November 2026)
- ✅ `PhoneTools` remembers only workflow steps (10 November 2026)

**More abilities (A2):**
- ✅ location (once, when asked)
- ✅ photos and files the person picks
- ✅ calendar: read the next events, and add one
- ✅ dismissing a notification
- ✅ sending an SMS or making a call by opening the app with everything filled in
- ✅ a **Use the phone** step in workflows
- a `phone` device kind beside `ssh`, `hyperv` and `adb` (left for later)

**To check on the owner's real phone** (built 9 November 2026, after the restart that loads the new tools):
- location, approved from the card (Android's permission asked the first time)
- photos: pick two, and they show in the chat and in `phone/received/`
- files: pick a PDF, and it arrives whole
- calendar: read the next events; add one, and it shows in the calendar app
- a text and a call: the app opens filled in, and nothing is sent or dialled
- dismissing a notification
- a workflow with a **Use the phone** step: the card names the step, and Stop in the run cancels what waits on the phone

**In the app:**
- ✅ Share → Celeste with text or a link starts a new chat with it written in, with the app open or closed (10 November 2026, checked on the emulator)
- sharing **files and photos** to Celeste: needs an upload of its own (today files reach the computer only as the answer to a request); not built
- ✅ workflows: start one from the phone (its Start questions, checked on the computer), and answer the run's card listing everything it will do, or a tool an AI step wants (10 November 2026, checked on the emulator: a run wrote its file). A step's question is still answered on the computer.
- ✅ the pairing (with the phone's private key) and the background line's key are stored encrypted with a key in the Android Keystore; an older app's pairing moves there at start (10 November 2026, checked on the emulator)
- open the app straight from the QR code (App Links): **blocked** — Android verifies App Links only for an `https` site the app's makers control, and the QR is the computer's own `http` address on the Wi-Fi. Possible later through the relay's domain (P-8).
- ✅ This phone says when the computer's Celeste is newer than the app, with a link to its install page; the new APK installs over the old one (its version code follows the version) (10 November 2026)
- the app installing an update by itself: not built (Android asks the person anyway; the note above covers it)
- away from home (A4): see "Before it ships"

### In the main Celeste app and the repository

- ✅ **APK in CI and in releases** (10 November 2026, written, not yet run on GitHub): CI typechecks and builds the app on every push; a release signs it with the project's key from secrets (RELEASING.md says how to make it) and attaches `Celeste-<version>.apk`. **Blocked on the owner**: the signing key and its four secrets. Not built: the app's tests on an emulator in CI.
- ✅ **Serving the APK**: the first time phones are switched on, the computer fetches its version's APK from the GitHub release, checks it against `SHA256SUMS.txt` and keeps it (10 November 2026; tested with a stand-in release, not yet with a real one).
- ✅ **The computer's key** is in the system's secret store (`phone.key`); one kept in the settings by an older Celeste moves there (10 November 2026).
- ✅ **Windows Public-network check** (10 November 2026): Settings → Phone says so while no phone is connected (checked on this PC, whose Wi-Fi is Public). Not built: macOS Local Network permission (**Verify**), a Linux firewall note.
- ✅ **Workflows engine**: the **Use the phone** step (9 November 2026).
- **Devices**: the `phone` device kind.
- ✅ **Docs and legal** (10 November 2026): README install steps, PRIVACY.md's phone section, the app's packages and Android libraries in THIRD_PARTY_NOTICES.md (`npm run notices`), RELEASING.md's Android signing. The CHANGELOG at release stays.
- ✅ **Merging**: merged into `main` on 10 November 2026. The owner publishes the release.
- **Found while testing** (10 November 2026): a window's call to Core with its arguments not in a list (`core.call('workflows.save', {...})`) is never answered, instead of failing; make Core answer a malformed call with an error.

### Before it ships

1. **Away from home must use a Cloudflare relay, not Tailscale.** Tailscale asks every person to make a Tailscale account and install it on both devices: fine for people who already use it, but not an experience a public app can rely on. A relay makes the app work away from home with nothing to set up, and it can wake a closed app (section 7). **Added 11 November 2026 (owner: notifications and files can't be compromised):** the relay also sends push notifications through Firebase Cloud Messaging, and files travel over a direct WebRTC link with Cloudflare's TURN service behind it (section 7, P-9). Tailscale stays as the advanced option for people who already have it, and as what the owner uses while the app is experimental. The relay brings work of its own, listed in section 7: someone has to run it (a Cloudflare account of the project's), its free-tier limits are shared by every user (**Verify**, and it may need Cloudflare's paid plan if the app grows), it must carry only encrypted bytes with rate limits against abuse, and the privacy statement has to say it sees who is online and when. Decision P-6 is changed accordingly, and P-8 asks for the owner's go-ahead.
2. **Every item in "Checked on the owner's real phone" is checked**, phone control above all (done on 9 November 2026, except replying to a real message notification).
3. **A security review** of the bridge, the pairing, and the accessibility service (`/security-review`), with the plan's rails (5.1) as the checklist.
4. **A signed APK from CI**, with updates that install over the old app.
5. **The main-app list above is done**: at least the APK in releases, the secret-store key, the network checks and the docs.

## 1. Summary

**One app, "Celeste for Android", installed from the computer in about a minute, with no Developer options and no account.**

- **The phone controls the assistant**: your chats, a message box, live replies, Approve and Deny, Stop, workflows. It's a remote for the Celeste on your computer.
- **The assistant uses the phone**, and each action is approved on the phone by the person holding it:
  - **Phone abilities**: read and answer notifications, open an app or a link, location, photos and files the person picks, calendar, alarms. These are typed tools. They are fast and never need a screenshot.
  - **Phone control**: see the screen, tap, swipe and type, for anything the abilities don't cover. It has the same rails as desktop control.
- **No server on the home Wi-Fi.** The phone and the computer talk directly, encrypted end to end. A server is needed only away from home. To ship, that is a Cloudflare relay run by the project, which also sends push notifications, with a direct link for files (section 7, P-8 and P-9); during the experiment, none at all with Tailscale.

## 2. Installing it: the easy way

### 2.1 What the person does

1. On the computer: **Settings → Phone → Connect an Android phone**. Celeste shows a QR code: "Scan with your phone's camera."
2. The camera shows a link. One tap opens a one-button page **served by Celeste itself on the Wi-Fi**: "Install Celeste for Android".
3. Tap **Install**. The first time only, Android asks whether Chrome may install apps: one switch, then Back. Play Protect may ask to scan the app: **Scan** (it's fine) or **Install anyway**.
4. Tap **Open**. The app finds the computer on the Wi-Fi by itself and asks "Connect to DANA-PC?". The computer shows "Pixel 8 wants to connect" with the same three emoji as the phone. **Allow** on the computer.
5. Done: the phone shows your chats. The app asks for each permission only when the person first turns on something that needs it.

That's one scan, about six taps and one switch, with no IP addresses or codes to type. A phone that already has the app skips to step 4: the QR opens the app directly (an Android App Link on the same QR).

### 2.2 Why it works this way

- **The computer hands out the app.** Celeste fetches the APK that matches its own version from the project's GitHub Release the first time someone connects a phone, checks its hash, keeps it, and serves it on the Wi-Fi. The phone and the computer can never have mismatched versions, and the installer stays small. A computer with no internet can use an APK placed next to it by hand.
- **No second scan.** The app can't read the page's link after it is installed, so instead it finds the computer by mDNS (`_celeste._tcp`, already possible with `bonjour-service`). The person approving **on the computer**, with matching emoji, proves they are at the computer and stops another device on the Wi-Fi from slipping in.
- **Updates**: when Celeste on the computer updates, the app shows "Update available" and installs the new APK with one tap, through Android's session installer.
- **For people who prefer it**: the same APK is on GitHub Releases, and listed for Obtainium (it follows GitHub Releases and updates by itself). F-Droid can come later.

### 2.3 What Android adds, and how the app handles it

| Android rule | What the person sees | What we do |
|---|---|---|
| **Install unknown apps** (every version) | One switch for Chrome, the first time | The page shows a picture of that screen before they tap Install |
| **Play Protect** on an app it doesn't know | "Scan app" or "Install anyway" | Same picture guide. Registering the developer (2.4) makes it quieter **Verify** |
| **Restricted settings** (Android 13+; widened in 15). Apps installed from a downloaded file can't switch on **accessibility** (phone control) or **notification access** (reading notifications) until the person allows it | App info → ⋮ → **Allow restricted settings**, with the PIN. The ⋮ item appears only after Android has refused once | Ask for these only when the person turns on phone control or notifications. Show the refusal, then a button that opens App info with a picture of the ⋮ menu. Everything else (the remote, location, photos, calendar, alarms) needs none of this |
| **Android 17 Advanced Protection** removes accessibility from apps that aren't accessibility tools | Phone control is unavailable | The app says why. The remote and the abilities still work |

### 2.4 Developer verification

Google is rolling out developer verification: on certified Android phones, apps must come from a registered developer. It started on 30 September 2026 in Brazil, Indonesia, Singapore and Thailand, and goes worldwide in 2027. Without registration, people would go through Google's "advanced flow", which includes a one-time 24-hour wait. That would be a poor first impression.

| Account | Cost | Reach | For |
|---|---|---|---|
| Limited distribution | Free, no ID | Up to 20 phones, each one authorised by hand | **This experiment** |
| Full Android Developer Console | US$25 once, ID check | Everyone | If the app goes public |

Until verification reaches the owner's country, the APK installs as described in 2.1 with no account at all.

### 2.5 Why not Google Play

- **Play forbids using the accessibility service for an AI agent** that "autonomously initiates, plans, and executes actions", so phone control can't ship there.
- New personal developer accounts must also run a closed test with 12 testers for 14 days before release.

A Play version without phone control ("Celeste Remote") stays possible later (decision P-5).

## 3. Using it

### 3.1 The phone as a remote

- **Chats**: the same list as the sidebar, with a dot on chats that need you.
- **A chat**: live streaming replies and a message box with the phone's keyboard and voice typing. Attach photos and files from the phone. Model and mode work as on the computer.
- **Approvals and questions**: the same cards as on the computer, answered with one tap, also from the notification itself.
- **Stop**: stops the turn. While desktop control is on, a red strip says "Celeste is using DANA-PC" with **Stop**, so the phone is a remote stop for it.
- **Workflows**: run one, answer its questions, follow its progress.
- **Not on the phone**: Settings, vendor sign-ins, devices, access levels, auto-approve, deleting in bulk. A phone is never an admin (5.3).

While the app is open, or while a chat is running, a foreground service keeps the connection open with a quiet "Connected to DANA-PC" notification. Otherwise it reconnects when opened. The person can choose "Stay connected on home Wi-Fi" so approval notifications arrive with the app closed.

A line can die without saying so. Android's WebView freezes the app's page about a minute after it leaves the screen, and a stream that was open across the freeze never delivers again: no error, and the socket stays open, so the computer can't tell either. So every time the app comes back to the screen it quietly opens a new line and reads the open chat again from the computer's log. The computer also pings every 20 seconds, and if the app hears nothing for 45 seconds (the phone slept, Wi-Fi dropped) it does the same. It also reads the chat again when the chat's event numbers skip ahead. So a chat never stays stuck on "Thinking" after an answer from the phone.

### 3.2 The assistant uses the phone

The person says, in a chat on the computer or on the phone, "reply to Mum's WhatsApp that I'm running late" or "turn on the hotspot on my phone".

- **A phone ability** (the reply): the assistant calls `phone_notification_reply`. **The phone** shows a card as a notification: "Celeste wants to reply to **Mum** (WhatsApp): *I'm running late*". **Allow** / **Deny**. The chat shows the action and its result.
- **Phone control** (the hotspot): the assistant calls `phone_request_control` with a reason. The phone asks: "Let Celeste use this phone for 15 minutes? It will see the screen and can tap and type." While it works, the phone shows:
  - a thin coloured border
  - a floating **Stop**
  - a notification with Stop

  Each action is listed in the chat.

**Rule:** things that happen on the phone are approved on the phone; things on the computer are approved on the computer, or on the paired phone acting as a remote. The assistant can never approve itself (5.4).

## 4. The options we looked at

### 4.1 Talking to the assistant

| Option | Verdict |
|---|---|
| **The app talks to Celeste directly on the Wi-Fi** (WebSocket, encrypted end to end, found by mDNS) | **Build.** No server, no account, works offline from the internet |
| A web page served by Celeste | **Dropped as the main remote** (owner's call). It survives only as the one-button install page of 2.1 |
| A relay server | Only away from home: a Cloudflare relay run by the project, to ship (section 7, P-8) |

### 4.2 The assistant using the phone

| Option | Verdict |
|---|---|
| **App with typed phone abilities** | **Build (A2).** Normal Android permission prompts, asked when first used; most everyday requests need only these |
| **App with phone control** (accessibility service: gestures, the element tree, `takeScreenshot` from Android 11) | **Build (A3)**, outside Play (2.5) |
| Wireless debugging (today) | **Keep as "Developer connection (advanced)"**, with clearer wording (A0) |
| Android 16 **AppFunctions** (apps publish typed actions for AI agents) | **Watch.** Calling other apps' functions needs a permission Google gives only to approved agents |
| Windows **Phone Link** app mirroring, driven by desktop control | A free side effect on some Samsung, HONOR and OPPO phones; mentioned in help only |
| The computer pretending to be a Bluetooth keyboard and mouse | Rejected: Windows doesn't allow it |

### 4.3 How to build the app

| Option | For | Against |
|---|---|---|
| **Capacitor** (the desktop's React screens in a WebView, with Kotlin for the services) | Reuses the chat, cards, Markdown and streaming code; one look across both | A WebView feel unless the phone layouts are done with care |
| **Kotlin + Jetpack Compose** | The most native and smooth feel | Every screen written twice, in a second language |

**Recommendation: Capacitor**, with the accessibility service, notification listener, foreground service and installer written in Kotlin either way (decision P-2). The app lives in this repository under `android/`, built by CI (Gradle on Ubuntu) and attached to each release.

## 5. Safety

### 5.1 The rails for phone control

Phone control follows `DESKTOP_CONTROL_PLAN.md` section 3, adapted:

| Rail | On the phone |
|---|---|
| Off until enabled | Off in the app and in Celeste's Settings. Both must be on. |
| Consent is Celeste's own | Asked **on the phone**. Auto-approve on the computer never grants it. |
| Time limit | 15 minutes per grant (the desktop-control duration setting), 5 minutes idle, 500 actions. |
| One chat | A grant belongs to one chat. |
| Always visible | A coloured border, a floating Stop and an ongoing notification with Stop. |
| A stop the assistant can't press | The app draws the Stop and the notification and refuses taps the assistant aims at them. Volume-down three times stops it too (spike). Stop from the computer works too. |
| The person's own touch wins | A touch from the person pauses control until they tap Continue (spike 6.3: the hard part). |
| Never these apps | Defaults: Celeste itself, Android's installer and its security and accessibility settings, recognised password managers and authenticator apps. The person adds their bank. Never-list apps aren't shown to the assistant. |
| Passwords | Typing into a password field is refused ("ask the person to type it"). |
| A second yes | Optional, off by default (the owner's choice, 10 November 2026): with "Ask again before Send, Pay or Delete" on, buttons named Send, Pay, Buy, Delete, Install, Allow and the like ask again. Off, the one grant covers the task, and Stop, the touch pause and the never list are the person's rails. |
| Locked phone | Nothing happens while the phone is locked. |
| Action log | Every action is in the chat; screenshots are not kept. |

### 5.2 The connection

- **Pairing**: each side has a key pair (the app keeps its key in Android's keystore). The first connection is approved on the computer with matching emoji (2.1). After that, both sides prove themselves on every connection with a Noise-style handshake using the stored keys. Settings → Phone lists each phone with when it was last seen, and **Remove** cuts it off at once.
- **Encryption**: end to end inside the WebSocket, with libsodium (ISC licence; the same library in Node and Android), so the Wi-Fi, the router and any relay see only ciphertext.
- **Listening only when wanted**: the server runs only while a phone is paired or being connected, only on private addresses, and it answers nothing before the handshake. The install page is served only for the two minutes a QR is on screen. It serves the APK and nothing else.
- **Public networks**: when Windows marks the network as **Public**, Celeste asks before listening.

### 5.3 What a phone may do on the computer

Every Core method gets a scope: `read`, `chat`, `approve` or `admin` (today they have none; this is part of A1). A phone gets `read`, `chat` and `approve`, never `admin`. Two settings in Settings → Phone:

- **Approvals from the phone**: on by default.
- **Desktop control consent from the phone**: off by default. A phone can always stop it.

### 5.4 The assistant can't approve itself

- Phone control can't tap Celeste's own cards, its Stop, or the notification shade while a Celeste card is in it.
- An approval raised while phone control is running pauses control until the person answers.
- Desktop control already can't touch Celeste's windows on the computer.

### 5.5 What goes to the AI vendor

Phone abilities send only their result (a notification's text, a location, a file the person picked). Phone control sends screenshots and the on-screen element list, and the consent card says so.

## 6. Spikes

### 6.1 Install and connect (start of A1)
- An empty Capacitor app built locally (needs the JDK and Android SDK on this PC **Verify**) and in CI.
- Served by Celeste on the Wi-Fi from the QR.
- **Checked** (Galaxy S24, Chrome, November 2026): Chrome warns that an APK downloaded over plain `http` from a private address "can be harmful", and offers **Download anyway**; it does not block it. The install page says so in its steps. An `https` GitHub Release link on the same page stays an option.
- Installed on the owner's phone, finds the computer by mDNS (**Verify** on the owner's router; fallback: the computer's address is in the QR link, and the app can read it when opened from an App Link), and pairs.
- Windows Firewall's first-run prompt for Electron (**Verify** the wording).
- Exit: a message typed in the app appears in a chat on the computer, and the reply streams back.

### 6.2 Background connection (A1)
The foreground service type for Android 14+ (**Verify** `connectedDevice` versus `dataSync`), battery optimisation on the owner's phone, and how notifications for approvals behave with the app closed.

### 6.3 Phone control (start of A3)
On an emulator and the owner's phone:
- gestures (`dispatchGesture`), the element tree and `takeScreenshot`
- refusing password fields
- the border and floating Stop (accessibility overlay windows), and the volume-key stop
- **detecting the person's own touch**
- whether the app can switch its own service off when a grant ends
- the restricted-settings path on the owner's phone and an Android 15 emulator

Exit: "open Settings and turn on the hotspot", done by the stand-in agent on the emulator and stopped mid-way with the floating Stop.

## 7. Away from home, and the servers that could help

**On the home Wi-Fi no server is needed.** Away from home the phone can't reach the computer directly, so there are three choices, simplest first:

1. **Tailscale** (no code, no server). The free Personal plan covers 6 users with unlimited devices since April 2026 (non-commercial use). Install it on the phone and the computer and the app reaches the computer as if at home. Settings → Phone shows the steps and accepts the computer's Tailscale address. **Good for the experiment and for people who already use Tailscale; not the way to ship** (every person would need their own Tailscale account and an install on both devices).
2. **A relay the project deploys for free.** Both sides connect out to it; it passes encrypted bytes it can't read. **This is the way to ship** (decision P-8): it works with nothing to set up, and it can wake a closed app. What it asks of the project: a Cloudflare account that runs it; free-tier limits shared by all users (**Verify**; the paid plan if the app grows); rate limits against abuse; a transport the computer opens outward (a WebSocket the Worker joins to the phone's), with the same sealed messages on top so the relay never sees content; and a privacy statement that says the relay sees who is online and when. Options:

| Service | Free tier | Fit |
|---|---|---|
| **Cloudflare Workers + Durable Objects** | Free plan: 100,000 requests a day, SQLite-backed Durable Objects, WebSocket **hibernation** (no charge while idle) | **Best fit.** One small Worker in `relay/`, a "Deploy to Cloudflare" button, no card needed **Verify**. Each pairing gets its own Durable Object. Incoming WebSocket messages count towards requests at 20 to 1; outgoing are free |
| Oracle Cloud Always Free | 4 ARM cores and 24 GB RAM, always on | Plenty, but needs a card, a VM to look after, and Oracle may reclaim idle instances |
| Render (free web service) | Free, but sleeps when idle | Poor: a relay that sleeps misses the phone |
| Fly.io, Railway | Trial credit only for new accounts | No |
| Deno Deploy | Serverless | Poor for long-lived sockets |

3. **Push notifications while away**: see 7.1. (Until 11 November 2026 this was "not planned"; the owner then made notifications a must.)

### 7.1 The design to ship (11 November 2026)

The owner's rule: **notifications, files and everything else must work away from home, with no compromise, and at no cost while the project has no money.** That rules out a design with no project server, for one reason: Android closes a background app's connections (Samsung phones strictly), and only Google's push service wakes an app reliably. Sending a push needs a secret key, which open-source desktop code can't carry, so the key has to live on a server the project runs. That server is the relay.

| Need | How it is met | Cost |
|---|---|---|
| Always reachable | The **relay** (Cloudflare Worker + Durable Objects, one object per pairing). The computer and the phone each open a WebSocket outward to it; it passes the same sealed messages as on the Wi-Fi. | Free plan: 100,000 requests a day, 13,000 GB-s a day, nothing charged while hibernating. Incoming WebSocket messages count 20 to 1; outgoing are free. |
| Notifications | When the computer has something for a phone that isn't connected, it tells the relay, and the relay asks **Firebase Cloud Messaging** to wake the app. The push carries no content: the app wakes, connects, and fetches the sealed message. | Free |
| Files and speed | Once both are connected they open a **direct WebRTC data channel** (signalled through the relay), so large files don't pass through the relay. The phone's WebView and Electron both have WebRTC built in. | Free |
| Files when a direct link fails | **Cloudflare's TURN service** carries the data. The relay hands out short-lived TURN credentials. | Free up to 1,000 GB a month (shared with Cloudflare's SFU), then US$0.05 per GB |
| Home Wi-Fi | Unchanged. It still works if the relay, Cloudflare or Google is down. | Free |

Everything stays sealed end to end with the pairing keys, so Cloudflare and Google see who is online and when, never content.

**What it asks of the project:** a Cloudflare account and a Firebase project, both the project's own; the Firebase service-account key and the TURN key kept as Worker secrets; rate limits per pairing; the privacy statement updated (the relay and Google's push service see that a phone was woken and when). If the app outgrows the free plan, Cloudflare's paid plan is about US$5 a month.

**To verify before building:**
- whether Cloudflare's free plan needs a payment card on file
- signing Firebase's HTTP v1 requests from a Worker (a service-account token made with WebCrypto)
- that a sideloaded APK receives pushes (it needs Google Play services on the phone, and the app's `google-services.json`, which holds no secret, in the repository)
- how often a direct link succeeds on the owner's mobile network (general figures are roughly 80 to 95%, lower on mobile carriers; TURN covers the rest)
- WebRTC on the computer: a hidden Electron window, or `node-datachannel` in Core

**Built so far (11 November 2026): step A4a, the relay.** **Deployed the same day** to the owner's Cloudflare account on the free plan (no card asked): `https://celeste-relay.celesteapp.workers.dev`, which is now `DEFAULT_RELAY_URL`. The same scenarios as the local run passed against the live Worker (`CELESTE_RELAY_TEST_URL=wss://celeste-relay.celesteapp.workers.dev`). A brand-new workers.dev name took about a minute to get its certificate. Tests and app checks switch the relay off (`relayUrl: () => ''`, `CELESTE_RELAY_URL=''` in `scripts/lib/app.mjs`) so they never touch the live one.

- ✅ `relay/`: the Worker and its rules. One room per computer (not per pairing: one line from the computer serves all its phones). The room's name and the secret that proves the computer owns it are made from the computer's private key, so nothing new is stored. WebSocket hibernation, with pings answered without waking the room.
- ✅ The computer (`src/core/phone/relay.ts`, and the bridge): one WebSocket outward while phones are on and one is paired; it reconnects by itself. Requests and listening through the relay go through the same checks as on the Wi-Fi. Pairing and the app download are never answered through the relay.
- ✅ The app (`src/shared/phone-client.ts`): the phone learns the relay from the computer on the Wi-Fi (`phone.hello`) and keeps it with its pairing. Each connection asks the Wi-Fi first (1.5 seconds), then goes through the relay, and moves back to the Wi-Fi by itself. This phone shows "Away from home, through the relay".
- ✅ Limits: 8 phones in a room, 6 MB a message, a burst of 240 messages from a phone and then 8 a second.
- ✅ Tested: 12 tests through a stand-in relay (`src/core/phone/relay.test.ts`), and the same scenarios through the real Worker running locally (`npm run verify:relay`). That run found two faults the stand-in could not, both fixed: the Worker's message count did not survive between messages, and a phone leaving the relay waited for the socket to finish closing.
- **Not done:** trying it on a real phone on mobile data; the relay's typecheck in CI.

**Step A4b, waking a closed app (11 November 2026): built, not yet tried with real Firebase.**

- ✅ The design is not "a wake-up, then connect" but **a wake that carries the notice itself**: one Firebase data message with one sealed box (`PhoneWake`, `src/shared/phone.ts`), opened by the phone with its pairing key. The phone needs no connection to the relay to show a notification, and Google sees only a token and bytes.
- ✅ The relay (`relay/src/fcm.ts`, `worker.ts`): the computer's `!wake` frame becomes an FCM HTTP v1 send, authorised by a service-account JWT signed with WebCrypto (RS256); the access token is kept until it expires and renewed once on a 401. Limits in `rules.ts`. The key is the Worker secret `FIREBASE_SERVICE_ACCOUNT`.
- ✅ The relay's `POST /v1/<room>/rpc`: the app's background service has no WebSocket, so its answers (`phone.ack`, `phone.reply`, `phone.attach`) go as HTTP requests that the relay hands to the computer's line and answers with the reply.
- ✅ The computer (`bridge.ts`): the phone sends its token with `phone.push` (kept in the phone's record); an approval or a question (`approval.requested`, `ask_user.requested`), a request for the phone (`ask`) and a Stop (`cancel`) each wake every paired phone that has a token, even one that is listening (its app may be asleep). A token Google calls UNREGISTERED is forgotten. `reachable()` (listening, or wakeable) replaces `listening()` where a phone is picked for an ability and where a workflow checks the phone, so an ability can start a closed app.
- ✅ The app (`FcmService`, `Push`, `PhoneLine`): Firebase Cloud Messaging in the build (`firebase-messaging`, BoM 35.1.0; the Google Services plugin was already wired and applies when `google-services.json` is there). `FcmService` opens the box and shows the notification, hands a request to the same code the app's stream uses (which shows each request once), or clears the cards on a Stop. `PhoneLine` tries the Wi-Fi for 2.5 seconds and then the relay. The token is sent to the computer when the app connects and when Firebase renews it.
- ✅ Tested: five tests through the stand-in relay with a stand-in Google (`src/core/testing/google.ts`, which checks the JWT signature and the access token the way Google does), and the same five through the **real Worker** (`npm run verify:relay`, which gives the Worker a key and the stand-in Google's address).
- **Not done:** the service-account key given to the relay (the owner: `relay/README.md`); a real wake on the owner's phone; a notification when a turn finishes (not sent: it would buzz the phone for every turn while the person works at the computer); clearing a notification when the approval is answered somewhere else (no such event exists in Core yet); the app on a phone without Google Play services (no wake-ups, everything else works).
- **Known limit:** Android does not deliver Firebase messages to an app the person force-stopped, until they open it again.

### 7.2 Looked at and not chosen as the main path

These need no project server, and none can deliver reliable notifications. The first can stay as a backup for people who refuse any project server.

| Option | How it works | Why not the main path |
|---|---|---|
| WebRTC with public signalling (Trystero's way: Nostr relays, MQTT brokers, BitTorrent trackers) | The two exchange sealed "here is my address" messages over free public networks, then talk directly | No push; nobody answers for those networks' uptime or limits; a direct link fails on some mobile networks |
| iroh (dial a device by its key, direct link with relay fallback) | Node bindings for Windows, Mac (arm64) and Linux; Android binaries | Its public relays are free "for development and testing" only and throttled, so shipping means hosting a relay anyway; the phone needs a native plugin |
| Hyperswarm / HyperDHT | A public peer-to-peer table, no company servers | A second runtime on Android; no real fallback |
| Direct address (UPnP port mapping, IPv6) | The phone connects straight to the computer | Works only on some routers and providers, and opens a port to the internet |
| Tor onion service | The computer publishes a hidden address | Slow, about 20 MB on each side |
| UnifiedPush through ntfy.sh | Push without Google | The person must install a second app; fine as an option for phones without Google Play services |

## 8. How it fits the rest of Celeste

| Area | Change |
|---|---|
| Core | A **phone bridge**: the LAN WebSocket server, mDNS, the install page, pairing (a migration adding a `phones` table with key, name, scopes and last seen), the encrypted channel, and a scoped view of the Core API. Phone tools go on the existing device tool server (`mcp__celeste-devices__phone_*`). |
| Main | The Windows network-profile check and the firewall prompt. |
| Shared | Scopes on every API method, phone tool schemas, and a `phone` device kind beside `ssh`, `hyperv` and `adb`. |
| Renderer | Settings → Phone: the QR, the phones list and the two settings. The "Android phone" tab in Add a device becomes **Developer connection (advanced)**. The phone layouts, if Capacitor (4.3). |
| `android/` | The app: Capacitor shell, Kotlin services, and tests. |
| `relay/` | The Cloudflare Worker, needed before shipping (section 7.1, P-8 and P-9): passes sealed messages, sends the wake-up push, signals the direct link and hands out TURN credentials. |
| Workflows | A **Use the phone** step, like **Use the computer**. |
| CI | Builds and signs the APK (the signing key is a CI secret; no fee). Attaches it to releases. Runs the app's tests on an emulator. |

**The assistant's phone tools.** Each one is refused with a reason when the app isn't connected, the ability is off, or the person said no.

| Tool | Does |
|---|---|
| `phone_status` | Which phone, connected or not, which abilities are on |
| `phone_notifications` | Recent notifications, leaving out never-list apps |
| `phone_notification_reply` / `phone_notification_dismiss` | Reply where the app offers it, or dismiss |
| `phone_open` | Open an app by name, or a link |
| `phone_location` | Where the phone is, once |
| `phone_photos` / `phone_files` | The person picks; nothing is browsed without them |
| `phone_calendar` / `phone_calendar_add` | Read the next events; add one |
| `phone_message` / `phone_call` | Open the messaging or phone app filled in; the person presses Send or Call |
| `phone_alarm` | Set an alarm or timer |
| `phone_request_control` / `phone_release_control` | Ask for and hand back phone control |
| `phone_screen` | The element list as text, plus a screenshot when asked |
| `phone_tap`, `phone_type`, `phone_swipe`, `phone_key` | Act, while control is granted |

All of these are built (9 November 2026). Sending an SMS or making a call opens the messaging or phone app with everything filled in, and the person presses Send or Call.

## 9. Build plan

| Step | What | Size |
|---|---|---|
| **A0** | Clearer wording for today's wireless-debugging tab: "scan from inside **Wireless debugging → Pair device with QR code**, not the camera"; the pairing code as the default; rename it **Developer connection (advanced)**. | S |
| **A1** | **The app as a remote**, after spikes 6.1 and 6.2: scopes on Core methods; the phone bridge; install from the QR; mDNS pairing; Settings → Phone; the app's chats, chat, cards, Stop and workflows; APK in CI and releases; self-update. | L |
| **A2** | **Phone abilities**: the ability tools with approval cards on the phone, notification access with the restricted-settings guide, the `phone` device kind, and the **Use the phone** step. ✅ Built, except the `phone` device kind (9 November 2026). | L |
| **A3** | **Phone control**, after spike 6.3: accessibility service, the rails of 5.1, the action tools and the never list. | L |
| **A4** | **Away from home**: Tailscale steps now, for the experiment. Before shipping (section 7.1), in this order: **A4a** the relay (the Worker, the computer's outward WebSocket, the app's relay connection, rate limits); **A4b** push notifications (Firebase in the app, the wake-up from the relay); **A4c** the direct WebRTC link for files, with TURN behind it; **A4d**, optional, the public-signalling backup (7.2). ✅ A4a is built and deployed, and A4b is built and awaits the Firebase key and a test on the phone (11 November 2026, see 7.1); A4c and A4d are not built. | L |

Each step ends with tests, a real-app check, this plan updated with what was and wasn't built, and the CHANGELOG. It was kept on the `phone` branch until the owner decided to merge it (done on 10 November 2026).

## 10. Testing

- **Protocol (Vitest)**: pairing; expiry of the install window; a removed phone refused; a tampered message refused; reconnecting; scopes enforced (an `admin` method from a phone fails).
- **A stand-in phone** in `src/core/testing` speaks the phone protocol from Node, so Celeste's side is tested without a device. App checks launch with `copilotKnowsNoOne: true`, against the Anthropic stand-in.
- **The app**: Kotlin unit tests for the rails (password refusal, never list, second yes); instrumented tests on the Android emulator in CI (**Verify** KVM speed on GitHub's Ubuntu runners).
- **By hand**: the owner's Android phone at each step. Wi-Fi, the firewall, restricted settings and phone makers' changes can't be tested on a runner.

## 11. Risks

| Risk | Answer |
|---|---|
| Google tightens the rules again | The remote and the abilities don't need accessibility; phone control is one part that can be turned off. Watch AppFunctions. |
| The restricted-settings step puts people off | Asked only for phone control and notifications, with a picture guide; everything else works without it. |
| Phone makers kill the background connection | Opt-in "Stay connected", the battery-optimisation prompt only then; otherwise the app connects when opened. |
| Prompt injection from the screen or notifications | Approvals on the phone, never-list apps hidden, nothing while locked, notification text treated as data, the touch pause and Stop, and a second yes for consequential buttons for people who switch it on (off by default, so a grant to control the phone trusts the assistant with the task). |
| Someone else on the Wi-Fi | Nothing answers before the handshake; a new phone needs **Allow** on the computer with matching emoji. |
| Battery and data | Element list before screenshots, screenshots only when asked, a cap on actions per grant. |
| The relay (to ship) is a service someone must run | A Cloudflare account of the project's; sealed messages so it sees no content; rate limits per pairing; free-tier limits watched; and the app still works on the home Wi-Fi if the relay is down. |
| Away from home depends on Cloudflare and Google | Both are free at this size. If either is down, away-from-home use or notifications stop until it returns; the home Wi-Fi is unaffected. Nothing they carry can be read. |

## 12. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| P-1 | Build in the order A1 (remote), A2 (abilities), A3 (control)? | Yes |
| P-2 | Capacitor (reuses the React screens) or Kotlin + Compose (most native)? | Capacitor |
| P-3 | Serve the APK from the computer on the Wi-Fi (fetched from the GitHub Release and cached), with GitHub Releases and Obtainium as alternatives? | Yes |
| P-4 | A free limited-distribution developer account for the experiment, and US$25 for a full account if it goes public? | Yes |
| P-5 | A Google Play "Celeste Remote" without phone control, later? | Later, if at all (12 testers for 14 days first) |
| P-6 | Away from home while it is an experiment: Tailscale? | Yes (**changed 9 November 2026**: it was "Tailscale first, then a self-deployed relay"; see P-8 for shipping) |
| P-7 | May a phone grant **desktop** control? | No by default; a phone can always stop it |
| P-8 | To ship: use a Cloudflare relay run by the project, with Tailscale only as an advanced option? | Yes. Before shipping, not before. It needs a Cloudflare account for the project, and the privacy statement has to say what the relay sees (who is online and when, never content) |
| P-9 | To ship: push notifications through Firebase Cloud Messaging sent by the relay, and files over a direct WebRTC link with Cloudflare TURN behind it (7.1)? | Yes (the owner, 11 November 2026: notifications and files can't be compromised). It needs a Firebase project of the project's. The public-signalling backup (7.2) is optional and comes last |

## 13. Sources (read 9 November 2026)

- Google Play, [Permissions and APIs that access sensitive information](https://support.google.com/googleplay/android-developer/answer/16558241) and [Use of the AccessibilityService API](https://support.google.com/googleplay/android-developer/answer/10964491); [12 testers for 14 days](https://support.google.com/googleplay/android-developer/answer/14151465)
- Restricted settings: [Esper on Android 13](https://esper.io/blog/android-13-sideloading-restriction-harder-malware-abuse-accessibility-apis), [Android Authority on Android 15](https://androidauthority.com/android-15-restricted-settings-sideloading-3481098), [Enhanced Confirmation Mode](https://androidauthority.com/android-15-enhanced-confirmation-mode-3436697), [Lawnchair's guide](https://docs.lawnchair.app/troubleshooting/restricted-settings)
- [Android 17 Advanced Protection and accessibility](https://thehackernews.com/2026/03/android-17-blocks-non-accessibility.html)
- Developer verification: [FAQ](https://developer.android.com/developer-verification/guides/faq), [Android Developer Console help](https://support.google.com/android-developer-console/answer/16561738), [Android Authority: how it works](https://www.androidauthority.com/how-android-app-verification-works-3603559), [the 24-hour advanced flow](https://alternativeto.net/news/2026/3/google-details-new-24-hour-process-to-sideload-android-apps-from-unverified-developers)
- [AccessibilityService.takeScreenshot](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService.TakeScreenshotCallback); [AppFunctions](https://developer.android.com/ai/appfunctions)
- Cloudflare Durable Objects [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits)
- [Hosting free tiers side by side, September 2026](https://flaviocopes.com/hosting-free-tiers/)
- [Tailscale free plan change, April 2026](https://thisisanitsupportgroup.beehiiv.com/p/tailscale-s-free-tier-just-doubled-if-you-ve-been-putting-it-off-today-s-the-morning)
- [UnifiedPush distributors](https://unifiedpush.org/users/distributors/), [ntfy on phones](https://docs.ntfy.sh/subscribe/phone)
- Read 11 November 2026: [Cloudflare Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/), [Trystero](https://github.com/dmotz/trystero), [iroh FAQ](https://docs.iroh.computer/about/faq) and [JavaScript bindings](https://docs.iroh.computer/languages/javascript), [node-datachannel](https://npmjs.com/package/node-datachannel), [Tailscale on NAT traversal](https://tailscale.com/blog/nat-traversal-improvements-pt-1)
- Microsoft [Phone Link apps](https://support.microsoft.com/en-us/help/4577325)
