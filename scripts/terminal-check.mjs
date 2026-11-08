// The integrated terminal, in the real built app: a Develop session opens a real shell in its project folder, typing runs commands,
// the shell and what it printed survive closing the panel and switching views, each session has its own, a finished shell can be
// started again, and the agent's own commands are still shown on their own tab.   npm run verify:terminal
// Claude is real (the real SDK and program) but what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-terminal-'))
const base = mkdtempSync(join(tmpdir(), 'celeste-term-project-'))
const project = join(base, 'shop-web')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const win = process.platform === 'win32'

const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: 'Finished that step.' }]
  if (/Run a command/.test(r.last.text)) return [{ type: 'tool_use', name: 'Bash', input: { command: 'node -e "console.log(\'agent-ran-this\')"', description: 'Say something' } }]
  return [{ type: 'text', text: 'Okay.' }]
}

let stub
let app
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
/** What the terminal shows right now, as text. */
const screen = (page) => page.locator('.xterm-rows').innerText()
const until = async (what, fn, ms = 30_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const type = async (page, text) => {
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type(text, { delay: 8 })
  await page.keyboard.press('Enter')
}

try {
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'a.txt'), 'hello\n')
  stub = await startStub(script)

  console.log('\n# A shell in the project folder')
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
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
  await app.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await page.getByText('shop-web').first().waitFor({ timeout: 10_000 })
  await textbox(page).fill('Run a command please')
  await textbox(page).press('Enter')
  await page.getByText('Finished that step.').first().waitFor({ timeout: 60_000 })
  await idle(page)

  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('.xterm-rows').waitFor({ timeout: 20_000 })
  check('the terminal opens on the shell, not on the agent’s commands', (await page.getByRole('button', { name: 'Shell', exact: true }).getAttribute('aria-pressed')) === 'true')
  await until('the prompt', async () => /PS |\$ |% |> /.test(await screen(page)))
  // The folder the shell starts in is the project's, whatever it prints its prompt like.
  await type(page, win ? 'Write-Output ("here=" + (Get-Location).Path)' : 'echo here=$PWD')
  await until('the folder', async () => (await screen(page)).replace(/\s+/g, '').includes(`here=${project}`.replace(/\s+/g, '')))
  check('the shell starts in the project folder', true)

  await type(page, win ? 'Write-Output ("sum=" + (6*7))' : 'echo sum=$((6*7))')
  await until('the answer', async () => /sum=42/.test(await screen(page)))
  check('typing runs a command and its output is shown', true)
  await type(page, win ? 'Get-Content a.txt' : 'cat a.txt')
  await until('the file', async () => /hello/.test((await screen(page)).split('a.txt').slice(1).join('')) || /^hello$/m.test(await screen(page)))
  check('it can read the project’s files', true)

  console.log('\n# It keeps running')
  await page.getByRole('button', { name: 'Agent commands' }).click()
  await page.getByLabel('Terminal output').getByText('agent-ran-this', { exact: false }).waitFor({ timeout: 10_000 })
  check('the agent’s own commands are on their own tab', true)
  await page.getByRole('button', { name: 'Shell', exact: true }).click()
  await page.locator('.xterm-rows').waitFor()
  await until('what was printed before', async () => /sum=42/.test(await screen(page)))
  check('going back to the shell shows what it printed', true)
  await page.getByRole('button', { name: 'Close panel' }).click()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.locator('.xterm-rows').waitFor()
  await until('the same shell', async () => /sum=42/.test(await screen(page)))
  check('closing and reopening the panel brings back the same shell', true)
  await type(page, win ? '$env:CELESTE_TEST = "kept"' : 'export CELESTE_TEST=kept')
  await page.getByRole('button', { name: 'Close panel' }).click()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await type(page, win ? 'Write-Output ("var=" + $env:CELESTE_TEST)' : 'echo var=$CELESTE_TEST')
  await until('the variable', async () => /var=kept/.test(await screen(page)))
  check('a variable set before is still there: it is one shell, not a new one', true)

  console.log('\n# The theme, and when the shell ends')
  const colour = () => page.evaluate(() => getComputedStyle(document.querySelector('.xterm-screen').parentElement ?? document.body).backgroundColor)
  const dark = await colour()
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.waitForTimeout(300)
  const light = await colour()
  check('the terminal follows the theme', dark !== light, `${dark} / ${light}`)
  await type(page, 'exit')
  await page.getByText('The shell ended').waitFor({ timeout: 15_000 })
  check('when the shell ends it says so', true)
  await page.getByRole('button', { name: 'Start a new one' }).click()
  await until('a fresh prompt', async () => !/sum=42/.test(await screen(page)) && /PS |\$ |% |> /.test(await screen(page)))
  check('a new shell starts clean', true)

  mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await type(page, win ? 'Get-ChildItem' : 'ls -la')
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'terminal.png') })
  check('the folder name is what the shell works in', basename(project) === 'shop-web')
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'terminal-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const dir of [profile, base]) {
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
