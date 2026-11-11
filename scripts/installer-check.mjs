// The installed app, really run. On Windows: runs the setup program silently into a temporary folder, looks at what it laid down, starts the
// installed Celeste (not the one in the project), makes sure the window, Core, the database and the terminal's pty work from the install,
// then uninstalls it and checks that the person's data is left alone.   node scripts/installer-check.mjs [path to the setup .exe]
// On a Mac: starts the packed Celeste.app that `npm run dist:mac` left in release/ and makes the same checks of it (the disk image is
// not opened). `npm run dist:win` or `dist:mac` makes the installer first.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listPackage } from '@electron/asar'
import { _electron as electron } from 'playwright-core'
import { root } from './lib/app.mjs'

const win = process.platform === 'win32'
if (!win && process.platform !== 'darwin') {
  console.log('This check runs the packed app of Windows or macOS, so it only runs on those.')
  process.exit(0)
}

const version = JSON.parse((await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8')).version
const setup = resolve(process.argv[2] ?? join(root, 'release', `Celeste-${version}-windows-x64-setup.exe`))
const macApp = ['mac-arm64', 'mac'].map((d) => join(root, 'release', d, 'Celeste.app')).find((p) => existsSync(p))
const work = mkdtempSync(join(tmpdir(), 'celeste-install-'))
const home = join(work, 'Celeste')
const profile = join(work, 'profile')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const size = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)

// Nothing here should take minutes: if something hangs (a setup waiting for an answer, a window that never opens) say so and stop.
setTimeout(() => {
  console.log('FAIL  the check took longer than 6 minutes, so something is stuck')
  process.exit(2)
}, 360_000).unref()

let app
try {
  check(win ? 'the setup program is there' : 'the packed app is there', win ? existsSync(setup) : Boolean(macApp), win ? setup : 'run `npm run dist:mac` first')
  console.log('\n# Installing')
  // /S is silent; /D= is where to, and must be the last argument, unquoted.
  if (win) execFileSync(setup, ['/S', `/D=${home}`], { timeout: 180_000 })
  const exe = win ? join(home, 'Celeste.exe') : join(macApp, 'Contents', 'MacOS', 'Celeste')
  check(win ? 'it installs Celeste where it was told' : 'the app has its program', existsSync(exe))
  const res = win ? join(home, 'resources') : join(macApp, 'Contents', 'Resources')
  check('with the app in one archive', existsSync(join(res, 'app.asar')))
  check('the terminal’s pty is outside the archive, where it can run', existsSync(join(res, 'app.asar.unpacked', 'node_modules', '@lydell')))
  check('koffi’s binary, which sends the mouse and keyboard of desktop control, is outside the archive too', existsSync(join(res, 'app.asar.unpacked', 'node_modules', '@koromix')))
  check('node-datachannel’s binary, for the direct link from a phone, is outside the archive too', existsSync(join(res, 'app.asar.unpacked', 'node_modules', '@node-datachannel')))
  check('the licence, the notices of other people’s software and the privacy statement come with it', ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md'].every((f) => existsSync(join(res, f))))
  check('Electron’s own licences are there', win ? existsSync(join(home, 'LICENSE.electron.txt')) && existsSync(join(home, 'LICENSES.chromium.html')) : true)
  const packed = listPackage(join(res, 'app.asar'))
  check('the vendors’ large programs are not in it: they are downloaded when a vendor is connected', !packed.some((p) => /claude-agent-sdk-(darwin|linux|win32)|copilot-sdk-(darwin|linux|win32)/.test(p)) && !existsSync(join(res, 'app.asar.unpacked', 'node_modules', '@github')))
  check('the libraries are in the archive (' + packed.length + ' files)', packed.some((p) => /ssh2/.test(p)) && packed.some((p) => /modelcontextprotocol/.test(p)))
  const mb = Math.round(size(win ? home : macApp) / 1024 / 1024)
  check(`it is a sensible size (${mb} MB)`, mb > 150 && mb < 700)
  if (win) check('there is an uninstaller', existsSync(join(home, 'Uninstall Celeste.exe')))

  console.log('\n# Starting the installed Celeste')
  mkdirSync(profile, { recursive: true })
  app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`], env: { ...process.env, CELESTE_NO_OWN_PROGRAMS: '1', ELECTRON_RENDERER_URL: '' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 60_000 })
  check('the window opens on the setup', true)
  await page.getByRole('button', { name: 'Skip setup' }).click()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 })
  const boot = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  check(`Core runs and says which version this is (${boot.version})`, boot.version === version)
  check('the database is created, empty', Array.isArray(boot.sessions) && boot.sessions.length === 0)
  check('the data is kept in the data folder given, not in the install', existsSync(join(profile, 'celeste.db')))

  // The pty comes from the unpacked folder: a shell has to start from the install.
  const project = join(work, 'project')
  mkdirSync(project)
  const session = await page.evaluate((cwd) => window.celeste.core.call('sessions.create', [{ vendor: 'claude', mode: 'develop', title: 'Install check', model: 'claude:default', effort: null, approval: 'auto', cwd }]), project)
  await page.evaluate(() => {
    window.__seen = ''
    window.celeste.core.onPush((p) => {
      if (p.type === 'terminal') window.__seen += p.data
    })
  })
  await page.evaluate((id) => window.celeste.core.call('terminal.open', [id, 80, 24]), session.id)
  await page.waitForTimeout(1500)
  await page.evaluate((id) => window.celeste.core.call('terminal.write', [id, 'echo installed-shell-$((6*7))\r']), session.id)
  await page.evaluate((id) => window.celeste.core.call('terminal.write', [id, 'echo installed-shell-$(6*7)\r']), session.id)
  let seen = ''
  for (let i = 0; i < 100 && !/installed-shell-42/.test(seen); i++) {
    await page.waitForTimeout(150)
    seen = (await page.evaluate(() => window.__seen)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  }
  check('a terminal starts from the install (the pty works outside the archive)', /installed-shell-42/.test(seen), seen.slice(-200))
  await page.evaluate((id) => window.celeste.core.call('terminal.close', [id]), session.id)
  await app.close()
  app = undefined

  if (win) {
    console.log('\n# Uninstalling')
    writeFileSync(join(profile, 'marker.txt'), 'my data')
    // The uninstaller copies itself aside and finishes on its own, so wait for the program to go. (Running it in place with _?= would leave
    // the system's record of the install behind, and the next setup would wait for an uninstaller that is no longer there.)
    execFileSync(join(home, 'Uninstall Celeste.exe'), ['/S'], { timeout: 180_000 })
    for (let i = 0; i < 120 && existsSync(exe); i++) await new Promise((r) => setTimeout(r, 500))
    await new Promise((r) => setTimeout(r, 1500))
    check('it takes Celeste away', !existsSync(exe) && !existsSync(join(home, 'resources', 'app.asar')))
    // `reg query` exits with an error when it finds nothing, which here is the good answer.
    const regQuery = (...a) => {
      try {
        return execFileSync(...a)
      } catch (err) {
        return String(err.stdout ?? '')
      }
    }
    const records = regQuery('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Celeste', '/d'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter((l) => /DisplayName\s+REG_SZ\s+Celeste/.test(l))
    check('the system no longer lists it as installed', records.length === 0, records.join(' '))
    check('and leaves the person’s data alone', existsSync(join(profile, 'celeste.db')) && existsSync(join(profile, 'marker.txt')))
  }
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  await app?.close().catch(() => undefined)
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(work, { recursive: true, force: true })
      break
    } catch {
      if (i === 19) console.warn(`Could not remove ${work}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
