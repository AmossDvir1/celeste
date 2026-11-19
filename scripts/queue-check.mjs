// Messages sent while the assistant works, in the real built app: one that waits its turn (Add to queue), and one that joins the turn that is
// running (Steer). Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs),
// which also records what the model was sent and in what order. A message typed while the assistant waits for an answer lets go of the question
// and goes at once. A vendor at its limit gets a line in the chat, and the messages waiting for it go on by themselves when it comes back.
// npm run verify:queue     (no account, no cost)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const SLOW = 'node -e "setTimeout(()=>console.log(\'slow done\'),5000)"'

/** What the model does: a slow command for "SLOW", a slow answer for "STREAM", and otherwise it says what it was told. */
const script = (r) => {
  // The API refuses the request, as it does for an account at its limit (after a few seconds, so a message can be queued meanwhile).
  if (r.last.kind === 'text' && /LIMIT soon/.test(r.last.text)) return [{ type: 'error', status: 429, kind: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit', delayMs: 4000 }]
  // After a Stop, Claude Code answers the cut-off call first, so the new message is in the last turn but not the last block.
  if (/NEVERMIND/.test(JSON.stringify(r.body.messages.at(-1)))) return [{ type: 'text', text: 'Saw: NEVERMIND just say hi' }]
  if (r.last.kind === 'text' && /ASK ME/.test(r.last.text)) return [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour should the button be?', header: 'Colour', multiSelect: false, options: [{ label: 'Pink', description: 'The accent' }, { label: 'Blue', description: 'Calmer' }] }] } }]
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: 'The slow command is done.' }]
  const text = r.last.text
  if (/SLOW/.test(text) && !/STEER|WAIT/.test(text)) return [{ type: 'tool_use', name: 'Bash', input: { command: SLOW, description: 'Wait five seconds' } }]
  if (/STREAM/.test(text) && !/STEER|WAIT/.test(text)) return [{ type: 'text', text: 'word '.repeat(60), chunk: 5, delayMs: 100 }]
  return [{ type: 'text', text: `Saw: ${text}` }]
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-queue-'))
/** What the vendor reports about its allowance (CELESTE_USAGE_FILE stands in for Claude's own reading). */
const usageFile = join(profile, 'usage.json')
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const idle = (page) => page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 90_000 })
const box = (page) => page.getByRole('textbox', { name: 'Message' })
const send = async (page, text) => {
  await box(page).fill(text)
  await box(page).press('Enter')
}
/** The text of every request's newest user message that carries a word, in the order the model got them. */
const heardOrder = (stub, word) => stub.requests.flatMap((r, i) => (JSON.stringify(r.body.messages).includes(word) ? [i] : []))

/** Waits until the model has asked for the slow command (a request after `from` that is answered with it), and a moment more for it to be running. */
async function started(stub, from) {
  for (let i = 0; i < 100 && stub.requests.length <= from; i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 1500))
}

