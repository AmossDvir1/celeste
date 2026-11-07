// Phase 3 acceptance test, in the real built app, against an in-process SSH server that stands in for a VM:
// add a device, confirm its key, attach it to a chat, run a command through the approval card, take a snapshot,
// refuse a changed host key, and check that nothing is lost across a restart.   npm run verify:devices
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { startSshFixture } from './lib/ssh-fixture.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-devices-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

let fixture
let app
const open = () => launch({ width: 1440, height: 900, theme: null, profile })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const openDevices = async (page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'Devices').click()
}
const closeSettings = (page) => page.keyboard.press('Escape')
/** The assistant finished its turn: the Stop button is gone. */
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 30_000 })

try {
  fixture = await startSshFixture({ os: 'linux' })
  const app1 = join(fixture.root, 'home', 'dev', 'app')
  mkdirSync(join(app1, 'src'), { recursive: true })
  mkdirSync(join(app1, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(app1, 'package.json'), '{"name":"app"}')
  writeFileSync(join(app1, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(app1, 'node_modules', 'dep', 'index.js'), 'junk')

  // ---- Add a device -----------------------------------------------------------------------------------
  console.log('\n# Adding a device')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })

  await openDevices(page)
  check('Settings has a Devices section, empty at first', (await page.getByText('No devices yet').count()) > 0)
  await page.getByRole('button', { name: 'Add a device' }).first().click()
  await page.getByLabel('Address or name').fill(fixture.host)
  await page.getByLabel('Port').fill(String(fixture.port))
  await page.getByLabel('Name to show').fill('fixture-vm')
  await page.getByLabel('User name').fill('dev')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Connect' }).click()

  await page.getByText('Is this the right computer?').waitFor({ timeout: 20_000 })
  check('a new computer is not trusted until you confirm it', fixture.commands.length === 0)
  check('the dialog shows the real fingerprint of that computer', (await page.locator('code').first().innerText()) === fixture.fingerprint)
  await page.getByRole('button', { name: 'Yes, trust it' }).click()
  await page.getByText(/Connected to/).waitFor({ timeout: 20_000 })
  check('it connects and learns what the computer is', (await page.getByText(/fixture-host.*fixture-user|fixture-user/).count()) > 0 && (await page.getByText('Linux').count()) > 0)
  check('a new device defaults to read only', (await page.getByRole('radio', { name: /Read only/ }).getAttribute('aria-checked')) === 'true')
  await page.getByRole('radio', { name: /Ask first/ }).click()
  await page.getByRole('button', { name: 'Add device', exact: true }).click()
  await page.getByRole('heading', { name: 'fixture-vm' }).waitFor({ timeout: 10_000 })
  check('the device is listed with its access level', (await page.getByText('Ask first').count()) > 0)
  await closeSettings(page)

  // ---- Use it from a chat -----------------------------------------------------------------------------
  console.log('\n# Using it from a chat')
  await textbox(page).fill('Hello there')
  await textbox(page).press('Enter')
  await page.getByText('go through the plan first', { exact: false }).waitFor({ timeout: 30_000 })
  await idle(page)
  await page.getByRole('button', { name: 'Tools & Integrations' }).first().click()
  const toggle = page.getByRole('switch', { name: 'fixture-vm attached to this chat' })
  await toggle.waitFor()
  check('a device is not attached to a chat until you attach it', (await toggle.getAttribute('aria-checked')) === 'false')
  await toggle.click()
  await page.locator('header', { hasText: 'Hello there' }).getByText('fixture-vm').waitFor({ timeout: 10_000 })
  check('an attached device shows in the chat header', true)

  await textbox(page).fill('Check disk space on my device')
  await textbox(page).press('Enter')
  const card = page.getByRole('group', { name: 'Approval needed' })
  await card.waitFor({ timeout: 30_000 })
  const cardText = await card.innerText()
  check('the approval card names the device and shows the exact command', cardText.includes('Run on fixture-vm?') && cardText.includes('uname -a; df -h /'))
  check('there is no way to allow it for the whole session', (await card.getByRole('button', { name: 'Allow for this session' }).count()) === 0)
  check('nothing ran before approval', fixture.commands.every((c) => !c.includes('df -h')))
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.getByText('Here is what', { exact: false }).waitFor({ timeout: 30_000 })
  check('the command ran on the device after approval', fixture.commands.includes('uname -a; df -h /'))
  await idle(page)
  check('the assistant reports what it found', (await page.getByText('Filesystem', { exact: false }).count()) > 0)

  // A declined command is not run.
  const before = fixture.commands.length
  await textbox(page).fill('Check disk space on my device again')
  await textbox(page).press('Enter')
  await card.waitFor({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Deny' }).click()
  await page.getByText('The user declined', { exact: false }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('a declined command is not run', fixture.commands.length === before)

  // ---- Read only --------------------------------------------------------------------------------------
  console.log('\n# Read only')
  await openDevices(page)
  await page.getByLabel('Access level for fixture-vm').selectOption('read')
  await closeSettings(page)
  const afterDecline = fixture.commands.length
  await textbox(page).fill('What is on my device?')
  await textbox(page).press('Enter')
  await page.getByText('is read only, so I only looked', { exact: false }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('a read only device is looked at, never run on', fixture.commands.length === afterDecline && (await card.count()) === 0)

  // ---- Folders ----------------------------------------------------------------------------------------
  console.log('\n# A folder as context')
  await openDevices(page)
  await page.getByRole('button', { name: /Folders and activity/ }).click()
  await page.getByRole('button', { name: 'Add a folder' }).click()
  const picker = page.getByRole('dialog', { name: /Add a folder from fixture-vm/ })
  await picker.getByLabel('Folder path').fill('/home/dev/app')
  await picker.getByLabel('Folder path').press('Enter')
  await picker.getByText('src', { exact: true }).waitFor({ timeout: 10_000 })
  check('the folder picker lists what is on the device', (await picker.getByText('package.json').count()) > 0)
  await picker.getByRole('button', { name: 'Copy this folder' }).click()
  await page.getByText(/Snapshot · 2 files/).waitFor({ timeout: 20_000 })
  check('a snapshot copies the folder, without build folders', true)
  const devicesDir = join(profile, 'devices')
  const copies = readdirSync(devicesDir).flatMap((d) => readdirSync(join(devicesDir, d)).map((f) => join(devicesDir, d, f)))
  const snapshot = copies.find((p) => existsSync(join(p, 'src', 'index.ts')))
  check('the copy is on this computer', !!snapshot && readFileSync(join(snapshot, 'src', 'index.ts'), 'utf8') === 'export const x = 1\n')
  check('node_modules was left out', !!snapshot && !existsSync(join(snapshot, 'node_modules')))
  await closeSettings(page)

  // ---- A changed host key -----------------------------------------------------------------------------
  console.log('\n# The computer’s identity changes')
  const { port } = fixture
  await fixture.close()
  fixture = await startSshFixture({ os: 'linux', port })
  await openDevices(page)
  await page.getByRole('button', { name: 'Test', exact: true }).click()
  await page.getByText('This computer’s identity has changed').waitFor({ timeout: 20_000 })
  check('a changed key is refused, and the warning says so', true)
  check('nothing was sent to the impostor', fixture.commands.length === 0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await closeSettings(page)
  await app.close()

  // ---- After a restart --------------------------------------------------------------------------------
  console.log('\n# After a restart')
  app = await open()
  page = app.page
  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })
  await openDevices(page)
  await page.getByRole('heading', { name: 'fixture-vm' }).waitFor({ timeout: 10_000 })
  check('the device is still there, as read only', (await page.getByText('Read only').count()) > 0)
  await closeSettings(page)
  await page.getByRole('button', { name: /^Hello there/ }).click()
  await page.locator('header', { hasText: 'Hello there' }).getByText('fixture-vm').waitFor({ timeout: 10_000 })
  check('the chat still has the device attached', true)

  const secretsFile = join(profile, 'secrets.json')
  const stored = existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : ''
  check('the password is stored, and not as readable text', /device\.dev-/.test(stored) && !/secret/i.test(stored))

  // ---- Remove -----------------------------------------------------------------------------------------
  console.log('\n# Removing the device')
  await openDevices(page)
  await page.getByRole('button', { name: 'Remove fixture-vm' }).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByText('No devices yet').waitFor({ timeout: 10_000 })
  check('the device is gone', true)
  check('its copies are gone', !existsSync(devicesDir) || readdirSync(devicesDir).length === 0)
  const after = existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : ''
  check('its password is gone', !/device\.dev-/.test(after))
  await closeSettings(page)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  await app?.close().catch(() => undefined)
  await fixture?.close().catch(() => undefined)
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    console.warn(`Could not remove ${profile}`)
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
