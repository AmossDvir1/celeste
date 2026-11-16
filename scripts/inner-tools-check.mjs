// The assistant operating Celeste itself, in the real built app (docs/plans/INNER_TOOLS_PLAN.md): it reads plugins, settings and runs; it drafts
// a workflow that the person looks over on a card (Save, Try again, Deny); it proposes a plugin whose whole command and secrets the person
// sees on a card, and that is switched on only after its test passes. A secret typed on the card reaches the program and is nowhere else.
//   npm run verify:inner-tools     (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
// The plugin is a small real MCP server (scripts/lib/mcp-fixture.mjs).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const FIXTURE = join(import.meta.dirname, 'lib', 'mcp-fixture.mjs')
const SECRET = 'inner-tools-secret-5d2e9b'
const TOOL = (name) => `mcp__celeste-devices__${name}`

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
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: `${r.last.isError ? 'It failed' : 'The tool said'}: ${r.last.text}` }]
  const text = r.last.text
  // The assistant Celeste asks to draft a workflow (an agent step of its own).
  if (/Make a workflow for this/.test(text)) return [{ type: 'text', text: spec(/asked for these changes/.test(text) ? 'Greet people twice' : 'Greet people') }]
  const call = (name, input) => [{ type: 'tool_use', name: TOOL(name), input }]
  if (/LIST THE PLUGINS/.test(text)) return call('plugin_list', {})
  if (/READ THE SETTINGS/.test(text)) return call('settings_read', {})
  if (/DRAFT A WORKFLOW/.test(text)) return call('workflow_draft', { description: 'Greet someone by name and keep a note of it' })
  if (/INSTALL A PLUGIN/.test(text)) return call('plugin_install', { name: 'Fixture tools', type: 'stdio', command: process.execPath, args: [FIXTURE], source: 'scripts/lib/mcp-fixture.mjs', enabled: true })
  if (/INSTALL A BROKEN PLUGIN/.test(text)) return call('plugin_install', { name: 'Broken tools', type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] })
  if (/INSTALL A SECRET PLUGIN/.test(text)) return call('plugin_install', { name: 'Secret tools', type: 'stdio', command: process.execPath, args: [FIXTURE], envNames: ['FIXTURE_TOKEN'], source: 'scripts/lib/mcp-fixture.mjs' })
  if (/INSTALL A DENIED PLUGIN/.test(text)) return call('plugin_install', { name: 'Denied tools', type: 'stdio', command: process.execPath, args: [FIXTURE] })
  if (/USE THE SECRET PLUGIN/.test(text)) return [{ type: 'tool_use', name: 'mcp__secret-tools__whoami', input: {} }]
  return [{ type: 'text', text: `Echo: ${text}. The canary hosts go first.` }]
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-inner-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const idle = (page) => page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 90_000 })
const send = async (page, text) => {
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await box.press('Enter')
}
const core = (page, method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])

/** Every file under the profile that contains this text, in the clear. */
function filesWith(dir, text) {
  const found = []
  const needle = Buffer.from(text)
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        try {
          if (statSync(p).size < 80_000_000 && readFileSync(p).includes(needle)) found.push(p)
        } catch {
          /* in use by the app: not something we can read, so not a leak we can see */
        }
      }
    }
  }
  walk(dir)
  return found
}

