# Celeste: Queued prompts and usage Plan

> **Status: Part 1 (queue and "Send now") is built on Core, the computer and the phone, with tests; not yet tried by eye in the apps. Not built from Part 1: Steer, dragging to reorder, the "Enter should: Queue / Steer / Ask" setting, and the `verify:queue` script. Part 2 (usage) is planned, nothing built.** Two features the owner asked for on 11 November 2026, written down so they can be built after the file viewer (`FILE_VIEWER_PLAN.md`). Referenced from `IMPLEMENTATION_PLAN.md` (decisions 19 and 20). The decisions in section 5 are the defaults I picked.

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
