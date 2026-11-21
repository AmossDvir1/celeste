// Helpers in the real built app (docs/plans/SUB_AGENTS_PLAN.md): the assistant of a chat starts another session for a piece of work and gets its
// answer back. A helper that is waited for returns its answer as the tool's result; two started in the background wake the chat once, with both
// answers; in Ask mode a card asks first; Stop in the chat stops its helpers; a helper that asks the person something shows as waiting on the
// card; deleting the chat takes its helpers with it and Undo brings them back; a crash leaves the work marked as not finished; a helper cannot
// start helpers.
//   npm run verify:subagents     (no account, no cost)
// Claude is real (the real SDK and program); what it says, for the chat and for each helper, is chosen by a stand-in for Anthropic's API
// (scripts/lib/stub.mjs). The helper is told apart from the chat by the line Celeste adds to the task it is given.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const TOOL = (name) => `mcp__celeste-devices__${name}`
const call = (name, input) => ({ type: 'tool_use', name: TOOL(name), input })
const slow = (text) => ({ type: 'text', text, chunk: 6, delayMs: 250 })
/** True for a request that belongs to a helper: its first message carries Celeste's line. */
const isChild = (r) => JSON.stringify(r.body.messages ?? []).includes('you are a helper started by another assistant')

const script = (r) => {
  if (isChild(r)) {
    const all = JSON.stringify(r.body.messages ?? [])
    if (r.last.kind === 'tool_result') return [{ type: 'text', text: `CHILD SAW: ${r.last.text}` }]
    if (/TASK HOLD/.test(all)) return [{ type: 'hold' }]
    if (/TASK DEEPER/.test(all)) return [call('agent_start', { task: 'a helper of a helper', title: 'Too deep' })]
    if (/TASK ASKS/.test(all)) return [{ type: 'tool_use', name: 'Bash', input: { command: 'mkdir made-by-helper && echo helper-ran', description: 'Make a folder' } }]
    return [slow(`HELPER ANSWER ${/TASK (\w+)/.exec(all)?.[1] ?? 'X'}`)]
  }
  // The chat is woken with the answers of helpers that ended in the background.
  if (r.last.kind === 'text' && /finished\. It is another assistant/.test(r.last.text)) return [{ type: 'text', text: `PARENT WOKEN: ${r.last.text}` }]
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: `PARENT GOT: ${r.last.text}` }]
  const t = r.last.text
  if (/START A HELPER AND HOLD/.test(t)) return [call('agent_start', { task: 'TASK HOLD never ends', title: 'Holder', wait: true })]
  if (/START A HELPER/.test(t)) return [call('agent_start', { task: 'TASK ONE look at the logs', title: 'Alpha', wait: true })]
  if (/START TWO IN THE BACKGROUND/.test(t)) {
    return [call('agent_start', { task: 'TASK BG1', title: 'Bg1', wait: false, approval: 'plan' }), call('agent_start', { task: 'TASK BG2', title: 'Bg2', wait: false, approval: 'plan' })]
  }
  if (/START AN ASKING HELPER/.test(t)) return [call('agent_start', { task: 'TASK ASKS', title: 'Asker', wait: true })]
  if (/START A DEEP HELPER/.test(t)) return [call('agent_start', { task: 'TASK DEEPER', title: 'Deep', wait: true })]
  return [{ type: 'text', text: `Echo: ${t}. The canary hosts go first.` }]
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-subs-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
// The composer's own Stop, by its label: a helper's card has a Stop of its own while the helper works.
const stopButton = (page) => page.getByLabel('Stop', { exact: true })
const idle = (page) => stopButton(page).waitFor({ state: 'detached', timeout: 90_000 })
const box = (page) => page.getByRole('textbox', { name: 'Message' })
const send = async (page, text) => {
  await box(page).fill(text)
  await box(page).press('Enter')
}
const core = (page, method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])
/** A picture of the window in both themes, to look at (they are not compared with anything). */
const shot = async (page, name) => {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.screenshot({ path: join(import.meta.dirname, '.output', `subagents-${name}-${theme}.png`) })
  }
}
const helperCard = (page, title) => page.getByRole('region', { name: `Helper: ${title}`, exact: true })
const text = (page) => page.evaluate(() => document.body.innerText)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const row = (page, title) => page.locator('[data-session-row]').filter({ hasText: title })

