# Celeste: Scheduled workflows Plan

> **Status: planned, nothing built. Written 15 November 2026 from Ideas.txt item 1 ("Scheduling workflows and make the phone perform scheduled tasks").** The decisions in section 7 are the defaults I picked; change any of them before building. File and line references are to the code as of commit 9a5745f.

## 1. What the person wants

"Run this workflow every morning at 9", "every Friday", "once, tomorrow at 14:00", without opening Celeste and pressing Run. A workflow that has a phone step (set an alarm, send a notification) makes the phone do something on a schedule.

## 2. What happens today, and what that means for scheduling

| Today | Consequence |
|---|---|
| `WorkflowRunner.start` (`runner.ts:177`) checks the workflow, then every run **stops at an approval card** listing everything it will do and waits for a person (`runner.ts:291`). | Nobody is there at 09:00. A schedule needs its own way of having been approved, see section 4. |
| An agent step with tools set to `ask`, an `ask_user` question, a computer step and a phone step each **wait for a person** (`waitFor`, `runner.ts:275`). | A scheduled run can sit in "Waiting for you" for hours. Needs a notification and a limit on waiting. |
| Core lives inside the Electron main process, and **closing the last window quits the app** (`main/index.ts:257`). There is no tray and no start with the computer. | A schedule can only fire while Celeste is running. Without a background mode the feature would silently do nothing. |
| `markAbandoned` (`runner.ts:165`) fails runs that were going when Celeste closed. | Fine as it is; a scheduled run killed by a quit shows as failed like any other. |
| The phone can start runs (`workflows.run` is in the phone's allowed calls, `phone.ts:65`) and gets `run` and `runEvent` pushes. A closed phone is only woken for chat approvals and questions (`bridge.ts:605`), not for a run's card. | Scheduled runs need a "run finished / needs you" wake for the phone. |
| Settings are being kept few (see `celeste-settings-slimming`). | The background behaviour must be automatic, not a page of switches. |

## 3. What others do (general knowledge, not researched today)

- **Windows Task Scheduler / launchd:** run whether or not the app is open, can wake the computer, and have "run as soon as possible after a missed start".
- **Desktop assistants with scheduled tasks:** run only while the computer is awake and the app is open, and give one catch-up run when it comes back. That is the model I recommend for version 1: no new background service, no wake from sleep.
- **n8n, Zapier, GitHub Actions:** structured schedules (every N minutes, daily, weekly) with a cron box for experts; "next 5 runs" preview; overlapping runs skipped or queued.

## 4. Design

### 4.1 A schedule is a saved approval

The approval card exists so nothing runs that the person has not seen. For a schedule, **the person approves once, when they create it**, on the same card (`plan()` output, with the inputs filled in), worded for repetition: "Every Monday at 09:00 Celeste will do this, without asking again."

What the approval is bound to, stored with the schedule: the workflow **version**, a hash of the **inputs** and the **folder**. If any of them changes, the schedule is **paused with "Needs your OK again"** and nothing runs until the person looks at the card again. So editing a workflow can never make an old approval cover new steps. A change to the name, description or canvas positions does not count (the same rule `workflows.save` already uses for versions, `service.ts:89`).

The runner gets one new start option, `preApproved: { scheduleId }`, beside `forceApproval`. With it the approval card is skipped, and an event `approval.preapproved` is recorded so the run log still says who allowed it. Everything else in the run is unchanged, including the checks in `checkReady`.

### 4.2 When it runs

A structured schedule (stored as JSON, so the window can edit it and Core never parses free text):

| Kind | Fields |
|---|---|
| **Once** | date and time |
| **Every** | N minutes or hours (at least 5 minutes) |
| **Daily** | time; optionally weekdays only |
| **Weekly** | days of the week, time |
| **Monthly** | day of the month (31 means the last day in shorter months), time |

Times are in the computer's time zone, which is stored with the schedule so travelling does not silently shift it. A small `nextRun(spec, after)` function does the arithmetic. Daylight saving: a time that does not exist (spring forward) runs at the next valid minute; a time that happens twice (fall back) runs once, the first time. No cron box in version 1 (decision 3).

### 4.3 The scheduler

A `Scheduler` class in `src/core/workflows/scheduler.ts`, built like the runner: the clock and the timer are injected, so tests need no real waiting.

- **A tick every 30 seconds** (not one exact timer). Timers can stall while the computer sleeps; a tick that compares the wall clock with each schedule's stored `nextRunAt` is correct after any sleep and is cheap. Accuracy is within about 30 seconds, which is fine for this. Also run a tick when the app starts and when the computer resumes (main passes Electron's `powerMonitor` `resume` in).
- **On a due schedule:** check that the workflow still exists, that it is still the approved version, and that the schedule is on. Then apply the overlap and missed rules, then `runner.start({ startedBy: 'schedule', preApproved })`. Then compute the next time and save it **before** starting, so a crash cannot fire it twice.
- **Missed** (the computer was off, asleep, or Celeste closed): run **once** if it is late by no more than the schedule's grace period (default 2 hours), otherwise skip and record "Missed". Never one run for each missed slot.
- **Overlap:** if the previous run of the same schedule is still going, skip this one and record "Skipped: the last run was still going".
- **Cannot start** (the phone is not connected, a tool server is off, Desktop control was switched off): record it as a failed run with the sentence `checkReady` gives, so it shows in the history and notifies like any other failure.
- **Waiting for a person** (a run reaches a card): the run shows "Waiting for you", the person is notified (4.5), and after the schedule's wait limit (default 30 minutes) the run is cancelled with "Nobody answered".
- At most 3 scheduled runs at once; further ones wait their turn.