let stub
let app
try {
  stub = await startStub(script)
  // Copilot knows no one here, so the assistant that drafts a workflow is the stand-in and never the real account on this computer.
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

  console.log('\n# Reading')
  await send(page, 'LIST THE PLUGINS')
  await page.getByText(/The tool said: No plugins are added/).first().waitFor({ timeout: 60_000 })
  check('the assistant is told there are no plugins yet', true)
  await idle(page)
  await send(page, 'READ THE SETTINGS')
  await page.getByText(/The tool said: \{/).first().waitFor({ timeout: 60_000 })
  check('it reads the settings (and one tool call needed no card)', (await page.getByRole('group', { name: 'Approval needed' }).count()) === 0)
  await idle(page)

  console.log('\n# A workflow drafted, and looked over')
  await send(page, 'DRAFT A WORKFLOW')
  const draft = page.getByRole('group', { name: 'Save this workflow?' })
  await draft.waitFor({ timeout: 90_000 })
  const shown = await draft.innerText()
  check('a card shows the name, the steps and what it asks for', /Greet people/.test(shown) && /Write the note/.test(shown) && /Say hello/.test(shown) && /echo hello-from-a-draft/.test(shown) && /who \(text\)/.test(shown), shown)
  check('it has Save, Try again and Deny', (await draft.getByRole('button', { name: 'Save', exact: true }).count()) === 1 && (await draft.getByRole('button', { name: 'Try again', exact: true }).count()) === 1 && (await draft.getByRole('button', { name: 'Deny', exact: true }).count()) === 1)
  check('nothing is saved while it waits', (await core(page, 'workflows.list')).length === 0)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'inner-tools-workflow-card.png') })

  await draft.getByRole('button', { name: 'Try again', exact: true }).click()
  await draft.getByRole('textbox', { name: 'What should be different?' }).fill('only on weekdays')
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  const second = page.getByRole('group', { name: 'Save this workflow?' })
  await page.getByText('You asked for another try').waitFor({ timeout: 90_000 })
  await second.getByText('Greet people twice').waitFor({ timeout: 90_000 })
  check('Try again drafts another, and the first card says it was sent back', (await page.getByText('You asked for another try').count()) === 1)
  const redo = stub.requests.map((r) => (r.last.kind === 'text' ? r.last.text : '')).find((t) => /asked for these changes/.test(t)) ?? ''
  check('the draft was told what to change, in the person’s words', /only on weekdays/.test(redo))
  check('still nothing is saved', (await core(page, 'workflows.list')).length === 0)
  await second.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText(/The tool said: Saved as “Greet people twice”/).first().waitFor({ timeout: 60_000 })
  const listed = await core(page, 'workflows.list')
  check('Save keeps it, and the assistant is told', listed.length === 1 && listed[0].name === 'Greet people twice')
  check('the card says what happened', (await page.getByText('You saved').count()) === 1)
  await idle(page)

  await send(page, 'DRAFT A WORKFLOW')
  const third = page.getByRole('group', { name: 'Save this workflow?' })
  await third.waitFor({ timeout: 90_000 })
  await third.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.getByText(/The tool said: The user did not save it/).first().waitFor({ timeout: 60_000 })
  check('Deny saves nothing, and the assistant is told not to try again', (await core(page, 'workflows.list')).length === 1)
  await idle(page)

  console.log('\n# A plugin, with the whole command on the card')
  await send(page, 'INSTALL A PLUGIN')
  const plugin = page.getByRole('group', { name: 'Install this plugin?' })
  await plugin.waitFor({ timeout: 90_000 })
  const pluginText = await plugin.innerText()
  check('the card shows the whole command line and where it came from', pluginText.includes(FIXTURE) && /came from: scripts\/lib\/mcp-fixture\.mjs/.test(pluginText), pluginText)
  check('nothing is installed while it waits', (await core(page, 'mcp.list')).length === 0)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'inner-tools-plugin-card.png') })
  await plugin.getByRole('button', { name: 'Install', exact: true }).click()
  await page.getByText(/The tool said: Installed and switched on/).first().waitFor({ timeout: 90_000 })
  let servers = await core(page, 'mcp.list')
  check('Install saves it, tests it, and switches it on once the test passed', servers.length === 1 && servers[0].name === 'Fixture tools' && servers[0].enabled === true && servers[0].status.state === 'ok', JSON.stringify(servers))
  await idle(page)

  await send(page, 'LIST THE PLUGINS')
  await page.getByText(/Fixture tools \(program\): on, last test passed \(4 tools\)/).first().waitFor({ timeout: 60_000 })
  check('plugin_list now shows it, with its test', true)
  await idle(page)

  await send(page, 'INSTALL A BROKEN PLUGIN')
  const broken = page.getByRole('group', { name: 'Install this plugin?' }).last()
  await broken.getByRole('button', { name: 'Install', exact: true }).waitFor({ timeout: 90_000 })
  await broken.getByRole('button', { name: 'Install', exact: true }).click()
  await page.getByText(/It failed: “Broken tools” is saved but switched off, because its test did not pass/).first().waitFor({ timeout: 90_000 })
  servers = await core(page, 'mcp.list')
  check('a plugin whose test fails is saved, left off, and the assistant is told why', servers.find((s) => s.name === 'Broken tools')?.enabled === false)
  await idle(page)

  await send(page, 'INSTALL A DENIED PLUGIN')
  const denied = page.getByRole('group', { name: 'Install this plugin?' }).last()
  await denied.getByRole('button', { name: 'Deny', exact: true }).waitFor({ timeout: 90_000 })
  await denied.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.getByText(/The tool said: The user did not install it/).first().waitFor({ timeout: 60_000 })
  check('Deny installs nothing', !(await core(page, 'mcp.list')).some((s) => s.name === 'Denied tools'))
  await idle(page)

  console.log('\n# A plugin with a secret')
  await send(page, 'INSTALL A SECRET PLUGIN')
  const secretCard = page.getByRole('group', { name: 'Install this plugin?' }).last()
  await secretCard.getByLabel('FIXTURE_TOKEN').waitFor({ timeout: 90_000 })
  check('the card asks for the secret by name, in a hidden box', (await secretCard.getByLabel('FIXTURE_TOKEN').getAttribute('type')) === 'password')
  check('and Install waits until it is typed', await secretCard.getByRole('button', { name: 'Install', exact: true }).isDisabled())
  await secretCard.getByLabel('FIXTURE_TOKEN').fill(SECRET)
  check('then it can be pressed', await secretCard.getByRole('button', { name: 'Install', exact: true }).isEnabled())
  await secretCard.getByRole('button', { name: 'Install', exact: true }).click()
  await page.getByText(/The tool said: Installed and switched on/).nth(1).waitFor({ timeout: 90_000 })
  servers = await core(page, 'mcp.list')
  const secretServer = servers.find((s) => s.name === 'Secret tools')
  check('it is installed and on', secretServer?.enabled === true && secretServer.status.state === 'ok', JSON.stringify(secretServer))
  check('the value is in the secret store', await page.evaluate((id) => window.celeste.secrets.has(`mcp.${id}.env.FIXTURE_TOKEN`), secretServer?.id))
  await idle(page)

  console.log('\n# The secret goes nowhere else')
  check('the assistant never saw it', !JSON.stringify(stub.requests.map((r) => r.body)).includes(SECRET))
  const sessions = (await core(page, 'app.bootstrap')).sessions
  const logs = JSON.stringify(await Promise.all(sessions.map((s) => core(page, 'sessions.get', s.id))))
  check('it is not in the chat’s log', !logs.includes(SECRET) && logs.includes('FIXTURE_TOKEN'))
  await app.close()
  const leaks = filesWith(profile, SECRET)
  check('it is not in the data folder in the clear', leaks.length === 0, leaks.join(', '))

  console.log('\n# It reaches the program, and it all survives a restart')
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
  const p2 = app.page
  await p2.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 })
  await claudeReady(p2)
  await p2.keyboard.press('Control+n')
  await p2.getByRole('heading', { level: 1 }).first().waitFor()
  await send(p2, 'USE THE SECRET PLUGIN')
  await p2.getByText(`The tool said: token=${SECRET}`).first().waitFor({ timeout: 60_000 })
  check('a new chat’s assistant uses the new plugin, and the typed secret arrived in the program’s environment', true)
  const after = await core(p2, 'mcp.list')
  check('both installed plugins are still there, on, and the broken one still off', after.filter((s) => s.enabled).map((s) => s.name).sort().join() === 'Fixture tools,Secret tools' && after.find((s) => s.name === 'Broken tools')?.enabled === false)
  check('and the saved workflow', (await core(p2, 'workflows.list')).length === 1)
  await idle(p2)

  console.log('\n# Stop ends a card nobody answered')
  // In a chat of its own: after a Stop, Claude Code answers the cut-off call at the next message, which the stand-in's script does not expect.
  await p2.keyboard.press('Control+n')
  await p2.getByRole('heading', { level: 1 }).first().waitFor()
  await send(p2, 'DRAFT A WORKFLOW')
  await p2.getByRole('group', { name: 'Save this workflow?' }).waitFor({ timeout: 90_000 })
  await p2.getByRole('button', { name: 'Stop', exact: true }).click()
  await p2.getByText('You stopped this response.').waitFor({ timeout: 60_000 })
  await idle(p2)
  check('Stop saves nothing', (await core(p2, 'workflows.list')).length === 1)
  check('and the card no longer asks', (await p2.getByRole('button', { name: 'Save', exact: true }).count()) === 0 && (await p2.getByText('You denied').count()) === 1)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'inner-tools-failure.png') }).catch(() => undefined)
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
