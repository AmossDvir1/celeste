# Celeste: Phone Plan (Android)

> **Status, 9 November 2026: step A1 (the app as a remote) is built, on the `phone` branch, not merged.** See "What A1 built" below. The owner wants two-way control between Celeste and a phone on the same Wi-Fi: the person drives the assistant from the phone, and the assistant does things on the phone with the person's approval. Second version of this plan: the owner chose **an app, not a web page**, and **Android only** for now. Android's wireless debugging (what Celeste has today, `IMPLEMENTATION_PLAN.md` section 7.11) works, but it needs Developer options and isn't simple, so it stays only as an advanced option. This plan updates section 7.12 of `IMPLEMENTATION_PLAN.md` and borrows the safety design of `DESKTOP_CONTROL_PLAN.md`.

### What A1 built

**On the computer:**
- **Phone bridge** (`src/core/phone/`): an HTTP server on the Wi-Fi, only while Settings → Phone is on. It serves the install page and the APK, and announces `_celeste._tcp`.
- **Pairing**: a commitment, then the computer's key and nonce, then the phone's reveal. Both screens show three pictures, and the person presses Allow on the computer.
- **Requests and pushes**: requests are sealed with AES-GCM and refused when replayed; pushes are a sealed Server-Sent Events stream.
- **Limits**: a short list of methods (`PHONE_METHODS`), and a message from the phone is text only.
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
- **Not in this slice**: location, calendar, photos and files.

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
- **Asked again**: before buttons named Send, Pay, Buy, Delete, Install, Allow and the like.
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

**Check on the owner's real phone** (only they can; none of it is tried on a real phone yet):
- touching the screen pauses control, and Continue on the phone lets the held request go on (emulator only so far; the emulator missed the first touch once, right after a fresh install)
- Stop while a request is held
- the second yes before buttons like Send, and the password-field refusal
- the volume-down-three-times stop
- replying to a real message notification
- Wi-Fi discovery, and Chrome's handling of the APK download
- the model picker with Copilot connected (checks never use a real Copilot account)

**Phone control, left over:**
- turning the accessibility service off between grants
- showing control's state in the computer's chat ("paused on the phone", "10 minutes left") beyond the tool rows
- what is on screen in an app that is not on the never list goes to the AI vendor (the consent card says so); decide whether a "hide private fields" option is wanted

**More abilities (A2):**
- location (once, when asked)
- photos and files the person picks
- calendar: read the next events, and add one
- dismissing a notification
- sending an SMS or making a call by opening the app with everything filled in
- a `phone` device kind beside `ssh`, `hyperv` and `adb`, and a **Use the phone** step in workflows