### 4.4 What may be scheduled

- **Tool steps, agent steps, phone steps:** yes. Agent steps use the tools mode they already have. A step whose tools are `ask` is allowed (it may wait, 4.3), but the schedule dialog says so.
- **Computer steps (mouse and keyboard):** **not in version 1.** They need the person at the screen and the screen unlocked, and unattended control of the mouse is the one thing here I would not ship without a separate decision. The dialog says why and offers "Run now" instead.
- **Phone steps keep asking on the phone** each time. For "set my alarm every evening" that is a prompt every evening; letting a schedule pre-grant a few low-risk abilities (alarms, notifications) is a later decision (section 8), not a quiet default.

### 4.5 Telling the person

- **Desktop:** an operating-system notification when a scheduled run **fails** or **needs you** (default). "Also when it finishes" is a choice on the schedule. Clicking it opens the run.
- **Phone:** the same two, through the phone wake path. The wake today only knows `approval` and `ask` (`phone.ts:525`); it gains a `run` kind. **To verify with the real relay and the Android service**, which I have not read.
- **Paused by an edit:** one notification, "Your 9:00 backup was paused because the workflow changed", so a daily job does not stop unnoticed.

### 4.6 Staying alive

Without this the feature is a trap, so it is part of the first version:

- **Close to the tray.** Now planned for every close, not only while a schedule is on: see Part 1 of `TRAY_AND_COMPACT_PLAN.md`, which this builds on (build that first). The tray menu gains "Pause all schedules" here.
- **Start with the computer.** A checkbox in the schedule dialog, off until asked, "Start Celeste when I sign in" (`app.setLoginItemSettings` with a `--background` argument, so the window stays hidden).
- **No wake from sleep and no run while Celeste is closed** in version 1. The dialog says in one line: "Runs while this computer is on and Celeste is running." Running without Celeste, through the operating system's own scheduler, is a later step (section 8).
- Quit from the tray or Quit in the menu still works exactly as today (`before-quit`).

### 4.7 One small addition to templates

A scheduled run often wants the date ("report-{{run.date}}.md"). Today `{{run.folder}}` is the only `run` value (`workflow.ts:331`). Add `{{run.date}}` (local, `2026-11-16`) and `{{run.time}}` (`09:00`), fixed when the run starts. Cheap, and useful for manual runs too.

## 5. How it is built

**Data (a new migration in `migrations.ts`):**
- `workflow_schedules (id, workflow_id → workflows ON DELETE CASCADE, enabled, spec_json, timezone, inputs_json, folder, approved_version, approved_hash, approved_at, grace_sec, wait_limit_sec, notify, next_run_at, last_fire_at, created_at, updated_at)`. Several schedules per workflow are allowed (the same workflow with different inputs).
- `workflow_runs` gains `schedule_id` (null for other runs). `StartedBy` gains `'schedule'`; `RunSummary` gains `scheduleId`.
- A schedule's skipped and missed slots are kept as small events in a `workflow_schedule_log` table (id, schedule_id, at, kind, text), not as runs, so the Runs list holds only real runs.
- Exporting a workflow does **not** carry its schedules (a shared file must never arrive with a standing instruction); `toFile` says so in its notes.

**Core API (`shared/api.ts`, next to `workflows.*`):** `schedules.list(workflowId?)`, `schedules.save` (validates the spec and the workflow, refuses computer steps, stores the approval), `schedules.setEnabled`, `schedules.remove`, `schedules.preview(spec)` (the next five times, for the dialog), `schedules.log(id)`. `WorkflowApi` is a mapped type on `workflows.*` and `runs.*`, so it gains `schedules.*`. Every method checks its arguments like `workflows.*` does.

