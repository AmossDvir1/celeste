// The assistant and workflows, in the real built app: Build with AI drafts one from a description, "Make this a workflow" drafts one from a
// conversation, and the assistant can run a workflow only when the person allowed it, after a card that asks first.
// npm run verify:workflows-ai     (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, say, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-wf-ai-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

/** What the "assistant" answers when asked to draft a workflow. */
const spec = (name) =>
  JSON.stringify({
    name,
    description: 'Greets someone and keeps a note of it.',
    inputs: [{ name: 'who', label: 'Who to greet', type: 'text', default: 'world' }],
    steps: [
      { id: 'note', name: 'Write the note', do: 'file', op: 'write', path: 'hello.txt', content: 'Hello {{inputs.who}}' },
      { id: 'say', name: 'Say hello', do: 'command', command: 'echo hello-from-a-draft' }
    ],
    result: '{{nodes.say.output}}'
  })

const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: `The workflow tool said: ${r.last.text}` }]
  const text = r.last.text
  if (/Make a workflow for this/.test(text)) return [{ type: 'text', text: spec('Greet people') }]
  if (/Below is a conversation/.test(text)) return [{ type: 'text', text: spec('Greet people') }]
  if (/Run the greeting workflow/.test(text)) return [{ type: 'tool_use', name: 'mcp__celeste-devices__workflow_run', input: { name: 'Assistant greeting', inputs: {} } }]
  return echo(r)
}

