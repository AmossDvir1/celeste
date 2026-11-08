// Phase 6 check, in the real built app: the tools a person adds (MCP servers). Add a program, with a secret variable; see that it is
// started and its tools listed; see a broken one say why; paste a configuration; change and remove tools; switch one off. Then the
// assistant really calls a tool through Claude's real program, with the secret arriving in the tool's environment, and the secret
// is nowhere on disk in the clear. Everything survives a restart.   npm run verify:mcp
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
// The tool is a small real MCP server (scripts/lib/mcp-fixture.mjs).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, startStub } from './lib/stub.mjs'

const FIXTURE = join(import.meta.dirname, 'lib', 'mcp-fixture.mjs')
const SECRET = 'token-from-the-window-7f3a91'
const PASTED_SECRET = 'pasted-token-c41d08'

/** What the stand-in's Claude does: calls a tool when asked to, and reports what the tool answered. */
const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: r.last.isError ? `That did not work: ${r.last.text}` : `Tool said: ${r.last.text}` }]
  if (/use the fixture tool/i.test(r.last.text)) return [{ type: 'tool_use', name: 'mcp__fixture-tools__whoami', input: {} }]
  if (/use the pasted tool/i.test(r.last.text)) return [{ type: 'tool_use', name: 'mcp__pasted-a__whoami', input: {} }]
  return echo(r)
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-mcp-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
const card = (page, name) => page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) }).first()

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
          /* in use by the app, or a link to nothing: not something we can read, so not a leak we can see */
        }
      }
    }
  }
  walk(dir)
  return found
}

async function open(stub) {
  const app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  await app.page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 })
  return app
}
async function openTools(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'Tools & Integrations').click()
}
async function closeSettings(page) {
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached', timeout: 10_000 })
}
/** Sends a message, and says yes if the assistant asks first. Waits for the turn to end. */
async function ask(page, text) {
  await textbox(page).fill(text)
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 15_000 })
  const end = Date.now() + 90_000
  while (await page.getByRole('button', { name: 'Stop' }).count()) {
    const allow = page.getByRole('button', { name: 'Allow', exact: true })
    if (await allow.count()) await allow.first().click()
    if (Date.now() > end) throw new Error('The turn did not end.')
    await page.waitForTimeout(250)
  }
}

