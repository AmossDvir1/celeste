// Packaged-layout check: runs the built app from an app.asar archive, the way an installer lays it out,
// and confirms the window, Core and the database all work from inside it.   npm run verify:package
// (This is not the installer. Windows and Mac installers, signing and updates are Phase 7.)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { createPackage } from '@electron/asar'
import { launch, root } from './lib/app.mjs'
import { startRegistry } from './lib/registry.mjs'
import { runtimePackages } from './lib/runtime-packages.mjs'
import { claudeReady, pasteClaudeKey, say, startStub } from './lib/stub.mjs'

const work = mkdtempSync(join(tmpdir(), 'celeste-pack-'))
const stage = join(work, 'stage')
const archive = join(work, 'app.asar')
const failures = []
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

let app
let registry
let stub
try {
  mkdirSync(join(stage, 'resources'), { recursive: true })
  cpSync(join(root, 'package.json'), join(stage, 'package.json'))
  cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true })
  const packages = runtimePackages()
  for (const dir of packages) cpSync(dir, join(stage, relative(root, dir)), { recursive: true })
  check(`the run-time libraries are included (${packages.length} packages)`, packages.some((p) => p.endsWith('ssh2')) && packages.some((p) => p.includes('modelcontextprotocol')))
  cpSync(join(root, 'resources', 'icon.png'), join(stage, 'resources', 'icon.png'))
  await createPackage(stage, archive)
  check(`the app packs into one archive (${Math.round(statSync(archive).size / 1024)} KB)`, true)

  app = await launch({ width: 1440, height: 900, theme: null, entry: archive })
  const { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  check('the window and Core start from inside the archive', true)
  await page.getByRole('button', { name: 'Skip setup' }).click()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  const boot = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  check('the database is created, empty: nothing is pretended', Array.isArray(boot.sessions) && boot.sessions.length === 0 && Object.keys(boot.vendors).length === 0)

  // Claude's program is not in this archive, so a message to Claude ends at once with the reason. It is stored like any conversation.
  const made = await page.evaluate(() => window.celeste.core.call('sessions.create', [{ vendor: 'claude', mode: 'chat', title: 'Plan the rollout', model: 'claude:default', effort: null, approval: 'auto' }]))
  await page.evaluate((id) => window.celeste.core.call('sessions.send', [id, { text: 'Plan the rollout', attachments: [] }]), made.id)
  let types = []
  for (let i = 0; i < 100 && !types.includes('turn.failed'); i++) {
    await page.waitForTimeout(200)
    types = (await page.evaluate((id) => window.celeste.core.call('sessions.get', [id]), made.id)).events.map((e) => e.event.type)
  }
  check('a conversation is stored, with the reason it could not be answered', types.includes('user.message') && types.includes('turn.failed'), types.join(', '))

  await page.getByRole('button', { name: 'New chat' }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') })
  const img = page.locator('img[src^="celeste-file://"]').first()
  await img.waitFor({ timeout: 10_000 })
  check('attached images load through the celeste-file address', (await img.evaluate((el) => el.complete && el.naturalWidth)) === 1)
  await app.close()

  // The real Copilot, in the same layout: its program is not in the archive, so it must say so and offer to download it.
  app = await launch({ width: 1440, height: 900, theme: null, entry: archive })
  await app.page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  const status = await app.page.evaluate(() => window.celeste.core.call('vendor.status', ['copilot']))
  check(`Copilot reports that its program has not been downloaded (${JSON.stringify(status)})`, status.state === 'runtime-missing')
  check('the SDK loads inside the archive: models come back empty, not as an error', JSON.stringify(await app.page.evaluate(() => window.celeste.core.call('vendor.models', ['copilot']))) === '[]')
  const claude = await app.page.evaluate(() => window.celeste.core.call('vendor.status', ['claude']))
  check(`Claude reports that its program has not been downloaded (${JSON.stringify(claude)})`, claude.state === 'runtime-missing')
  await app.close()

  // The first Connect, end to end: a key is pasted, the program is downloaded (here from a stand-in for npm that serves the real
  // program), checked, unpacked into the data folder, and then it really answers.
  console.log('\n# Connecting Claude downloads its program')
  registry = await startRegistry()
  stub = await startStub()
  app = await launch({ width: 1440, height: 900, theme: null, entry: archive, env: { ...stub.env, ...registry.env } })
  let page2 = app.page
  await page2.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await page2.getByLabel('What should we call you?').fill('Dana')
  await page2.getByRole('button', { name: 'Continue' }).click()
  await page2.getByRole('button', { name: 'Continue' }).click()
  const folder = registry.downloadedIn(app.profile)
  check('before connecting, the program is not on this computer', !existsSync(folder))
  await pasteClaudeKey(page2)
  check('the program was asked for from the registry, then downloaded', registry.requests.some((u) => /claude-agent-sdk/.test(u)) && registry.requests.includes('/program.tgz'))
  check('it is unpacked into the data folder and marked complete', existsSync(join(folder, process.platform === 'win32' ? 'claude.exe' : 'claude')) && existsSync(join(folder, '.complete')))
  const connected = await page2.evaluate(() => window.celeste.core.call('vendor.status', ['claude']))
  check(`Claude then answers as connected (${JSON.stringify(connected)})`, connected.state === 'signed-in' && /1234/.test(connected.account))
  const models = await page2.evaluate(() => window.celeste.core.call('vendor.models', ['claude']))
  check('and lists its own models, so the downloaded program really runs', models.some((m) => m.id === 'claude:default'))
  for (let i = 0; i < 2; i++) await page2.getByRole('button', { name: 'Continue' }).click()
  await page2.getByRole('button', { name: 'Start chatting' }).click()
  await claudeReady(page2)
  await say(page2, 'Hello from the packaged app')
  check('a conversation runs on the downloaded program', true)
  await app.close()
  await registry.stop()

  // A download that does not match its checksum is thrown away, and the key is not kept.
  registry = await startRegistry({ corrupt: true })
  app = await launch({ width: 1440, height: 900, theme: null, entry: archive, env: { ...stub.env, ...registry.env } })
  page2 = app.page
  await page2.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await page2.getByLabel('What should we call you?').fill('Dana')
  await page2.getByRole('button', { name: 'Continue' }).click()
  await page2.getByRole('button', { name: 'Continue' }).click()
  const card = page2.getByRole('heading', { name: 'Claude Agent', exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
  await card.getByRole('button', { name: 'Paste an API key instead' }).click()
  await card.getByLabel(/API key/).fill('sk-ant-api03-a-key-for-the-checks-1234')
  await card.getByRole('button', { name: 'Save key' }).click()
  await card.getByRole('alert').waitFor({ timeout: 60_000 })
  check('a download with the wrong checksum is refused, in words', /checksum/.test(await card.getByRole('alert').innerText()))
  check('Claude is not shown as connected', (await card.getByText(/Connected/).count()) === 0)
  check('nothing was kept from it', !existsSync(registry.downloadedIn(app.profile)))
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  await app?.close().catch(() => undefined)
  await registry?.stop().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    console.warn(`Could not remove ${work}`)
  }
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