let stub
let app
try {
  stub = await startStub(script)
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: { ...stub.env, CELESTE_USAGE_FILE: usageFile } })
  const { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)

  console.log('\n# Waiting its turn')
  await send(page, 'please do the SLOW thing')
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 30_000 })
  await box(page).fill('WAIT then say hello')
  check('while it works there are three ways to send, and Steer is one of them (Claude takes a message into its turn)', (await page.getByRole('button', { name: 'Add to queue' }).count()) === 1 && (await page.getByRole('button', { name: /^Steer/ }).count()) === 1 && (await page.getByRole('button', { name: /^Send now/ }).count()) === 1)
  await page.getByRole('button', { name: 'Add to queue' }).click()
  const waiting = page.getByRole('list', { name: 'Messages waiting' })
  await waiting.waitFor({ timeout: 10_000 })
  check('Add to queue shows the message as waiting, and it is not sent to the model yet', /WAIT then say hello/.test(await waiting.innerText()) && heardOrder(stub, 'WAIT then say hello').length === 0)
  await page.getByText('Saw: WAIT then say hello').first().waitFor({ timeout: 90_000 })
  await idle(page)
  check('when the turn ends it is sent, and the list empties', (await page.getByRole('list', { name: 'Messages waiting' }).count()) === 0)
  check('after the slow command had finished, not during it', heardOrder(stub, 'The slow command is done').length > 0 && heardOrder(stub, 'WAIT then say hello')[0] > heardOrder(stub, 'The slow command is done')[0])

  console.log('\n# Steering a command that is running')
  const before = stub.requests.length
  await send(page, 'please do the SLOW thing again')
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 30_000 })
  await started(stub, before)
  await box(page).fill('STEER use tabs')
  await page.getByRole('button', { name: /^Steer/ }).click()
  await page.getByText('STEER use tabs', { exact: true }).first().waitFor({ timeout: 10_000 })
  check('a steering message is in the chat at once and is not a waiting one', (await page.getByRole('list', { name: 'Messages waiting' }).count()) === 0)
  await page.getByText('The slow command is done.').nth(1).waitFor({ timeout: 90_000 })
  await idle(page)
  const mine = stub.requests.slice(before)
  const afterTool = mine.find((r) => JSON.stringify(r.body.messages).includes('The user sent a new message while you were working'))
  check('the model read it in the same turn, in the request after the command’s answer', !!afterTool && JSON.stringify(afterTool.body.messages).includes('STEER use tabs'))
  check('and no request answered it as a turn of its own', !mine.some((r) => r.last.kind === 'text' && r.last.text === 'STEER use tabs'))
  check('the chat shows one answer to it, not two', (await page.getByText('The slow command is done.').count()) === 2)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'queue-steer.png') })

  console.log('\n# Steering when the answer ends first')
  const before2 = stub.requests.length
  await send(page, 'please STREAM a long answer')
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByText('word word', { exact: false }).first().waitFor({ timeout: 30_000 })
  await box(page).fill('STEER be brief')
  await page.getByRole('button', { name: /^Steer/ }).click()
  await page.getByText('Saw: STEER be brief').first().waitFor({ timeout: 90_000 })
  await idle(page)
  check('the message becomes a turn of its own and its answer is shown', (await page.getByText('Saw: STEER be brief').count()) === 1)
  check('and the chat is not left working', (await page.getByRole('button', { name: 'Stop', exact: true }).count()) === 0)
  check('it was sent to the model once', stub.requests.slice(before2).filter((r) => r.last.kind === 'text' && r.last.text === 'STEER be brief').length === 1)

  console.log('\n# The keyboard')
  const before3 = stub.requests.length
  await send(page, 'please do the SLOW thing a third time')
  await started(stub, before3)
  await box(page).fill('STEER with the keyboard')
  await box(page).press('Alt+Enter')
  await page.getByText('STEER with the keyboard', { exact: true }).first().waitFor({ timeout: 10_000 })
  check('Alt+Enter steers, and puts nothing in the waiting list', (await page.getByRole('list', { name: 'Messages waiting' }).count()) === 0)
  await page.getByText('The slow command is done.').nth(2).waitFor({ timeout: 90_000 })
  await idle(page)

  console.log('\n# A question that is not answered')
  await send(page, 'ASK ME something')
  const question = page.getByText('Which colour should the button be?').first()
  await question.waitFor({ timeout: 60_000 })
  check('the assistant asks and the chat waits for the person', (await page.getByRole('group', { name: 'Celeste is asking you a question' }).count()) === 1)
  await send(page, 'NEVERMIND just say hi')
  await page.getByText('Saw: NEVERMIND just say hi').first().waitFor({ timeout: 90_000 })
  await idle(page)
  check('typing a message instead of answering lets go of the question: it says it was skipped and no longer asks', (await page.getByText('You skipped:').count()) === 1 && (await page.getByRole('group', { name: 'Celeste is asking you a question' }).count()) === 0)
  check('the message was not left waiting in the queue', (await page.getByRole('list', { name: 'Messages waiting' }).count()) === 0)
  check('and it was sent to the model once', stub.main.filter((r) => /NEVERMIND/.test(JSON.stringify(r.body.messages.at(-1)))).length === 1, String(stub.main.filter((r) => /NEVERMIND/.test(JSON.stringify(r.body.messages.at(-1)))).length))
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'queue-skipped-question.png') })

  console.log('\n# A vendor at its limit')
  // The 5-hour window is used up and comes back in fourteen seconds.
  writeFileSync(usageFile, JSON.stringify({ claude: { plan: 'max', windows: [{ key: 'five_hour', label: '5-hour session', percentUsed: 100, resetsAt: Date.now() + 14_000 }] } }))
  const beforeLimit = stub.main.length
  await send(page, 'LIMIT soon please')
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 30_000 })
  await box(page).fill('WAIT after the limit')
  await page.getByRole('button', { name: 'Add to queue' }).click()
  await page.getByRole('list', { name: 'Messages waiting' }).waitFor({ timeout: 10_000 })
  await page.getByText(/Claude is at its limit \(5-hour session\)\. It comes back in/).first().waitFor({ timeout: 60_000 })
  check('the chat says the vendor is at its limit, which allowance, and when it comes back', true)
  const held = page.getByRole('list', { name: 'Messages waiting' })
  await held.getByText(/Waiting for the limit to lift/).waitFor({ timeout: 10_000 })
  check('the waiting message says it is held until the limit lifts, and goes by itself', /It goes by itself then/.test(await held.innerText()))
  check('and nothing is sent to the model meanwhile', stub.main.slice(beforeLimit).every((r) => !/WAIT after the limit/.test(JSON.stringify(r.body.messages.at(-1)))))
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'queue-limit.png') })
  await page.getByText('Saw: WAIT after the limit').first().waitFor({ timeout: 90_000 })
  await idle(page)
  check('after the reset it is sent by itself, once, and answered', stub.main.filter((r) => /WAIT after the limit/.test(JSON.stringify(r.body.messages.at(-1)))).length === 1)
  check('and the list is empty again', (await page.getByRole('list', { name: 'Messages waiting' }).count()) === 0)

  console.log('\n# After a restart')
  await app.close()
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: { ...stub.env, CELESTE_USAGE_FILE: usageFile } })
  const p2 = app.page
  await p2.getByText('please do the SLOW thing').first().click()
  await p2.getByText('STEER use tabs', { exact: true }).first().waitFor({ timeout: 20_000 })
  check('a steering message is still in the conversation', true)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'queue-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(profile, { recursive: true, force: true })
      break
    } catch {
      if (i === 19) console.warn(`Could not remove ${profile}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
