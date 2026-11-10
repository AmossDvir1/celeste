// How the app copes with a LONG conversation, in the real built app (no account, no cost: Claude is the real program talking to a
// stand-in for Anthropic's API). It writes a conversation of about 150 turns into the profile the way Celeste records one (every
// token is its own entry in the log), then:
//   1. opens it, and says how long that takes, and how long the window was busy;
//   2. sends a message that is answered with a long reply, arriving in small pieces like a model's tokens, and says how smoothly
//      it was drawn (the longest freeze, the frames) and how much longer than the stream itself it took to finish;
//   3. runs two such conversations answering at once and checks that the list on the left holds still (no session changes
//      place while both are only writing).
//   npm run verify:perf      (SEED_TURNS=300 for a longer one)
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, startStub } from './lib/stub.mjs'

const TURNS = Number(process.env.SEED_TURNS ?? 150)
const CHUNK = 5
const DELAY = 4

const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

/** A reply of the kind assistants write: a heading, paragraphs, a list, a table and a code block. */
const reply = (n, long = false) =>
  [
    `## Part ${n}`,
    '',
    `Here is what I found for step ${n}. The main point is that the **cache** is filled lazily, so the first request after a restart is slower than the rest, and \`warmUp()\` fixes that without changing any behaviour.`,
    '',
    '- read the settings once at start',
    '- keep the connection open between requests',
    '- log the slow ones, with how long they took',
    '',
    '| step | time | note |',
    '|---|---|---|',
    `| ${n}.1 | ${n * 3} ms | first |`,
    `| ${n}.2 | ${n * 2} ms | second |`,
    '',
    '```ts',
    `export function step${n}(input: string): string {`,
    `  return input.trim().toLowerCase() + '-${n}'`,
    '}',
    '```',
    '',
    ...(long
      ? Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of the long reply: the quick brown fox jumps over the lazy dog while the build runs in the background, and nothing else changes.`).flatMap((p) => [p, ''])
      : []),
    n === TURNS ? 'END-OF-LOG' : `That covers part ${n}.`
  ].join('\n')

const pieces = (text, size) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []

/** Writes the conversation into the profile's database, one log entry per token, like a real one. */
function seed(profile, title, turns, status = 'idle') {
  const db = new DatabaseSync(join(profile, 'celeste.db'))
  const id = `s-${crypto.randomUUID()}`
  const now = Date.now()
  let seq = 0
  let at = now - turns * 60_000
  db.exec('BEGIN')
  db.prepare(
    `INSERT INTO sessions (id, mode, title, model, effort, approval, cwd, branch, status, created_at, updated_at, last_seq, deleted_at, vendor, vendor_session_id)
     VALUES (?, 'chat', ?, 'claude:haiku', NULL, 'auto', NULL, NULL, ?, ?, ?, 0, NULL, 'claude', NULL)`
  ).run(id, title, status, now - turns * 60_000, now)
  const put = db.prepare('INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
  const add = (event, step = 15) => {
    at += step
    put.run(id, ++seq, event.type, JSON.stringify(event), at)
  }
  for (let n = 1; n <= turns; n++) {
    add({ type: 'user.message', text: `Please look at step ${n} and tell me what you find. Keep it short.`, attachments: [] }, 5000)
    add({ type: 'turn.started', turnId: `t${n}` })
    for (const p of pieces(`I should look at step ${n} carefully, think about the cache, and check what the settings say before answering.`, 8)) add({ type: 'thinking.delta', text: p })
    for (let k = 0; k < 2; k++) {
      add({ type: 'tool.started', id: `tool-${n}-${k}`, kind: k === 0 ? 'read' : 'shell', title: k === 0 ? `Read src/step${n}.ts` : 'npm test', input: 'x' })
      for (const p of pieces('line one of the output\nline two of the output\nline three\n', 20)) add({ type: 'tool.output', id: `tool-${n}-${k}`, text: p })
      add({ type: 'tool.completed', id: `tool-${n}-${k}`, ok: true }, 400)
    }
    for (const p of pieces(reply(n), CHUNK)) add({ type: 'message.delta', text: p })
    add({ type: 'turn.completed', turnId: `t${n}` })
  }
  db.prepare('UPDATE sessions SET last_seq = ? WHERE id = ?').run(seq, id)
  db.exec('COMMIT')
  db.close()
  return { id, events: seq }
}

const api = await startStub((r) => {
  if (r.last.kind === 'text' && r.last.text.includes('STREAM')) return [{ type: 'text', text: reply(0, true), chunk: CHUNK, delayMs: DELAY }]
  return echo(r)
})
const profile = mkdtempSync(join(tmpdir(), 'celeste-perf-'))
mkdirSync(profile, { recursive: true })

try {
  // First start: a profile with Claude connected.
  let app = await launch({ width: 1280, height: 860, theme: null, profile, copilotKnowsNoOne: true, env: api.env })
  await app.page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(app.page, { wizardDone: true, userName: 'Dana', defaults: { approval: 'auto' } })
  await app.page.reload()
  await app.page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(app.page)
  await app.page.keyboard.press('Escape')
  await app.close()

  const longOne = seed(profile, 'A very long conversation', TURNS)
  const second = seed(profile, 'Another long conversation', Math.min(TURNS, 60))
  console.log(`seeded ${longOne.events} log entries in the long conversation, ${second.events} in the other`)

  app = await launch({ width: 1280, height: 860, theme: null, profile, copilotKnowsNoOne: true, env: api.env })
  const { page } = app
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await claudeReady(page).catch(() => undefined)
  await page.evaluate(() => {
    window.__long = []
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] })
  })

  // The same stream in an empty chat: what this computer and the stand-in take with nothing to slow it down.
  const calibrate = async () => {
    await page.getByRole('button', { name: 'New chat' }).first().click()
    const box = page.getByRole('textbox', { name: 'Message' })
    await box.fill('STREAM calibrate')
    const started = Date.now()
    await box.press('Enter')
    await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 180_000 })
    return Date.now() - started
  }
  const baseline = await calibrate()
  console.log(`the same reply into an empty chat: ${baseline} ms`)

  // 1. Opening it.
  await page.evaluate(() => {
    window.__long.length = 0
    window.__t = performance.now()
  })
  await page.getByRole('button', { name: /A very long conversation/ }).first().click()
  await page.getByText('END-OF-LOG').first().waitFor({ timeout: 120_000 })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const open = await page.evaluate(() => ({ ms: performance.now() - window.__t, busy: window.__long.reduce((a, b) => a + b, 0), worst: Math.max(0, ...window.__long), nodes: document.getElementsByTagName('*').length }))
  console.log(`opening: ${Math.round(open.ms)} ms until the end of it is drawn; the window was frozen for ${Math.round(open.busy)} ms (worst single freeze ${Math.round(open.worst)} ms); ${open.nodes} elements on the page`)
  check(open.ms < 4000, `a long conversation opens in under 4 s (${Math.round(open.ms)} ms)`)
  check(open.worst < 1000, `and never freezes the window for a second at once (${Math.round(open.worst)} ms)`)

  // 2. A long reply arriving in small pieces, into the long conversation.
  const stream = async (label) => {
    await page.evaluate(() => {
      window.__long.length = 0
      window.__m = { frames: [], last: performance.now(), stop: false }
      const loop = (t) => {
        window.__m.frames.push(t - window.__m.last)
        window.__m.last = t
        if (!window.__m.stop) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })
    const box = page.getByRole('textbox', { name: 'Message' })
    await box.fill(`STREAM ${label}`)
    const started = Date.now()
    await box.press('Enter')
    await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 180_000 })
    const took = Date.now() - started
    return { took, ...(await page.evaluate(() => {
      window.__m.stop = true
      const f = [...window.__m.frames].sort((a, b) => a - b)
      return { frames: f.length, p95: f[Math.floor(f.length * 0.95)] ?? 0, max: f[f.length - 1] ?? 0, busy: window.__long.reduce((a, b) => a + b, 0), worst: Math.max(0, ...window.__long), longTasks: window.__long.length }
    })) }
  }
  const s1 = await stream('one')
  console.log(`streaming a long reply into it: ${s1.took} ms (${baseline} ms into an empty chat); ${s1.frames} frames, 95% of them under ${Math.round(s1.p95)} ms, the slowest ${Math.round(s1.max)} ms; ${s1.longTasks} freezes of 50 ms or more, ${Math.round(s1.busy)} ms in all, the worst ${Math.round(s1.worst)} ms`)
  check(s1.worst < 300, `no single freeze above 300 ms while it streams (${Math.round(s1.worst)} ms)`)
  check(s1.took < baseline * 1.5 + 1500, `the answer is drawn about as fast as it arrives, as in an empty chat (${s1.took} ms, against ${baseline} ms)`)

  // 3. Two conversations answering at once: the list on the left holds still.
  const order = () => page.evaluate(() => [...document.querySelectorAll('aside[aria-label="Sessions"] button[aria-current], aside[aria-label="Sessions"] section button')].map((b) => b.textContent.trim().slice(0, 40)))
  await page.getByRole('button', { name: /Another long conversation/ }).first().click()
  await page.getByRole('textbox', { name: 'Message' }).fill('STREAM two')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /A very long conversation/ }).first().click()
  await page.getByRole('textbox', { name: 'Message' }).fill('STREAM three')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await page.waitForTimeout(500)
  const dots = await page.locator('aside[aria-label="Sessions"] [data-working]').count()
  check(dots === 2, `a dot shows in the list for each of the two sessions that are working (${dots})`)
  const seen = new Set()
  for (let i = 0; i < 40; i++) {
    seen.add(JSON.stringify(await order()))
    await page.waitForTimeout(120)
  }
  check(seen.size === 1, `while both are writing, the list does not change order (${seen.size} different orders seen)`)
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 180_000 }).catch(() => undefined)
  await page.waitForFunction(() => document.querySelectorAll('aside[aria-label="Sessions"] [data-working]').length === 0, undefined, { timeout: 120_000 })
  check(true, 'the dots go when both have finished')
  await app.close()
} finally {
  await api.stop()
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch {
    // The app may still be letting go of its files; the folder is in the temporary folder.
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll passed.')
