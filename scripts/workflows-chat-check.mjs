// A workflow started from a conversation, in the real built app: "/" opens a menu of workflows and Celeste's commands, choosing a workflow
// makes a chip with its questions, sending runs it in the conversation with a card that asks first, the result is folded into the
// card, and the assistant is told how it ended with the next message.   npm run verify:workflows-chat   (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, say, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-wf-chat-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

let stub
let app
try {
  stub = await startStub()
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
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

  // A workflow with a question, and a command that uses the answer.
  await page.evaluate(() =>
    window.celeste.core.call('workflows.save', [
      {
        name: 'Test the app',
        description: 'Runs the tests.',
        definition: {
          nodes: [
            { id: 'start', type: 'start', name: 'Start', inputs: [{ name: 'env', label: 'Environment', type: 'choice', options: ['staging', 'prod'], default: 'staging' }] },
            { id: 'run_tests', type: 'tool', name: 'Run the tests', tool: { kind: 'shell', command: 'echo tests-passed-on-{{inputs.env}}' } },
            { id: 'end', type: 'end', name: 'End', output: '{{nodes.run_tests.output}}' }
          ],
          edges: [{ from: 'start', to: 'run_tests' }, { from: 'run_tests', to: 'end' }]
        }
      }
    ])
  )

  console.log('\n# The / menu')
  await say(page, 'Hello there')
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.click()
  await page.keyboard.type('/')
  const menu = page.getByRole('listbox', { name: 'Workflows and commands' })
  await menu.waitFor({ timeout: 8000 })
  const options = await menu.getByRole('option').allInnerTexts()
  check('"/" as the first character lists the workflows and Celeste’s commands, each tagged with where it comes from', options.some((o) => /test-the-app[\s\S]*Workflow/.test(o)) && options.some((o) => /new[\s\S]*Celeste/.test(o)), options.join(' | '))
  await page.keyboard.type('test')
  check('typing narrows it down', (await menu.getByRole('option').count()) === 1)
  await page.keyboard.press('Escape')
  check('Escape closes it without losing the text', (await menu.count()) === 0 && (await box.inputValue()) === '/test')
  await box.fill('')
  await page.keyboard.type('a path like /home/dev/app')
  check('a "/" that is not the first character is just text', (await menu.count()) === 0)
  await box.fill('')
  await page.keyboard.type('/test')
  await page.keyboard.press('Enter')
  const chip = page.getByRole('group', { name: 'Workflow Test the app' })
  await chip.waitFor({ timeout: 8000 })
  check('choosing a workflow makes a chip, not text', (await box.inputValue()) === '' && (await chip.count()) === 1)
  check('with its question, answered by default', (await chip.getByRole('combobox', { name: 'Environment' }).inputValue()) === 'staging')
  await chip.getByRole('combobox', { name: 'Environment' }).selectOption('prod')

  console.log('\n# Running it in the conversation')
  await page.getByRole('button', { name: 'Send message' }).click()
  const card = page.getByRole('region', { name: 'Workflow: Test the app' })
  await card.waitFor({ timeout: 15_000 })
  await card.getByRole('group', { name: 'Approval needed' }).waitFor({ timeout: 15_000 })
  check('a card appears in the conversation and asks first, listing the command with the answer in it', /echo tests-passed-on-prod/.test(await card.innerText()))
  mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'workflow-chat-approval.png') })
  await card.getByRole('button', { name: 'Allow and run' }).click()
  await card.getByRole('group', { name: 'Result' }).waitFor({ timeout: 30_000 })
  check('it runs and the result is in the card', /tests-passed-on-prod/.test(await card.getByRole('group', { name: 'Result' }).innerText()))
  check('which says it finished, and folds the steps away', (await card.getByText('Finished').count()) >= 1 && (await card.getByRole('list', { name: 'Steps' }).count()) === 0)
  await card.getByRole('button', { name: 'Show the steps' }).click()
  check('they can be shown again', (await card.getByRole('list', { name: 'Steps' }).count()) === 1)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'workflow-chat-result.png') })

  console.log('\n# The assistant is told')
  const before = stub.requests.length
  await say(page, 'What did it say')
  const sent = stub.requests.slice(before).map((r) => (r.last.kind === 'text' ? r.last.text : '')).join('\n')
  check('the next message carries how the workflow ended', /The workflow “Test the app” that the user started from this conversation finished\. Its result:\s+tests-passed-on-prod/.test(sent), sent.slice(0, 300))
  const again = stub.requests.length
  await say(page, 'And once more')
  check('and only once', !stub.requests.slice(again).some((r) => r.last.kind === 'text' && r.last.text.includes('The workflow')))

  console.log('\n# After a restart')
  await app.close()
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  const p2 = app.page
  await p2.getByText('Hello there').first().click()
  const kept = p2.getByRole('region', { name: 'Workflow: Test the app' })
  await kept.waitFor({ timeout: 20_000 })
  check('the card is still in the conversation, with its result', /tests-passed-on-prod/.test(await kept.innerText()))

  console.log('\n# Typed out in full')
  const box2 = p2.getByRole('textbox', { name: 'Message' })
  await box2.click()
  await p2.keyboard.type('/test-the-app env=staging')
  await p2.keyboard.press('Enter')
  await p2.getByRole('group', { name: 'Workflow Test the app' }).waitFor({ timeout: 10_000 })
  check('"/name answer=value" works for the keyboard, with the answer filled in', (await p2.getByRole('group', { name: 'Workflow Test the app' }).getByRole('combobox', { name: 'Environment' }).inputValue()) === 'staging')
  await p2.getByRole('button', { name: 'Remove the workflow Test the app' }).click()
  check('a chip can be taken away', (await p2.getByRole('group', { name: 'Workflow Test the app' }).count()) === 0)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'workflows-chat-failure.png') }).catch(() => undefined)
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
