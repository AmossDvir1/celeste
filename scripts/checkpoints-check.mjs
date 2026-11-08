// Phase 6 acceptance test, in the real built app: a Develop session saves the project folder before each message, shows what each
// turn changed, reverts to before a message (restoring what was edited, removing what was created), undoes that revert, tells the
// agent about it, keeps all of it across a restart, and never touches the project's own git history.   npm run verify:checkpoints
// Claude is real (the real SDK and program) and edits real files; what it says is chosen by a stand-in for Anthropic's API
// (scripts/lib/stub.mjs), so no account is needed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-checkpoints-'))
const project = join(mkdtempSync(join(tmpdir(), 'celeste-cp-project-')), 'shop-web')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()
const read = (name) => readFileSync(join(project, name), 'utf8')
const until = async (what, fn, ms = 30_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const A = join(project, 'a.txt')
const NEW = join(project, 'made', 'new.txt')
/** What the stand-in's Claude does: edits a.txt, creates a file, and says whether it was told about a revert. */
const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: r.last.isError ? `That did not work: ${r.last.text}` : 'Finished that step.' }]
  if (/Edit the file/.test(r.last.text)) return [{ type: 'tool_use', name: 'Edit', input: { file_path: A, old_string: 'original', new_string: 'edited by the agent' } }]
  if (/Create a file/.test(r.last.text)) return [{ type: 'tool_use', name: 'Write', input: { file_path: NEW, content: 'created by the agent\n' } }]
  if (/Carry on/.test(r.last.text)) return [{ type: 'text', text: /reverted the project folder/.test(r.last.text) ? 'Noted: the folder was reverted.' : 'Nothing was reverted.' }]
  return [{ type: 'text', text: 'Okay.' }]
}

let stub
let app
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const open = () => launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
const revertButtons = (page) => page.getByRole('button', { name: 'Revert the project to before this message' })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
const say = async (page, text, answer) => {
  await textbox(page).fill(text)
  await textbox(page).press('Enter')
  await page.getByText(answer, { exact: false }).first().waitFor({ timeout: 60_000 })
  await idle(page)
}

try {
  mkdirSync(project, { recursive: true })
  writeFileSync(A, 'original\n')
  writeFileSync(join(project, 'keep.txt'), 'never touched\n')
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'add', '.')
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
  const refs = git('for-each-ref')
  const head = git('rev-parse', 'HEAD')
  const gitFolder = readdirSync(join(project, '.git')).sort()

  stub = await startStub(script)

  console.log('\n# Two turns in Develop')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)

  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
  await app.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await page.getByRole('menuitem', { name: /Choose another folder/ }).click()
  await page.getByText('main', { exact: true }).first().waitFor({ timeout: 10_000 })

  await say(page, 'Edit the file please', 'Finished that step.')
  await until('the edit on disk', () => read('a.txt') === 'edited by the agent\n')
  await page.getByText(/1 file changed/).first().waitFor({ timeout: 30_000 })
  check('the first message is saved before the agent acts, and shows what the turn changed', (await revertButtons(page).count()) === 1)

  await say(page, 'Create a file please', 'Finished that step.')
  await until('the new file on disk', () => existsSync(NEW))
  await page.getByText(/1 file changed/).nth(1).waitFor({ timeout: 30_000 })
  check('the second message has its own checkpoint', (await revertButtons(page).count()) === 2)

  console.log('\n# Reverting')
  await revertButtons(page).first().click()
  const dialog = page.getByRole('dialog', { name: 'Revert to before this message?' })
  await dialog.waitFor()
  const list = dialog.getByRole('list', { name: 'Files that will change' })
  await list.waitFor({ timeout: 30_000 })
  const listed = await list.innerText()
  check('the dialog lists exactly what will change, in plain words', /a\.txt[\s\S]*Changed back/.test(listed) && /new\.txt[\s\S]*Removed/.test(listed) && !/keep\.txt/.test(listed), listed)
  check('looking does not change anything', read('a.txt') === 'edited by the agent\n' && existsSync(NEW))
  // For a person to look at: scripts/.output is not tracked.
  mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-dialog.png') })
  await dialog.getByRole('button', { name: 'Revert 2 files' }).click()
  await page.getByText('Reverted: 1 file put back, 1 removed.').waitFor({ timeout: 30_000 })
  check('an edited file is put back as it was', read('a.txt') === 'original\n')
  check('a file the agent created is removed, and so is the folder it left empty', !existsSync(NEW) && !existsSync(join(project, 'made')))
  check('a file nobody touched stays', read('keep.txt') === 'never touched\n')
  check('Celeste says what it did, with an Undo', (await page.getByRole('button', { name: 'Undo', exact: true }).count()) === 1)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-reverted.png') })

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByText('Reverted: 2 files put back.').waitFor({ timeout: 30_000 })
  check('Undo brings both back', read('a.txt') === 'edited by the agent\n' && read('made/new.txt') === 'created by the agent\n')
  check('only the newest revert can be undone', (await page.getByRole('button', { name: 'Undo', exact: true }).count()) === 1)

  console.log('\n# The agent is told')
  await say(page, 'Carry on please', 'Noted: the folder was reverted.')
  check('the next message tells the agent that the folder was reverted', true)
  check('and once the person has spoken again, the revert can no longer be undone', (await page.getByRole('button', { name: 'Undo', exact: true }).count()) === 0)
  await app.close()

  console.log('\n# After a restart')
  app = await open()
  page = app.page
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
  await page.getByRole('button', { name: /Edit the file please/ }).first().click()
  await page.getByText('Reverted: 2 files put back.').waitFor({ timeout: 20_000 })
  check('every checkpoint and notice is still there', (await revertButtons(page).count()) === 3 && (await page.getByText(/Reverted:/).count()) === 2)
  await revertButtons(page).first().click()
  await page.getByRole('dialog', { name: 'Revert to before this message?' }).getByRole('list', { name: 'Files that will change' }).waitFor({ timeout: 30_000 })
  check('and still works after the restart', true)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await app.close()

  console.log('\n# The project’s own git')
  check('its branches, tags and history are as they were', git('for-each-ref') === refs && git('rev-parse', 'HEAD') === head)
  check('there is no stash, and nothing was added to .git', git('stash', 'list') === '' && readdirSync(join(project, '.git')).sort().join() === gitFolder.join())
  check('git sees only the agent’s own edits', git('status', '--porcelain').split('\n').map((l) => l.trim()).sort().join('|') === '?? made/|M a.txt')
  check('the saved copies live in Celeste’s data folder, one per session', readdirSync(join(profile, 'snapshots')).length === 1)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const dir of [profile, join(project, '..')]) {
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
