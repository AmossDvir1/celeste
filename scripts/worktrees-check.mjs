// Phase 6 check, in the real built app: a Develop session can work in a separate copy of a git project (a worktree). The copy is
// made on a new branch, the agent works in it and not in the folder that was chosen, the session says so, the Changes panel and
// checkpoints work there, Settings lists the copy with what would be lost, and removing it deletes the folder and the branch.
//   npm run verify:worktrees
// Claude is real (the real SDK and program) and runs a real command; what it says is chosen by a stand-in for Anthropic's API
// (scripts/lib/stub.mjs), so no account is needed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-worktrees-'))
const repo = join(mkdtempSync(join(tmpdir(), 'celeste-wt-project-')), 'shop-web')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
const copies = () => (existsSync(join(profile, 'worktrees')) ? readdirSync(join(profile, 'worktrees')) : [])
const until = async (what, fn, ms = 30_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** What the stand-in's Claude does: runs a command in its working folder, which is where the work shows up. */
const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: r.last.isError ? `That did not work: ${r.last.text}` : 'Finished that step.' }]
  if (/Run the change/.test(r.last.text)) {
    const command = `node -e "const fs=require('fs');fs.writeFileSync('a.txt','edited in the copy\\n');fs.writeFileSync('agent-wrote-this.txt','x')"`
    return [{ type: 'tool_use', name: 'Bash', input: { command, description: 'Change a file here' } }]
  }
  return [{ type: 'text', text: 'Okay.' }]
}

let stub
let app
try {
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'original\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(repo, 'uncommitted.txt'), 'not committed\n')

  stub = await startStub(script)
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  const page = app.page
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)

  console.log('\n# Starting a session in a separate copy')
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
  await app.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, repo)
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  const toggle = page.getByRole('switch', { name: 'Work in a separate copy' })
  await toggle.waitFor({ timeout: 10_000 })
  check('a git project offers a separate copy, off by default', (await toggle.getAttribute('aria-checked')) === 'false')
  await toggle.click()
  check('and it can be switched on', (await toggle.getAttribute('aria-checked')) === 'true')

  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('Run the change please')
  await box.press('Enter')
  await until('the copy to be made', () => copies().length === 1)
  await page.getByText('Finished that step.').first().waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
  const copy = join(profile, 'worktrees', copies()[0])

  check('the copy is in Celeste’s data folder, named after the project', /^shop-web-[0-9a-f]{8}$/.test(copies()[0]))
  check('it is on a new branch of the project, named from the message', /^celeste\/run-the-change-please-[0-9a-f]{8}$/.test(git('branch', '--list', 'celeste/*').replace(/^[*+ ]+/, '')), git('branch', '--list', 'celeste/*'))
  check('the agent worked in the copy', readFileSync(join(copy, 'a.txt'), 'utf8').startsWith('edited in the copy') && existsSync(join(copy, 'agent-wrote-this.txt')))
  check('and the folder that was chosen is as it was', readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n') === 'original\n' && !existsSync(join(repo, 'agent-wrote-this.txt')))
  check('the copy starts from the last commit, so what was not committed is not in it', !existsSync(join(copy, 'uncommitted.txt')))
  check('the session says it is a separate copy', (await page.getByText('Separate copy', { exact: true }).count()) >= 1)
  check('and is on the copy’s branch', (await page.getByText(/^celeste\/run-the-change/).count()) >= 1)

  console.log('\n# Checkpoints and changes work in the copy')
  await page.getByRole('button', { name: 'Changes', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes to a.txt' }).waitFor({ timeout: 30_000 })
  check('the Changes panel lists what the agent did in the copy', (await page.getByRole('button', { name: /^Discard changes to/ }).count()) === 2)
  await page.getByRole('button', { name: 'Revert the project to before this message' }).click()
  await page.getByRole('dialog', { name: 'Revert to before this message?' }).getByRole('list', { name: 'Files that will change' }).waitFor({ timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Revert 2 files' }).click()
  await until('the revert in the copy', () => readFileSync(join(copy, 'a.txt'), 'utf8').replace(/\r\n/g, '\n') === 'original\n' && !existsSync(join(copy, 'agent-wrote-this.txt')))
  check('a revert puts the copy back, and still does not touch the project', existsSync(join(repo, 'uncommitted.txt')))
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await until('the undo', () => existsSync(join(copy, 'agent-wrote-this.txt')))

  console.log('\n# Listing and removing the copy')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Data' }).click()
  const list = page.getByRole('list', { name: 'Separate copies' })
  await list.waitFor({ timeout: 20_000 })
  const row = await list.innerText()
  check('Settings lists the copy with its branch and the session that uses it', /celeste\/run-the-change/.test(row) && /Session: Run the change please/.test(row), row)
  check('and says what would be lost: the files changed and not committed', /2 files changed and not committed/.test(row), row)
  await page.getByRole('button', { name: /^Remove the copy on/ }).click()
  const asking = page.getByRole('dialog', { name: 'Remove this separate copy?' })
  await asking.waitFor()
  check('removing asks first, and says what is lost', /You would lose 2 files changed and not committed/.test(await asking.innerText()))
  await asking.getByRole('button', { name: 'Cancel' }).click()
  check('cancelling removes nothing', copies().length === 1)
  await page.getByRole('button', { name: /^Remove the copy on/ }).click()
  await asking.getByRole('button', { name: 'Remove the copy' }).click()
  await until('the copy to be removed', () => copies().length === 0, 60_000)
  // The branch is deleted just after the folder.
  await until('the branch to be deleted', () => git('branch', '--list', 'celeste/*') === '')
  check('removing it deletes the folder', !existsSync(copy))
  check('and its branch, and nothing else of the project', git('branch', '--list', 'celeste/*') === '' && git('branch', '--list', 'main').includes('main') && existsSync(join(repo, 'uncommitted.txt')), `celeste branches: [${git('branch', '--list', 'celeste/*')}] main: [${git('branch', '--list', 'main')}] uncommitted file: ${existsSync(join(repo, 'uncommitted.txt'))} status: ${git('status', '--porcelain')}`)
  await page.getByText(/None\. They appear when/).waitFor({ timeout: 10_000 })
  check('the list is empty again', true)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'worktrees-after.png') })
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'worktrees-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const dir of [profile, join(repo, '..')]) {
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