let stub
let app
try {
  stub = await startStub(script)
  // Copilot knows no one here, so a step that names no model goes to the stand-in and never to the real account signed in on this computer.
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
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

  const nodes = page.locator('.react-flow__node')
  const modes = page.getByRole('navigation', { name: 'Modes' })

  console.log('\n# Build with AI')
  await modes.getByRole('button', { name: 'Workflows' }).click()
  await page.getByRole('heading', { name: 'No workflows yet' }).waitFor()
  await page.getByRole('button', { name: 'Build with AI' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Build with AI' })
  const draft = dialog.getByRole('button', { name: 'Draft it' })
  check('Draft it waits until there is something to go on', await draft.isDisabled())
  await dialog.getByRole('textbox', { name: 'What should the workflow do?' }).fill('Greet someone by name and keep a note of it')
  await draft.click()
  await page.getByRole('textbox', { name: 'Workflow name' }).waitFor({ timeout: 90_000 })
  check('the draft opens on the canvas, named, with Start, its steps and End', (await page.getByRole('textbox', { name: 'Workflow name' }).inputValue()) === 'Greet people' && (await nodes.count()) === 4, `name ${await page.getByRole('textbox', { name: 'Workflow name' }).inputValue()}, steps ${await nodes.count()}`)
  check('and it is not saved: nothing is kept or run until the person says so', (await page.getByText('Unsaved changes').count()) === 1 && (await page.getByRole('list', { name: 'Your workflows' }).count()) === 0)
  const asked = stub.requests.map((r) => (r.last.kind === 'text' ? r.last.text : '')).find((t) => /Make a workflow for this/.test(t)) ?? ''
  check('the assistant was told the format, and what the person wants', /Greet someone by name/.test(asked) && /{{nodes.step_id.output}}/.test(asked), `${stub.requests.length} requests; last texts: ${stub.requests.map((r) => (r.last.kind === 'text' ? r.last.text.slice(0, 60) : r.last.kind)).join(' | ')}`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('Saved.', { exact: false }).first().waitFor({ timeout: 8000 })
  check('saving keeps it', (await page.getByRole('region', { name: 'Workflows' }).getByRole('button', { name: 'Greet people' }).count()) === 1)

  console.log('\n# Make this a workflow')
  await modes.getByRole('button', { name: 'Chat' }).click()
  await say(page, 'Greet Dana for me')
  const make = page.getByRole('button', { name: 'Make this a workflow' })
  await make.waitFor()
  check('a conversation with an answer offers it', !(await make.isDisabled()))
  await make.click()
  await page.getByRole('textbox', { name: 'Workflow name' }).waitFor({ timeout: 90_000 })
  check('it opens in the Workflows tab as an unsaved draft, renamed because that name is taken', (await page.getByRole('textbox', { name: 'Workflow name' }).inputValue()) === 'Greet people (2)' && (await page.getByText('Unsaved changes').count()) === 1)
  const fromChat = stub.requests.map((r) => (r.last.kind === 'text' ? r.last.text : '')).find((t) => /Below is a conversation/.test(t)) ?? ''
  check('the assistant was shown the conversation', /Greet Dana for me/.test(fromChat))

  console.log('\n# The assistant runs a workflow only when allowed')
  await page.evaluate(() =>
    window.celeste.core.call('workflows.save', [
      {
        name: 'Assistant greeting',
        description: 'Says hello.',
        definition: {
          nodes: [{ id: 'start', type: 'start', name: 'Start', inputs: [] }, { id: 'say', type: 'tool', name: 'Say it', tool: { kind: 'shell', command: 'echo hello-for-the-assistant' } }, { id: 'end', type: 'end', name: 'End', output: '{{nodes.say.output}}' }],
          edges: [{ from: 'start', to: 'say' }, { from: 'say', to: 'end' }]
        }
      }
    ])
  )
  // Leave the draft behind.
  await page.getByRole('button', { name: 'Back to all workflows' }).click()
  await page.getByRole('dialog', { name: 'Leave without saving?' }).getByRole('button', { name: 'Leave without saving' }).click()
  await modes.getByRole('button', { name: 'Chat' }).click()
  await page.getByText('Greet Dana for me').first().click()
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('Run the greeting workflow please')
  await box.press('Enter')
  await page.getByText(/The workflow tool said: .*not one you may run/).first().waitFor({ timeout: 60_000 })
  check('a workflow the person has not allowed is refused, and the assistant is told how to get it allowed', true)
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })

  await modes.getByRole('button', { name: 'Workflows' }).click()
  await page.getByRole('list', { name: 'Your workflows' }).getByRole('button', { name: /Assistant greeting/ }).click()
  await page.getByRole('button', { name: 'More about this workflow' }).click()
  await page.getByRole('menuitem', { name: 'Allow the assistant to run this' }).click()
  await page.getByText('Assistant may run this', { exact: true }).waitFor({ timeout: 8000 })
  check('the person allows it in the workflow’s menu, and it says so', true)

  await modes.getByRole('button', { name: 'Chat' }).click()
  await page.getByText('Greet Dana for me').first().click()
  await box.fill('Run the greeting workflow please')
  await box.press('Enter')
  const card = page.getByRole('region', { name: 'Workflow: Assistant greeting' })
  await card.getByRole('group', { name: 'Approval needed' }).waitFor({ timeout: 60_000 })
  check('now it runs, and the card that asks first appears in the conversation, listing the command', /echo hello-for-the-assistant/.test(await card.innerText()))
  mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'workflow-assistant-card.png') })
  await card.getByRole('button', { name: 'Allow and run' }).click()
  await page.getByText(/The workflow tool said: hello-for-the-assistant/).first().waitFor({ timeout: 60_000 })
  check('the assistant gets what the workflow produced', true)

  console.log('\n# Refusing the card')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
  await box.fill('Run the greeting workflow please')
  await box.press('Enter')
  const second = page.getByRole('region', { name: 'Workflow: Assistant greeting' }).nth(1)
  await second.getByRole('group', { name: 'Approval needed' }).waitFor({ timeout: 60_000 })
  await second.getByRole('button', { name: 'Cancel' }).click()
  await page.getByText(/The workflow tool said: The user did not allow the run/).first().waitFor({ timeout: 60_000 })
  check('saying no stops it, and the assistant is told not to try again', true)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'workflows-ai-failure.png') }).catch(() => undefined)
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