**In the app:**
- send things to the assistant from the share sheet (files, photos, links, text)
- workflows: start a run from the phone (today they are read only)
- keep keys in the Android Keystore (today in the app's private storage)
- open the app straight from the QR code (App Links)
- the app updating itself, and showing when the computer's Celeste is newer than the app
- away from home (A4): see "Before it ships"

### In the main Celeste app and the repository

- **APK in CI and in releases**: CI builds and signs the APK with a key kept as a CI secret (one stable key, or updates won't install over the old app), attaches it to each GitHub Release, and runs the app's tests on an emulator (**Verify** KVM speed on GitHub's Ubuntu runners).
- **Serving the APK**: the computer fetches the released APK and caches it (today it looks for a local build), with GitHub Releases and Obtainium as the other ways in (P-3).
- **The computer's key**: the phone bridge's key is kept in Celeste's settings; move it to the system's secret store (Electron `safeStorage`).
- **Network checks, per desktop**: Windows Public-network profile check and the firewall prompt; macOS Local Network permission **Verify**; Linux firewall note.
- **Workflows engine**: the **Use the phone** step.
- **Devices**: the `phone` device kind.
- **Docs and legal**: README and install guide, the privacy statement (what the phone sends to the computer and what the computer sends to the AI vendor), third-party notices for what the app bundles (Capacitor, `@noble/curves`, lucide, and the rest of `phone/package.json`), and the CHANGELOG at release.
- **Merging**: the `phone` branch is merged only when the owner decides; the owner publishes the release.

### Before it ships

1. **Away from home must use a Cloudflare relay, not Tailscale.** Tailscale asks every person to make a Tailscale account and install it on both devices: fine for people who already use it, but not an experience a public app can rely on. A relay makes the app work away from home with nothing to set up, and it can wake a closed app (section 7). Tailscale stays as the advanced option for people who already have it, and as what the owner uses while the app is experimental. The relay brings work of its own, listed in section 7: someone has to run it (a Cloudflare account of the project's), its free-tier limits are shared by every user (**Verify**, and it may need Cloudflare's paid plan if the app grows), it must carry only encrypted bytes with rate limits against abuse, and the privacy statement has to say it sees who is online and when. Decision P-6 is changed accordingly, and P-8 asks for the owner's go-ahead.
2. **Every item in "Check on the owner's real phone" is checked**, phone control above all.
3. **A security review** of the bridge, the pairing, and the accessibility service (`/security-review`), with the plan's rails (5.1) as the checklist.
4. **A signed APK from CI**, with updates that install over the old app.
5. **The main-app list above is done**: at least the APK in releases, the secret-store key, the network checks and the docs.

## 1. Summary

**One app, "Celeste for Android", installed from the computer in about a minute, with no Developer options and no account.**

- **The phone controls the assistant**: your chats, a message box, live replies, Approve and Deny, Stop, workflows. It's a remote for the Celeste on your computer.
- **The assistant uses the phone**, and each action is approved on the phone by the person holding it:
  - **Phone abilities**: read and answer notifications, open an app or a link, location, photos and files the person picks, calendar, alarms. These are typed tools. They are fast and never need a screenshot.
  - **Phone control**: see the screen, tap, swipe and type, for anything the abilities don't cover. It has the same rails as desktop control.
- **No server on the home Wi-Fi.** The phone and the computer talk directly, encrypted end to end. A server is needed only away from home. To ship, that is a Cloudflare relay run by the project (section 7, P-8); during the experiment, none at all with Tailscale.

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
| A second yes | Buttons named Send, Pay, Buy, Delete, Install, Allow and the like ask again. |
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
- **Verify** whether Chrome warns about or blocks an APK downloaded over plain `http` from a private address. If it does: offer the GitHub Release link (`https`) on the same page, or serve the page over `https` with a certificate the app later pins.
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
| **Cloudflare Workers + Durable Objects** | Free plan: 100,000 requests a day, SQLite-backed Durable Objects, WebSocket **hibernation** (no charge while idle) | **Best fit.** One small Worker in `relay/`, a "Deploy to Cloudflare" button, no card needed **Verify**. Each pairing gets its own Durable Object. WebSocket messages count towards requests **Verify** the ratio |
| Oracle Cloud Always Free | 4 ARM cores and 24 GB RAM, always on | Plenty, but needs a card, a VM to look after, and Oracle may reclaim idle instances |
| Render (free web service) | Free, but sleeps when idle | Poor: a relay that sleeps misses the phone |
| Fly.io, Railway | Trial credit only for new accounts | No |
| Deno Deploy | Serverless | Poor for long-lived sockets |

3. **Push notifications while away**: the relay (choice 2) can wake the app. Firebase Cloud Messaging is free but needs a Firebase project and its secret per sender, which an open-source desktop app can't ship, so it's not planned. UnifiedPush through the ntfy app, using the free public ntfy.sh server, is an option for people who want it.

## 8. How it fits the rest of Celeste

| Area | Change |
|---|---|
| Core | A **phone bridge**: the LAN WebSocket server, mDNS, the install page, pairing (a migration adding a `phones` table with key, name, scopes and last seen), the encrypted channel, and a scoped view of the Core API. Phone tools go on the existing device tool server (`mcp__celeste-devices__phone_*`). |
| Main | The Windows network-profile check and the firewall prompt. |
| Shared | Scopes on every API method, phone tool schemas, and a `phone` device kind beside `ssh`, `hyperv` and `adb`. |
| Renderer | Settings → Phone: the QR, the phones list and the two settings. The "Android phone" tab in Add a device becomes **Developer connection (advanced)**. The phone layouts, if Capacitor (4.3). |
| `android/` | The app: Capacitor shell, Kotlin services, and tests. |
| `relay/` | The Cloudflare Worker, needed before shipping (section 7, P-8). |
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
| `phone_alarm` | Set an alarm or timer |
| `phone_request_control` / `phone_release_control` | Ask for and hand back phone control |
| `phone_screen` | The element list as text, plus a screenshot when asked |
| `phone_tap`, `phone_type`, `phone_swipe`, `phone_key` | Act, while control is granted |

Sending an SMS or making a call opens the messaging or phone app with everything filled in, and the person presses Send.

## 9. Build plan

| Step | What | Size |
|---|---|---|
| **A0** | Clearer wording for today's wireless-debugging tab: "scan from inside **Wireless debugging → Pair device with QR code**, not the camera"; the pairing code as the default; rename it **Developer connection (advanced)**. | S |
| **A1** | **The app as a remote**, after spikes 6.1 and 6.2: scopes on Core methods; the phone bridge; install from the QR; mDNS pairing; Settings → Phone; the app's chats, chat, cards, Stop and workflows; APK in CI and releases; self-update. | L |
| **A2** | **Phone abilities**: the ability tools with approval cards on the phone, notification access with the restricted-settings guide, the `phone` device kind, and the **Use the phone** step. | L |
| **A3** | **Phone control**, after spike 6.3: accessibility service, the rails of 5.1, the action tools and the never list. | L |
| **A4** | **Away from home**: Tailscale steps now, for the experiment; **the Cloudflare relay before shipping** (section 7, P-8). | S–M |

Each step ends with tests, a real-app check, this plan updated with what was and wasn't built, and the CHANGELOG. All of it stays on the `phone` branch until the owner decides to merge.

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
| Prompt injection from the screen or notifications | Approvals on the phone, a second yes for consequential buttons, never-list apps hidden, nothing while locked, notification text treated as data. |
| Someone else on the Wi-Fi | Nothing answers before the handshake; a new phone needs **Allow** on the computer with matching emoji. |
| Battery and data | Element list before screenshots, screenshots only when asked, a cap on actions per grant. |
| The relay (to ship) is a service someone must run | A Cloudflare account of the project's; sealed messages so it sees no content; rate limits per pairing; free-tier limits watched (**Verify**); and the app still works on the home Wi-Fi if the relay is down. |

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
- Microsoft [Phone Link apps](https://support.microsoft.com/en-us/help/4577325)