**Window:**
- `WorkflowsScreen`: a clock chip on a workflow's row ("Daily 09:00", "Paused", "Needs your OK again") and a **Schedule** button beside Run in the editor and the run dialog.
- **Schedule dialog:** When (the picker for 4.2, with "Next: Mon 16 Nov 09:00, Tue 17 Nov 09:00, …" live), Inputs (the form `RunDialog` already has), Folder, then the approval card, then **Schedule**. A "More" fold holds: if missed, if still running, notify, stop waiting after.
- A **Scheduled** list (all schedules, next time, last result, on/off switch, edit, delete, its skipped/missed log). Where it sits (a tab on the Workflows screen, or a section of it) is chosen when the screen is built.
- Runs started by a schedule carry a "Scheduled" badge in `RunPanel` and the Runs list.

**Phone:** list schedules, switch one off or on, see the "Scheduled" badge on runs. **Not** create, edit or approve: approving unattended work stays on the computer. Allowed calls in `phone.ts` get `schedules.list` and `schedules.setEnabled` only.

**The assistant:** may not create schedules in version 1. A schedule is a standing rule; if the assistant could set one up, one injected instruction in a web page could make Celeste run something every day. The later version (section 8) is a card the person approves, never a tool that acts.

**Tests:**
- `nextRun`: each kind, the 31st, leap day, spring-forward and fall-back in two zones, a time zone change.
- Scheduler with a fake clock: fires once and not twice, a slow tick, catch-up within the grace period and a skip beyond it, overlap skip, workflow edited (paused), workflow deleted, schedule off, `checkReady` failure recorded, wait limit cancels, concurrency cap, restart does not fire twice.
- Runner: `preApproved` skips the card and records the event; a step that asks still waits; a computer step is refused at save.
- Store: migration test (`migrations.test.ts` style), cascade on delete.
- Service: spec validation, approval binding (version, inputs and folder each pause it), export leaves schedules out.
- `verify:schedules` (like `workflows-check.mjs`): the real window, `CELESTE_SCHEDULER_TICK_MS` set small, a "once, in a few seconds" schedule on a shell workflow, the run appears with its badge; edit the workflow and see "Needs your OK again".

## 6. Order of work

1. Migration, types, `nextRun` and its tests.
2. Runner: `preApproved`, `startedBy: 'schedule'`, `{{run.date}}` and `{{run.time}}`.
3. `Scheduler` and its tests; wired in `core/index.ts`; `schedules.*` in the service and API.
4. Window: Schedule dialog, chips, Scheduled list, badges.
5. Staying alive: tray, close behaviour, start with the computer, resume tick.
6. Notifications on the computer, then the phone wake for runs; phone list and switch.
7. `verify:schedules`, README, CHANGELOG, and Ideas.txt item 1 ticked.

Steps 1 to 3 can be built and tested with no window. Step 5 is the one most likely to surprise people, so it is tried by hand on Windows before anything is announced.

## 7. Decisions, with the default I picked

| # | Question | Default | Why |
|---|---|---|---|
| 1 | How is an unattended run approved? | Once, on the card, bound to version, inputs and folder; any change pauses it | Keeps "nothing runs that you have not seen" true. The alternative (approve every run on the phone) defeats scheduling |
| 2 | Must Celeste be running? | Yes. Tray and start-with-computer make that easy; no wake from sleep, no run while closed | Smallest thing that works; the operating system's scheduler is a later step |
| 3 | A cron box? | No, structured picker only | Fewer ways to get it wrong; cron can be added behind "Custom" later |
| 4 | Missed runs | One catch-up run if late by up to 2 hours, else skipped and logged | A morning job should not run at 17:00 |
| 5 | Previous run still going | Skip and log | Two copies of a backup are worse than one missed |
| 6 | Computer steps | Not schedulable in version 1 | Unattended mouse and keyboard needs its own decision |
| 7 | Phone steps | Schedulable; the phone still asks each time | Same consent the phone gives today |
| 8 | Can the assistant create schedules? | No | A standing rule must be a person's click |
| 9 | Can the phone create schedules? | No: list, on and off only | Approving unattended work stays on the computer |
| 10 | Notifications | On failure or "needs you", on the computer and the phone; "also on finish" is per schedule | Quiet when things go well |
| 11 | Time zone | The computer's, stored with the schedule | Predictable when travelling |
| 12 | Where does "Scheduled" live in the window? | Decided when the screen is built | Needs a look at `WorkflowsScreen` with the new list |

## 8. Not in this plan, for later

- **Run while Celeste is closed**, and wake from sleep: register the next run with the operating system's own scheduler (Task Scheduler, launchd, systemd timers) that starts `celeste --run-schedule <id>`. Real work: the app must start headless, and the approval check must be repeated there.
- **The assistant proposing a schedule** ("run this every morning?") as a card in the chat that the person approves.
- **A schedule that pre-grants a few low-risk phone abilities** (alarms, notifications) so an evening alarm does not need a tap.
- **Other triggers:** a file changing, a web address called (a webhook), a device coming online. The `schedules` table would become `triggers`.
- **Computer steps on a schedule,** if there is a safe way (a locked screen cannot be controlled, so this needs thought).
- **A cron box** under "Custom".
