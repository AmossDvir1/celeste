# Contributing to Celeste

Thanks for your interest. Celeste is early, so the most useful contributions right now are bug reports, testing on
platforms the maintainer cannot reach (macOS, Linux, real remote machines and phones), and small, focused fixes.

## Set up

You need Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Both must pass. If you changed something the running app depends on, also run the matching check against the built app
(`npm run verify:persistence`, `verify:package`, `verify:devices`). Please do not run `npm run verify:copilot` or the
Copilot and Claude live tests unless you mean to: they use your own accounts and spend your quota. `npm run verify:claude` is safe: it
talks to a stand-in for Anthropic's API on your own computer.

## Guidelines

- Keep a change focused, and explain what it fixes or adds and how you checked it.
- Match the style of the code around your change: naming, comments, and how much of each.
- Add a test with a behavior change. Vendor adapters are tested against recorded or scripted events, so no account is needed.
- Never log or commit keys, tokens, passwords or recordings that contain account details.
- A change to the database is a new migration in `src/core/migrations.ts`, never an edit to a shipped one.
- A device must never run a command without the approval rules in `src/core/devices`. Changes there get extra review.

## Reporting a bug

Use the bug report form. Include your operating system, what you did, what you expected and what happened. For anything
security related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
