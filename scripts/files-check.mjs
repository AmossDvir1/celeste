// Files a chat makes, in the real built app: the agent writes files in the chat's private folder, they are offered as cards under the
// answer, a document can be opened or saved or shown in its folder, a program can only be shown, and the window cannot name any other
// file.   npm run verify:files
// Claude is real (the real SDK and program) but what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-files-'))
const out = mkdtempSync(join(tmpdir(), 'celeste-files-out-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: 'Here is your report.' }]
  if (/Make the report/.test(r.last.text)) {
    const command = `node -e "const fs=require('fs');fs.mkdirSync('out');fs.writeFileSync('report.csv','name,total\\nA,1\\nB,2\\n');fs.writeFileSync('out/chart.png','png');fs.writeFileSync('installer.exe','MZ')"`
    return [{ type: 'tool_use', name: 'Bash', input: { command, description: 'Make the files' } }]
  }
  return [{ type: 'text', text: 'Okay.' }]
}

let stub
let app
try {
  stub = await startStub(script)
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

  // What the main process was asked to do, instead of really opening windows and programs.
  await app.app.evaluate(({ shell, dialog }, target) => {
    globalThis.__asked = []
    shell.openPath = async (p) => (globalThis.__asked.push(['open', p]), '')
    shell.showItemInFolder = (p) => globalThis.__asked.push(['reveal', p])
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, join(out, 'copy of report.csv'))
  const asked = () => app.app.evaluate(() => globalThis.__asked)

  console.log('\n# Cards under the answer')
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('Make the report please')
  await box.press('Enter')
  const cards = page.getByRole('region', { name: 'Files made in this answer' })
  await cards.waitFor({ timeout: 60_000 })
  const items = cards.getByRole('listitem')
  check('every file the agent wrote is listed, including one in a folder', (await items.count()) === 3, String(await items.count()))
  const text = await cards.innerText()
  check('each shows its kind, size and that it is new', /report\.csv[\s\S]*Data · \d+ B · New/.test(text) && /chart\.png[\s\S]*Image/.test(text) && /in out/.test(text), text)
  check('every file can be opened in the browser pane, a program too (it is only shown there)', (await page.getByRole('button', { name: 'Open report.csv', exact: true }).count()) === 1 && (await page.getByRole('button', { name: 'Open installer.exe', exact: true }).count()) === 1)
  check('a document can also be opened with the computer’s own program', (await page.getByRole('button', { name: 'Open report.csv in your own program' }).count()) === 1)
  check('a program cannot: it can only be shown in its folder', (await page.getByRole('button', { name: /^Open installer\.exe in your own program/ }).count()) === 0 && (await page.getByRole('button', { name: 'Show installer.exe in its folder' }).count()) === 1)
  mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'file-cards.png') })

  console.log('\n# What the buttons do')
  await page.getByRole('button', { name: 'Open report.csv', exact: true }).click()
  await page.getByRole('region', { name: 'Browser' }).waitFor({ timeout: 10_000 })
  check('Open shows the file in a tab of the browser pane, and does not start any program', (await asked()).every((a) => a[0] !== 'open') && (await page.getByTestId('browser-tab').filter({ hasText: 'report.csv' }).count()) === 1)
  await page.getByRole('button', { name: 'Open report.csv in your own program' }).click()
  await page.waitForTimeout(400)
  const opened = (await asked()).find((a) => a[0] === 'open')
  check('Open in your own program hands the file to the computer’s own program, and it is the file in the chat’s folder', Boolean(opened) && opened[1].startsWith(join(realpathSync(profile), 'chats')) && opened[1].endsWith('report.csv'), JSON.stringify(opened))
  await page.getByRole('button', { name: 'Show installer.exe in its folder' }).click()
  await page.waitForTimeout(400)
  check('Show in its folder reveals the file', (await asked()).some((a) => a[0] === 'reveal' && a[1].endsWith('installer.exe')))
  await page.getByRole('button', { name: 'Save a copy of report.csv' }).click()
  await page.getByText('Saved copy of report.csv.').waitFor({ timeout: 10_000 })
  check('Save a copy puts the file where the person chose', existsSync(join(out, 'copy of report.csv')) && readFileSync(join(out, 'copy of report.csv'), 'utf8') === 'name,total\nA,1\nB,2\n')

  console.log('\n# What the window may not do')
  const sessionId = await page.evaluate(async () => (await window.celeste.core.call('app.bootstrap', [])).sessions[0].id)
  const ask = (path, action) => page.evaluate(([id, p, a]) => window.celeste.chatFile(id, p, a), [sessionId, path, action])
  check('a program is not started, even when the window asks', (await ask('installer.exe', 'open')).ok === false)
  const before = (await asked()).length
  const escape = await ask('../../celeste.db', 'reveal')
  const other = await page.evaluate(([p]) => window.celeste.chatFile('s-00000000-0000-0000-0000-000000000000', p, 'reveal'), ['report.csv'])
  const absolute = await ask(join(profile, 'celeste.db'), 'reveal')
  check('a path out of the chat’s folder, another chat, or an absolute path are all refused', !escape.ok && !other.ok && !absolute.ok && (await asked()).length === before)

  console.log('\n# A file attached to a message')
  await page.locator('input[type=file]').first().setInputFiles({ name: 'דוח.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
  await page.getByRole('button', { name: /^Open דוח\.csv/ }).waitFor({ timeout: 10_000 })
  const kept = readdirSync(join(profile, 'attachments'))
  check('an attachment keeps its kind of file on disk (a name in Hebrew too)', kept.length === 1 && kept[0].endsWith('.csv'), kept.join(', '))
  await box.fill('Look at this file')
  await box.press('Enter')
  await page.getByText('Okay.').first().waitFor({ timeout: 60_000 })
  const chip = page.getByRole('button', { name: /^Open דוח\.csv/ })
  check('the file in the sent message can be clicked to open', (await chip.count()) === 1)
  await chip.click()
  await page.getByTestId('browser-tab').filter({ hasText: 'דוח.csv' }).waitFor({ timeout: 10_000 })
  check('it opens in the browser pane under the name it was attached with', (await page.getByTestId('browser-tab').filter({ hasText: 'דוח.csv' }).count()) === 1)
  await page.getByTestId('browser-tab').filter({ hasText: 'דוח.csv' }).click()
  await page.waitForTimeout(500)
  const shown = app.app.context().pages().find((p) => p.url().startsWith('celeste-view://'))
  check('and the viewer shows what is in it', Boolean(shown) && (await shown.locator('body').innerText()).includes('1'), shown ? await shown.locator('body').innerText() : 'no viewer page')

  console.log('\n# After a restart')
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByText('Make the report please').first().click()
  const again = page.getByRole('region', { name: 'Files made in this answer' })
  await again.waitFor({ timeout: 20_000 })
  check('the cards are still there, rebuilt from the log', (await again.getByRole('listitem').count()) === 3)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'files-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const dir of [profile, out]) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        if (i === 19) console.warn(`Could not remove ${dir}`)
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
