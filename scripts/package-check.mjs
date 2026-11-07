// Packaged-layout check: runs the built app from an app.asar archive, the way an installer lays it out,
// and confirms the window, Core and the database all work from inside it.   npm run verify:package
// (This is not the installer. Windows and Mac installers, signing and updates are Phase 7.)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { createPackage } from '@electron/asar'
import { launch, root } from './lib/app.mjs'

/**
 * The packages the main process and Core load at run time: what package.json lists as dependencies, and what those
 * need in turn, found the way Node finds them. (The interface's libraries are bundled and are not needed.)
 */
function runtimePackages() {
  const found = new Map()
  const lookup = (name, from) => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
      if (dir === dirname(dir)) return null
    }
  }
  const visit = (name, from) => {
    // Copilot's program (about 180 MB) is not shipped: Celeste downloads it when someone connects Copilot.
    if (/^@github\/copilot-sdk-(darwin|linux|linuxmusl|win32)-/.test(name)) return
    const dir = lookup(name, from)
    if (!dir || found.has(dir)) return
    found.set(dir, name)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visit(dep, dir)
  }
  const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const dep of Object.keys(own.dependencies ?? {})) visit(dep, root)
  return [...found.keys()]
}

const work = mkdtempSync(join(tmpdir(), 'celeste-pack-'))
const stage = join(work, 'stage')
const archive = join(work, 'app.asar')
const failures = []
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

let app
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
  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })
  check('the database is created and the sample sessions are stored', true)

  await page.getByRole('textbox', { name: 'Message' }).fill('Plan the rollout')
  await page.getByRole('textbox', { name: 'Message' }).press('Enter')
  await page.getByText('go through the plan first', { exact: false }).waitFor({ timeout: 30_000 })
  check('a conversation runs and is stored', true)

  await page.getByRole('button', { name: 'New chat' }).click()
  await page.locator('input[type=file]').first().setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') })
  const img = page.locator('img[src^="celeste-file://"]').first()
  await img.waitFor({ timeout: 10_000 })
  check('attached images load through the celeste-file address', (await img.evaluate((el) => el.complete && el.naturalWidth)) === 1)
  await app.close()

  // The real Copilot, in the same layout: its program is not in the archive, so it must say so and offer to download it.
  app = await launch({ width: 1440, height: 900, theme: null, entry: archive, scripted: false })
  await app.page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  const status = await app.page.evaluate(() => window.celeste.core.call('vendor.status', ['copilot']))
  check(`Copilot reports that its program has not been downloaded (${JSON.stringify(status)})`, status.state === 'runtime-missing')
  check('the SDK loads inside the archive: models come back empty, not as an error', JSON.stringify(await app.page.evaluate(() => window.celeste.core.call('vendor.models', ['copilot']))) === '[]')
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  await app?.close().catch(() => undefined)
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    console.warn(`Could not remove ${work}`)
  }
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