/** The newest session, by when it was made. */
const newest = async (page) => (await core(page, 'app.bootstrap')).sessions.filter((s) => !s.parentId).sort((a, b) => b.createdAt - a.createdAt)[0]
const sessionsNow = async (page) => (await core(page, 'app.bootstrap')).sessions

/** A new chat that begins with `message`, renamed so the sidebar can tell it from the others. Returns its id. */
async function newChat(page, name, message, { ask = false } = {}) {
  await page.getByRole('button', { name: 'New chat' }).click()
  if (ask) {
    await page.getByRole('button', { name: /Approval:/ }).click()
    await page.getByRole('menuitemradio', { name: /Ask first/ }).click()
  }
  await send(page, message)
  await box(page).waitFor()
  let chat
  for (let i = 0; i < 100 && !chat; i++) {
    await sleep(100)
    const found = await newest(page)
    if (found && !found.title.startsWith('Scenario')) chat = found
  }
  await core(page, 'sessions.update', chat.id, { title: name })
  return chat.id
}

let stub
let app
try {
  stub = await startStub(script)
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)

  console.log('\n# A helper that is waited for')
  const one = await newChat(page, 'Scenario one', 'START A HELPER please')
  const alpha = helperCard(page, 'Alpha')
  await alpha.waitFor({ timeout: 60_000 })
  check('a card for the helper appears in the chat', true)
  await alpha.getByText('Working', { exact: true }).waitFor({ timeout: 30_000 })
  check('and says it is working', true)
  const kids = (await sessionsNow(page)).filter((s) => s.parentId === one)
  check('the helper is a session of its own under the chat', kids.length === 1 && kids[0].title === 'Alpha', JSON.stringify(kids.map((k) => k.title)))
  check('its row is listed under the chat in the sidebar, not among the chats', (await row(page, 'Alpha').count()) === 1 && (await page.locator('[data-helper-row]').count()) === 1)
  await shot(page, 'parent-working')
  await alpha.getByText('Done', { exact: true }).waitFor({ timeout: 60_000 })
  check('the card goes to Done when the helper has answered', true)
  await page.getByText(/PARENT GOT: \[Answer from the helper “Alpha”/).first().waitFor({ timeout: 60_000 })
  const said = await text(page)
  check('the chat’s assistant got the helper’s answer as the result of its call, framed as another assistant’s words', /another assistant’s work, not the person’s words\.\]\s*HELPER ANSWER ONE/.test(said))
  check('the call itself is not drawn as a tool card', !/agent_start/.test(said))
  await idle(page)
  await shot(page, 'parent-done')
  // The helper's own view.
  await alpha.getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByRole('note', { name: 'Helper' }).waitFor({ timeout: 20_000 })
  const banner = await page.getByRole('note', { name: 'Helper' }).innerText()
  check('the helper’s view has a banner that names the chat that started it', /Helper started by the assistant in\s+Scenario one/.test(banner), banner)
  check('and its first message is labelled as the chat’s, not the person’s', (await page.getByText('From Scenario one').count()) === 1)
  check('the title leads back to the chat', (await page.locator('h1').first().innerText()).includes('Scenario one'))
  const approvalMenu = page.getByRole('button', { name: /Approval:/ })
  check('the helper has a mode menu of its own', (await approvalMenu.count()) === 1)
  await shot(page, 'helper-view')
  await page.getByRole('button', { name: 'Scenario one', exact: true }).first().click()
  await alpha.waitFor()

  console.log('\n# Two helpers in the background')
  const two = await newChat(page, 'Scenario two', 'START TWO IN THE BACKGROUND now')
  await page.getByText(/PARENT GOT: Started the helper/).first().waitFor({ timeout: 60_000 })
  check('the call returns at once with the helper’s id', true)
  await helperCard(page, 'Bg1').getByText('Done', { exact: true }).waitFor({ timeout: 60_000 })
  await helperCard(page, 'Bg2').getByText('Done', { exact: true }).waitFor({ timeout: 60_000 })
  check('both cards go to Done', true)
  await page.getByText(/PARENT WOKEN:/).first().waitFor({ timeout: 60_000 })
  await idle(page)
  // What the chat's log says (the model may make several small requests for one message, so the log is the count).
  const messages = (await core(page, 'sessions.get', two)).events.map((e) => e.event).filter((e) => e.type === 'user.message')
  const wakes = messages.filter((m) => m.from === 'celeste')
  check('the chat is woken once, not once for each helper', wakes.length === 1 && messages.length === 2, `${wakes.length} wakes, ${messages.length} messages`)
  const note = stub.requests.find((r) => r.last.kind === 'text' && /finished\. It is another assistant/.test(r.last.text))?.last.text ?? ''
  check('with both answers in the note, framed as data', /HELPER ANSWER BG1/.test(note) && /HELPER ANSWER BG2/.test(note) && /not the person’s words/.test(note), note)
  check('the chat shows one quiet line, not the note', (await page.getByText(/Helpers finished: “Bg[12]”, “Bg[12]”\. The assistant was told\./).count()) === 1)
  check('and the cards say the assistant was told', (await page.getByText('The assistant was told.', { exact: true }).count()) === 2)
  await shot(page, 'parent-two-done')
  void two

  console.log('\n# In Ask mode a card asks first')
  const asked = await newChat(page, 'Scenario ask', 'START A HELPER please', { ask: true })
  const startCard = page.getByRole('group', { name: 'Approval needed' }).last()
  await startCard.waitFor({ timeout: 60_000 })
  const startText = await startCard.innerText()
  check('the card says what would start: its name, its words, the folder and the mode', /Start a helper\?/.test(startText) && /Alpha/.test(startText) && /TASK ONE look at the logs/.test(startText) && /Approval mode: ask/.test(startText), startText)
  check('and the card does not end in two question marks', !/\?\?/.test(startText))
  check('nothing is made while it waits', (await sessionsNow(page)).filter((s) => s.parentId === asked).length === 0)
  await shot(page, 'start-card')
  await startCard.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.getByText(/PARENT GOT: The person said no to starting this helper/).first().waitFor({ timeout: 60_000 })
  await idle(page)
  check('Deny starts nothing, and the assistant is told not to try again', (await sessionsNow(page)).filter((s) => s.parentId === asked).length === 0 && (await helperCard(page, 'Alpha').count()) === 0)
  await send(page, 'START A HELPER again')
  const second = page.getByRole('group', { name: 'Approval needed' }).last()
  await second.getByRole('button', { name: 'Allow', exact: true }).waitFor({ timeout: 60_000 })
  await second.getByRole('button', { name: 'Allow', exact: true }).click()
  await helperCard(page, 'Alpha').getByText('Done', { exact: true }).waitFor({ timeout: 60_000 })
  check('Allow starts it, and it answers', (await sessionsNow(page)).filter((s) => s.parentId === asked).length === 1)
  await idle(page)
  const kid = (await sessionsNow(page)).find((s) => s.parentId === asked)
  check('and it is in the chat’s own mode, which it cannot be loosened from', kid?.approval === 'ask' && kid?.ceiling === 'ask', JSON.stringify(kid))
  const looser = await core(page, 'sessions.update', kid.id, { approval: 'auto' }).then(
    () => 'accepted',
    (e) => String(e.message ?? e)
  )
  check('asking for a looser mode is refused in a sentence', /cannot be looser than the chat that started it \(ask\)/.test(looser), looser)

  console.log('\n# Stop in the chat stops its helper')
  const stopId = await newChat(page, 'Scenario stop', 'START A HELPER AND HOLD')
  const holder = helperCard(page, 'Holder')
  await holder.getByText('Working', { exact: true }).waitFor({ timeout: 60_000 })
  await stopButton(page).click()
  await holder.getByText('Stopped', { exact: true }).waitFor({ timeout: 30_000 })
  check('the card says it was stopped', true)
  await idle(page)
  const held = (await sessionsNow(page)).find((s) => s.parentId === stopId)
  for (let i = 0; i < 50 && (await sessionsNow(page)).find((s) => s.id === held.id)?.status !== 'idle'; i++) await sleep(200)
  check('the helper itself is idle, and still there to be continued', (await sessionsNow(page)).find((s) => s.id === held.id)?.status === 'idle')
  const before = stub.requests.length
  await sleep(3500)
  check('nobody is woken for it: no further request was made', stub.requests.length === before, `${stub.requests.length - before} more`)
  check('and the card does not say the assistant was told', (await holder.getByText('The assistant was told.').count()) === 0)

  console.log('\n# A helper that asks the person something')
  const asker = await newChat(page, 'Scenario question', 'START AN ASKING HELPER', { ask: true })
  const okStart = page.getByRole('group', { name: 'Approval needed' }).last()
  await okStart.getByRole('button', { name: 'Allow', exact: true }).waitFor({ timeout: 60_000 })
  await okStart.getByRole('button', { name: 'Allow', exact: true }).click()
  const askerCard = helperCard(page, 'Asker')
  await askerCard.getByText('Waiting for you', { exact: true }).waitFor({ timeout: 60_000 })
  check('the helper asks to run a command, and its card in the chat says it waits for the person', true)
  check('its row in the sidebar says it needs the person too', (await row(page, 'Asker').filter({ hasText: 'Needs you' }).count()) === 1)
  await shot(page, 'parent-waiting')
  await askerCard.getByRole('button', { name: 'Open', exact: true }).click()
  const inHelper = page.getByRole('group', { name: 'Approval needed' }).last()
  await inHelper.waitFor({ timeout: 20_000 })
  check('Open shows the question in the helper', /mkdir made-by-helper/.test(await inHelper.innerText()))
  await shot(page, 'helper-waiting')
  await inHelper.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.getByText(/CHILD SAW: .*helper-ran/).first().waitFor({ timeout: 60_000 })
  await idle(page)
  await page.getByRole('button', { name: 'Scenario question', exact: true }).first().click()
  await page.getByText(/PARENT GOT:[\s\S]*CHILD SAW/).first().waitFor({ timeout: 60_000 })
  check('answering it there lets the helper finish, and the chat’s call returns the answer', true)
  void asker

  console.log('\n# A helper cannot start helpers')
  const deep = await newChat(page, 'Scenario deep', 'START A DEEP HELPER')
  await page.getByText(/PARENT GOT:[\s\S]*Helpers cannot start helpers\./).first().waitFor({ timeout: 60_000 })
  check('its call is refused in a sentence, and that is what the chat gets back', true)
  check('and it made nothing', (await sessionsNow(page)).filter((s) => s.parentId === deep).length === 1)
  await idle(page)

  console.log('\n# Deleting the chat deletes its helpers, and Undo brings them back')
  const ids = (await sessionsNow(page)).filter((s) => s.parentId === two).map((s) => s.id)
  check('the chat has two helpers to begin with', ids.length === 2)
  await row(page, 'Scenario two').first().hover()
  await row(page, 'Scenario two').first().getByRole('button', { name: /More actions/ }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: /^Delete “/ }).getByRole('button', { name: 'Delete', exact: true }).click()
  await sleep(500)
  const gone = await sessionsNow(page)
  check('the chat and both helpers are gone from the list', !gone.some((s) => s.id === two || ids.includes(s.id)))
  check('and from the sidebar', (await row(page, 'Scenario two').count()) === 0 && (await row(page, 'Bg1').count()) === 0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await row(page, 'Scenario two').first().waitFor({ timeout: 10_000 })
  const back = await sessionsNow(page)
  check('Undo brings all of them back', back.some((s) => s.id === two) && ids.every((id) => back.some((s) => s.id === id)))
  check('and the helpers are idle, not left looking busy', ids.every((id) => back.find((s) => s.id === id)?.status === 'idle'))

  console.log('\n# A crash while a helper works')
  const crashId = await newChat(page, 'Scenario crash', 'START A HELPER AND HOLD')
  await helperCard(page, 'Holder').getByText('Working', { exact: true }).waitFor({ timeout: 60_000 })
  await page.waitForTimeout(800)
  await app.crash()
  const requestsBefore = stub.requests.length
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
  page = app.page
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await claudeReady(page)
  await row(page, 'Scenario crash').first().click()
  await helperCard(page, 'Holder').getByText('Not finished', { exact: true }).waitFor({ timeout: 20_000 })
  check('the chat’s card says the work was not finished', true)
  const reborn = (await sessionsNow(page)).find((s) => s.parentId === crashId)
  check('the helper is idle and shows what happened to its turn', reborn?.status === 'idle')
  await sleep(3500)
  check('nothing was restarted or woken by itself', stub.requests.length === requestsBefore, `${stub.requests.length - requestsBefore} more`)
  await shot(page, 'after-crash')
  await app.close()
  app = undefined
} catch (err) {
  console.error(err)
  failures.push(`crashed: ${err instanceof Error ? err.message : String(err)}`)
  try {
    await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'subagents-failure.png') })
  } catch {
    /* the window may be gone */
  }
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed.')
process.exit(failures.length ? 1 : 0)