let stub
let app
try {
  stub = await startStub(script)
  app = await open(stub)
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await pasteClaudeKey(page)
  await closeSettings(page)
  await claudeReady(page)

  console.log('\n# Adding a program')
  await openTools(page)
  check('Settings has a Tools section, empty at first', (await page.getByText('No tools added').count()) === 1)
  await page.getByRole('button', { name: 'Add a tool' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a tool' })
  await dialog.getByPlaceholder('Internal wiki').fill('Fixture tools')
  await dialog.getByPlaceholder('npx').fill(process.execPath)
  await dialog.getByLabel('Arguments').fill(`"${FIXTURE}"`)
  await dialog.getByRole('button', { name: 'Add' }).first().click()
  await dialog.getByPlaceholder('API_TOKEN').fill('FIXTURE_TOKEN')
  await dialog.getByLabel('Value of FIXTURE_TOKEN').fill(SECRET)
  await dialog.getByRole('button', { name: 'Add tool' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  const fixture = card(page, 'Fixture tools')
  await fixture.getByText('Working · 4 tools').waitFor({ timeout: 60_000 })
  check('it is started, and says how many tools it offers', true)
  await fixture.getByRole('button', { name: 'Show the tools it offers' }).click()
  const offered = await fixture.innerText()
  check('and lists them with what they do', /shout/.test(offered) && /Answers the text in capital letters/.test(offered) && /whoami/.test(offered), offered)
  check('the list shows the program, not the secret', !(await page.locator('body').innerText()).includes(SECRET))

  console.log('\n# Mistakes are named')
  await page.getByRole('button', { name: 'Add a tool' }).first().click()
  await dialog.getByPlaceholder('Internal wiki').fill('fixture TOOLS')
  await dialog.getByPlaceholder('npx').fill('node')
  await dialog.getByRole('button', { name: 'Add tool' }).click()
  await dialog.getByText('Another tool already has that name.').waitFor({ timeout: 10_000 })
  check('a name that is taken is refused, in the dialog', true)
  await dialog.getByPlaceholder('Internal wiki').fill('Celeste Devices')
  await dialog.getByRole('button', { name: 'Add tool' }).click()
  await dialog.getByText(/Celeste’s own tool server/).waitFor({ timeout: 10_000 })
  check('Celeste’s own tool server name is refused', true)
  await dialog.getByPlaceholder('Internal wiki').fill('Broken')
  await dialog.getByPlaceholder('npx').fill('definitely-not-a-program-xyz')
  await dialog.getByRole('button', { name: 'Add tool' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  const broken = card(page, 'Broken')
  await broken.getByText('Not working').waitFor({ timeout: 60_000 })
  check('a program that does not exist is saved, and says it does not work', ((await broken.innerText()).length > 40))
  console.log(`      says: ${(await broken.innerText()).replace(/\s+/g, ' ').slice(0, 160)}`)

  console.log('\n# Changing a tool')
  await fixture.getByRole('button', { name: 'Change' }).click()
  const change = page.getByRole('dialog', { name: 'Change Fixture tools' })
  const hint = change.getByLabel('Value of FIXTURE_TOKEN')
  await hint.waitFor()
  check('the secret is not shown again, but the dialog says one is saved', (await hint.getAttribute('placeholder')) === 'Saved. Leave empty to keep it.' && (await hint.inputValue()) === '')
  await change.getByRole('button', { name: 'Cancel' }).click()
  await broken.getByRole('button', { name: 'Change' }).click()
  const fix = page.getByRole('dialog', { name: 'Change Broken' })
  await fix.getByPlaceholder('npx').fill(process.execPath)
  await fix.getByLabel('Arguments').fill(`"${FIXTURE}"`)
  await fix.getByRole('button', { name: 'Save' }).click()
  await broken.getByText('Working · 4 tools').waitFor({ timeout: 60_000 })
  check('fixing the program makes it work', true)

  console.log('\n# Pasting a configuration')
  await page.getByRole('button', { name: 'Paste a configuration' }).click()
  const paste = page.getByRole('dialog', { name: 'Paste a configuration' })
  await paste.getByLabel('Configuration').fill('this is not json')
  await paste.getByText('That is not valid JSON.').waitFor()
  check('text that is not JSON is called that', (await paste.getByRole('button', { name: 'Add tool' }).isDisabled()) === true)
  const config = { mcpServers: { 'pasted-a': { command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: PASTED_SECRET } }, 'pasted-b': { url: 'ftp://nope' } } }
  await paste.getByLabel('Configuration').fill(JSON.stringify(config))
  await paste.getByText(/Found 1 tool: pasted-a/).waitFor()
  check('it names what it found, and what it left out and why', (await paste.getByText(/pasted-b: needs a command or a web address/).count()) === 1)
  await paste.getByRole('button', { name: 'Add tool' }).click()
  await paste.waitFor({ state: 'detached', timeout: 15_000 })
  await card(page, 'pasted-a').getByText('Working · 4 tools').waitFor({ timeout: 60_000 })
  check('a pasted tool is added, with its variable stored, and works', true)

  console.log('\n# Removing a tool')
  await broken.getByRole('button', { name: 'Remove Broken' }).click()
  const asking = page.getByRole('dialog', { name: 'Remove Broken?' })
  await asking.getByRole('button', { name: 'Cancel' }).click()
  check('removing asks first, and cancelling keeps it', (await page.getByText('Broken', { exact: true }).count()) === 1)
  await broken.getByRole('button', { name: 'Remove Broken' }).click()
  await asking.getByRole('button', { name: 'Remove' }).click()
  await page.getByText('Broken', { exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
  check('it is gone from the list', true)

  console.log('\n# Secrets stay secret')
  const leaks = [...filesWith(profile, SECRET), ...filesWith(profile, PASTED_SECRET)]
  check('neither secret is anywhere in the data folder in the clear', leaks.length === 0, leaks.join(', '))

  console.log('\n# The assistant uses a tool')
  await card(page, 'pasted-a').getByRole('switch', { name: 'pasted-a on' }).click()
  await card(page, 'pasted-a').getByText('Off', { exact: true }).waitFor({ timeout: 10_000 })
  check('a tool can be switched off', true)
  await closeSettings(page)
  await ask(page, 'Please use the fixture tool')
  await page.getByText(`Tool said: token=${SECRET}`).first().waitFor({ timeout: 30_000 })
  check('the assistant calls the tool, and the secret reached the program’s environment', true)
  await page.getByRole('button', { name: /^Used 1 tool/ }).first().click()
  check('the call shows in the chat as a tool step, named by the tool and its server', (await page.getByText('fixture-tools: whoami').count()) >= 1)
  await ask(page, 'Now use the pasted tool')
  await page.getByText(/That did not work/).first().waitFor({ timeout: 30_000 })
  check('a tool that is switched off is not given to the assistant', true)

  console.log('\n# Tools panel, and a new chat gets the change')
  await page.getByRole('button', { name: 'Tools & Integrations' }).first().click()
  const panel = page.getByRole('region', { name: 'Tools' })
  await panel.waitFor()
  const panelText = await panel.innerText()
  check('the panel lists the tools with their state', /Fixture tools/.test(panelText) && /pasted-a/.test(panelText) && /Off/.test(panelText), panelText)
  await panel.getByRole('switch', { name: 'pasted-a on' }).click()
  await panel.getByText('Working · 4 tools').nth(1).waitFor({ timeout: 10_000 }).catch(() => undefined)
  await page.keyboard.press('Control+n')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await ask(page, 'Please use the pasted tool')
  await page.getByText(`Tool said: token=${PASTED_SECRET}`).first().waitFor({ timeout: 30_000 })
  check('switched on again, a new chat uses it, with the variable that came from the pasted configuration', true)

  console.log('\n# After a restart')
  await app.close()
  app = await open(stub)
  page = app.page
  await openTools(page)
  const again = card(page, 'Fixture tools')
  await again.waitFor({ timeout: 20_000 })
  check('the tools are still listed, as they were left', (await card(page, 'pasted-a').getByText('Off', { exact: true }).count()) === 0 && (await page.getByText('Broken', { exact: true }).count()) === 0)
  check('a tool is not started just by opening the app', (await again.getByText('Not checked').count()) === 1)
  await again.getByRole('button', { name: 'Check again' }).click()
  await again.getByText('Working · 4 tools').waitFor({ timeout: 60_000 })
  check('checking again works, so the secret survived the restart', true)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'mcp-settings.png') })
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'mcp-failure.png') }).catch(() => undefined)
} finally {
  await app?.app.close().catch(() => undefined)
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
