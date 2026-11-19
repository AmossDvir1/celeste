# Celeste: Queued prompts and usage Plan

> **Status (16 November 2026): Part 1 (queue and "Send now") and Steer are built on Core, the computer and the phone, with tests and `verify:queue`. Not built from Part 1: dragging to reorder, and the "Enter should: Queue / Steer / Ask" setting (left out on purpose, see "Built on 16 November"). Part 2 (usage) is built for Claude and Copilot: the readers, the service, the strip and popover, `verify:usage`. **The notice in the chat when a vendor is at its limit and the queue waiting for it were built on 19 November 2026 (see "Built on 19 November" below).** Not built from Part 2: OpenAI and Gemini, and the rows in the model menu. A Claude subscription login is not offered in a release, so Claude has no plan windows to show there (see below).** *Re-checked against the code on 15 November 2026: `SendMode` is still only `queue` or `stop` (`src/shared/queue.ts`), and there is no usage meter; the only usage code is the per-turn `usage.updated` event (`src/shared/agent.ts`). OpenAI and Gemini are connected since 14 November, so the "Not connected yet" row of the table in section 6 is out of date: their limits are to be looked up with the real programs (**Verify**).* ***Readiness (15 November 2026):*** *the vendor hooks the plan relies on exist in the installed versions. Steer: Copilot's `mode: "enqueue" | "immediate"` (`@github/copilot-sdk` `types.d.ts:3260`) and Claude's `priority: 'now' | 'next' | 'later'` on a user message (Agent SDK 0.3.319, `sdk.d.ts:6698`); what `'next'` and `'immediate'` do mid-turn is still untried, so the first build step is a stand-in test that sends during a held turn and records the order. Usage: Claude's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (`sdk.d.ts:3175`) and the `rate_limit_event` message (`sdk.d.ts:5981`); Copilot's `CopilotUserResponse.quota_snapshots` (`rpc.d.ts:7462`, reached through the auth status at `rpc.d.ts:7361`). **Part 2 can start for Claude and Copilot now; OpenAI and Gemini wait for a look at what their programs report** (Codex is a binary and a text search of it found nothing, so that needs the real program with an account). Steer needs no account for Claude (the stand-in) and can start now.* Two features the owner asked for on 11 November 2026, written down so they can be built after the file viewer (`FILE_VIEWER_PLAN.md`). Referenced from `IMPLEMENTATION_PLAN.md` (decisions 19 and 20). The decisions in section 5 are the defaults I picked.

## Built on 19 November 2026: a vendor at its limit (read this first, with the section below)

**What happens.** Every vendor already reported a rate limit as a failed turn with code `rate_limit` (Claude, Copilot, OpenAI and Gemini translators), so that is the signal. When a turn ends that way, Core (`SessionService.noteLimit`) reads that vendor's usage again (`usage.refresh`) and takes **the latest reset of the meters at 95% or more** (`limitReset` in `src/shared/usage.ts`). It then writes a log event **`limit.hit { vendor, resetsAt?, window? }`**, drawn as one line in the chat: "Claude is at its limit (5-hour session). It comes back in 2 h 30 min, around 4:30 PM." (or "It did not say when it comes back"). If messages are waiting and the reset is within **six hours** (`LIMIT_WAIT_MAX_MS`), a second event **`queue.waiting { until }`** holds the queue, and one timer per session sends it by itself at the reset plus three seconds (`LIMIT_GRACE_MS`). Later than six hours (a month's allowance), or not known, the queue stays paused as before and the person decides, and the line says so.
- **The banner over the waiting messages** (the computer's `QueueList` and the phone's, one sentence from `heldText` in `src/shared/queue.ts`): "Waiting for the limit to lift, around 4:30 PM. It goes by itself then." with **Send it now** and Clear. Once the time has passed (Celeste was closed meanwhile) it is the ordinary paused text: **nothing is re-armed after a restart**, so nothing is sent unattended after a crash, as the plan says.
- **Safeguards:** the timer sends only if the queue is still held for that same time and nothing is running (so Send it now, Clear, or a message the person typed meanwhile cannot make it send twice); a limit written once is not written again for ten minutes when a message sent into it fails the same way; the lookup gives up after eight seconds and the line is written without a time; a failure that is not a rate limit does nothing of this.
- **Fixed on the way (found by the real-app check):** a question that was let go of (Stop, or a new message) stayed in the session's list of things the agent waits on, so every later message sent while it worked was taken for "stop and send". The list is now cleared when a turn ends.
- **Checks:** `src/shared/limit.test.ts`, 10 service tests ("a vendor at its limit"), the reducer test, and **`verify:queue`** (now 22 checks): the stand-in API answers a 429 (new `error` block in `fake-anthropic.ts`), the usage file says the 5-hour window resets in 14 s, a message is queued, the line and the banner appear, nothing is sent meanwhile, and after the reset it is sent once and answered. **Not checked:** a real vendor at a real limit (Claude has no usage reading with an API key, so there the line says it did not say when; Copilot's reading comes from its quota snapshot, which is not recorded from a real account); OpenAI and Gemini, whose usage is not read yet.
- **Still not built:** the rows in the model menu ("82% left"), usage for OpenAI and Gemini, dragging to reorder.

## Built on 16 November 2026 (read this first; where it differs from the text below, this is right)

**Steer.** A stand-in test came first (`scripts/spikes/steer-sdk.mjs`, the real Claude Code program through the Agent SDK with an open input like Celeste's and the stand-in API; the same is kept as real tests in `claude.sdk.test.ts`). What the program does with a user message sent while a turn is running, by `priority`:

| `priority` | While a command runs | While the last answer is being written |
|---|---|---|
| `'next'` (and **none: the default is the same**) | Waits for the command to finish, then is read **in the same turn** in front of the model's next request ("The user sent a new message while you were working: …"). One `result`. | The turn ends; the program then carries on by itself with a turn for the message. Two `result`s. |
| `'now'` | **Cuts the running command short** and goes with its answer. Two `result`s. | Same as `'next'`. |
| `'later'` | Waits for the end of the turn, then a turn of its own. | Same. |

So Steer for Claude is `priority: 'next'` (it also means the old "send with no mode while busy" was already steering, with a second `turn.started` that Celeste's own turn bookkeeping did not expect). `'now'` is not used: it kills the command, which is "Stop and send" with extras.

- **Core:** `SendMode` gains `'steer'` (`src/shared/queue.ts`). A steering message is logged at once and handed to `AgentSession.steer()` (new, optional): no queue entry and no stop. It is a plain send when nothing runs, and **a queued message when the assistant has no `steer`, or while a card waits for the person** (so it is not taken for the answer). `canSteer(vendor)` is `claude` and `copilot`.
- **Claude:** `steer()` pushes the message with `priority: 'next'` and begins no turn of Celeste's. Because the program may run the message as a turn of its own after the turn ended, the translator remembers that a steering message was sent and **begins a turn (`steer-…`) when Claude speaks after the turn has ended**. (Same fix as the background commands' follow-up turn.)
- **Copilot:** `steer()` sends with `mode: 'immediate'` and begins no turn of Celeste's, with the same late-turn handling for the SDK's "if the turn ends first it becomes a queued message". **Not tried with the real runtime or an account**: tested against the fake session only. **Verify** with a real Copilot before relying on it.
- **The window and the phone:** a **Steer** button between *Send now* and *Add to queue* (only where `canSteer`), and **Alt+Enter** steers. Enter and Ctrl+Enter are unchanged (queue, and stop and send). The phone has the same button; its Core method accepts `'steer'`.
- **Left out on purpose:** the "Enter should" setting (the owner wants very few settings; Enter queues, as in the plan's default), and dragging to reorder. Both can come when asked for.
- **Checks:** `npm run verify:queue` (13 checks, real app: a waiting message goes after the command, a steered one is read in the same turn and never as a turn of its own, one steered as the answer ends becomes its own turn and the chat is not left working, Alt+Enter, a restart), the three real-program tests, the fake-Copilot tests, the Core tests. **Not checked:** a real Copilot runtime; a real model's behaviour on reading a steered message; the phone's button on a real phone.

**Usage.**
- **Claude has nothing to show in a release.** `usage_EXPERIMENTAL…` returns plan windows only for a claude.ai subscription login; for an API key it says `rate_limits_available: false` (checked with the real program: that and a session cost of 0 for a program just started), and the `rate_limit_event` messages are for subscription users too. Celeste does not offer a subscription login, so the reader (`ClaudeHost.usage()`) is only asked when no key is pasted (development with the person's own login) and answers nothing otherwise. The mapping is tested against the SDK's declared shape, not a real answer. **If a meter is wanted for API-key users, it has to be Celeste's own count of tokens and cost per day or month from the turns it ran (not built, one decision for the owner).**
- **Copilot** is read with the runtime's `account.getQuota` (the SDK's `rpc.account.getQuota({})`; the plan's guess, `getAuthStatus`, does not carry it). It gives premium requests, chat and completions with `usedRequests`, `entitlementRequests`, `remainingPercentage`, `overage` and `resetDate`. Shapes are from the SDK's types; **no real account was available to record one.**
- **Core:** `src/shared/usage.ts` (`VendorUsage`, `UsageWindow`, colours at 80% and 95%, `untilText`), `src/core/usage.ts` (`claudeUsageFrom`, `copilotUsageFrom`, `UsageService`), `usage.get`, `usage.refresh`, and a `usage` push. The service asks only connected vendors, shares one reading between two askers, keeps the last answer (marked `failedAt`) when a reading fails or takes over 30 s, drops it when the vendor now has nothing to show, saves what it learned in the settings so the strip is not empty at start, and after a turn asks that vendor again at most once a minute.
- **Window:** `UsageStrip` above Settings in the sidebar: a row per vendor (name, a thin meter, the percentage; amber from 80%, red from 95%, "Unlimited" without a bar, a dot after the number when the reading is over 15 minutes old or could not be updated), a popover with every window, its amounts, its reset ("Resets in 3 h 12 min" and the date), the plan, the overage note, "Updated 2 min ago" and Refresh. Each bar is a `role="meter"` with a value in words, and a row's name says what it shows. It reads again when the window gains focus and every 5 minutes while visible, and only while a vendor is connected.
- **For the check only:** `CELESTE_USAGE_FILE` makes Core read what each vendor reports from a file instead of asking the vendors. `npm run verify:usage` (17 checks: room, amber, red, unlimited, nothing to show, could not update, old, keyboard, Refresh, focus, restart).
- **Not built:** the rows in the model menu, the notice in the chat at a limit, the queue waiting until the reset (Part 2's last step), OpenAI and Gemini (need their accounts), and showing usage on the phone.

# Part 1: Sending while an agent is working

## 1. What happens today

While an assistant works, the composer's button is **Stop** and Enter does nothing (`Composer.tsx`: `if (busy || sending || !canSend) return`). To say something more, the person must stop the assistant, which throws away the turn, or wait. Every tool people compare us with lets you do better.

## 2. What others do (researched 11 November 2026)

| Tool | While it works, you can |
|---|---|
| **GitHub Copilot** (Copilot CLI, the Copilot SDK, VS Code 1.110+) | Send with `mode: "enqueue"` (held until the turn ends, FIFO, each runs a full turn) or `mode: "immediate"` (**steering**: injected as a user message before the next model request of the same turn; if the turn ends first it becomes a queued message). The SDK's default is enqueue; its guidance is to keep steering for course corrections and short, and to show the queue depth in the UI. VS Code's Send button becomes a menu: **Add to queue**, **Steer**, **Stop and send** ([docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing)). |
| **Claude Code** | A message typed during a run is **queued** and delivered at the next step boundary; Esc interrupts. Its SDK's user message has `priority: 'now' \| 'next' \| 'later'` (`SDKUserMessage`), and the desktop app uses it for Enter versus Ctrl+Enter. Users ask for a visible, editable queue and for steering without waiting for the current action to end. |
| **Codex, Cursor, Replit** | Queue with Tab or a button, interrupt with Esc, and a visible list of what is waiting. |

## 3. Design

**One question, three answers**, with a default the person chooses:

| Option | What it does | Needs from the vendor |
|---|---|---|
| **Queue** (default) | The message waits and is sent, in order, when the turn ends. Each queued message is a chip above the composer that can be **edited**, **removed**, or **sent now**. | Nothing: Celeste's own queue, sent when the session goes idle. |
| **Steer** | The message goes into the running turn at its next step, to change direction without losing the work. If the turn ends first it is queued, and the chip says so. | Copilot: `mode: "immediate"`. Claude: `priority: 'next'`. Others: not offered, or "Stop and send". |
| **Stop and send** | Stops the turn (what is done stays; Develop's checkpoint can undo it), then sends this message at once. | Interrupt, which every vendor has. |

More I recommend:

- **Keys.** Enter does the default; **Ctrl+Enter** does the other of Queue and Steer; the send button, while working, is a split button: Send (the default), with the menu holding the three. **Stop** stays one click away beside it. A setting "While an assistant is working, Enter should: Queue, Steer, Ask" in Settings, Agent defaults.
- **Up arrow** in an empty composer pulls the newest queued message back to edit.
- **Stop pauses the queue.** When the person stops a turn, queued messages do not fire by themselves: the chips stay with "Paused: Send / Clear". (Firing a queue after a Stop would surprise.)
- **A queue survives a restart** (kept in the session's log, like drafts), and is not sent on its own after a crash: the person is asked.
- **Attachments, files from the project and the model choice are kept with each queued message** and used when it is sent, not when it was typed.
- **Approvals and questions.** While the assistant waits for an approval or an answer, a typed message queues (it is not taken for the answer). Steering is not offered then.
- **Rate limits.** When a vendor says it is at its limit (see Part 2), the queue waits and the chip says until when.
- **The phone** gets the same three answers in its composer, through the same Core methods.
- **Workflows** are not affected (a run has no composer).

## 4. How it is built

- **Core:** `session.queue` (id, text, attachments, context, model snapshot, mode asked for) kept as log events (`queue.added`, `queue.removed`, `queue.sent`, `queue.paused`), so a restart restores it and the window and the phone fold the same events. `sessions.send` gains `mode: 'queue' | 'steer' | 'stop'`; Core, not the window, owns the order. When a turn ends (`turn.completed`) and the queue is not paused, the next message is sent.
- **Adapters:** `AgentSession.send(input, { priority })`. Copilot passes `mode`. Claude passes `priority` on the streamed user message; **to verify** with the real program (the semantics of `'now'`, `'next'` and `'later'` are not described in the SDK's types) before relying on `'next'` for steering. A vendor without steering gets Queue and Stop and send only.
- **Window:** the split send button, the chips (edit, remove, send now, drag to reorder), the paused banner, the setting. The sidebar's working dot already says a session is busy.
- **Tests:** fake agent with a slow turn (service tests: order, steering becoming a queued message when the turn ends first, pause on Stop, restore after restart, a crash not firing the queue); the stand-in Anthropic API with a held turn for a window check (`verify:queue`): type while working, see the chip, edit it, the turn ends and it is sent; Stop pauses; Steer.

# Part 2: Usage for each vendor

## 5. What the person wants

For each connected vendor, a small, elegant, always-there answer to "how much do I have left, and when does it reset?", without opening a website or typing `/usage`.

## 6. What each vendor can tell us

| Vendor | Source | What it gives |
|---|---|---|
| **Claude** | The Agent SDK: `query.usage_EXPERIMENTAL_MAY_CHANGE…()` (the data behind `/usage`) and the `rate_limit_event` messages of each turn | For a claude.ai plan (`pro`, `max`, `team`, `enterprise`): rows for the **5-hour session**, the **7-day** window and per-model weekly meters (`percent` used, `resets_at`), extra-usage spend, and the session's cost and tokens. For an **API key** there are no plan windows (`rate_limits_available: false`): only the session's cost and tokens. The call is marked experimental: it is wrapped, and its absence just hides the rows. |
| **GitHub Copilot** | The account's Copilot user record (`copilotUser`, the SDK's `CopilotUserResponse`): `quota_snapshots.premium_interactions` (and `chat`, `completions`), `quota_reset_date_utc`, `limited_user_quotas` for free accounts, `usage_based_billing` | **Premium requests used and left** (`entitlement`, `remaining`, `percent_remaining`, `unlimited`, overage allowed and used) and when it resets. **To verify** which call returns it for a signed-in account (the type is in the SDK's credentials; `getAuthStatus` is the first place to look). |
| **OpenAI, Gemini** | Not connected yet | Their plan limits (ChatGPT plan windows through the Codex program; Gemini's quotas) are looked at when those vendors are built. |

Nothing here sends data anywhere new: each reading is made by that vendor's own SDK or program, with the account already signed in.

## 7. Design

- **Where.** A compact **usage strip** at the foot of the sidebar, above Settings: one slim row per connected vendor, each a small vendor mark and a thin bar showing the vendor's main meter (Claude: the 5-hour window; Copilot: premium requests used this month), with the percentage in a few characters. Calm colour while there is room, amber from 80%, red from 95%. A vendor that cannot say (an API key) shows its session's cost instead of a bar.
- **Details on hover or click** (a popover, not a page): every window the vendor gave, each as a labelled bar with "resets in 3 h 12 min" and the time; the plan; for Claude the per-model weekly meters; for Copilot the overage setting and the reset date; "updated 2 min ago" and a refresh button; for API keys the session's tokens and cost.
- **In the model menu**, a vendor's rows carry a small "82% left" so the choice is informed, and a vendor at its limit says when it is back.
- **When a vendor says it is at its limit** (a `rate_limit_event` with `rejected`, or a Copilot quota of 0 without overage), a notice in the chat says so with the reset time, and queued messages wait (Part 1).
- **Refreshing.** When the window gains focus, after each turn of that vendor, and every five minutes while visible; never when no vendor is connected; the last answer is kept in Core and drawn at once, marked stale after fifteen minutes. A vendor's call that fails shows the last answer and "could not update", not an error.
- **Accessibility.** Each bar is a meter with a text value (`role="meter"`), colour is never the only signal, and the popover works with the keyboard.

## 8. How it is built

- **Core:** `VendorUsage` (vendor, plan, `windows[]` of label, percent, resetsAt, `scope`, plus `spend` and `note`), `usage.get` (all connected vendors) and a `usage` push; adapters implement `usage(): Promise<VendorUsage | null>`; a small scheduler refreshes on the triggers above; the last result is stored in the settings so the strip is not empty at start.
- **Window:** `UsageStrip` and `UsagePopover` in the sidebar, and the rows in the model menu.
- **Tests:** adapter translation tests with recorded SDK shapes (Claude plan and API key, Copilot paid, free and unlimited); service tests for refresh triggers and staleness; a window check (`verify:usage`) that draws the strip from a stand-in adapter in all states (room, warning, limit, stale, API key, unlimited); the accessibility audit.

## 9. Build order

1. **Queue and steer:** Core queue and events, adapter `priority` (and the Claude check against the real program), the window, the phone, `verify:queue`.
2. **Usage:** `VendorUsage` and Claude's reading, Copilot's reading (verify the call first), the strip and popover, the model menu rows, the limit notice, `verify:usage`.
3. **Both:** the rate-limit link (queue waits), docs, changelog, accessibility.

## 10. Decisions (defaults picked; say if any should change)

| # | Decision | Default |
|---|---|---|
| Q1 | What Enter does while an assistant works | Queue |
| Q2 | Steering | Offered where the vendor supports it (Copilot, Claude after it is verified) |
| Q3 | Stop and a queue | Stop pauses the queue; nothing fires by itself |
| Q4 | Queue kept across restarts | Yes, never sent on its own after a crash |
| U1 | Where usage shows | A compact strip at the foot of the sidebar, details in a popover |
| U2 | Vendors without plan limits (API keys) | Show the session's cost and tokens instead of a bar |
| U3 | Refresh | On focus, after each turn, and every five minutes while visible |
| U4 | At a limit | A notice in the chat with the reset time; the queue waits |
