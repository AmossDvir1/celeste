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
  if (/Describe the context/.test(r.last.text)) {
    const sawFile = /File: a\.txt/.test(r.last.text) && r.last.text.includes('edited by the agent')
    const sawOther = /keep\.txt/.test(r.last.text)
    return [{ type: 'text', text: sawFile && !sawOther ? 'I can see a.txt: edited by the agent.' : `Unexpected context (file ${sawFile}, other ${sawOther}).` }]
  }
  if (/Run the long command/.test(r.last.text)) return [{ type: 'tool_use', name: 'Bash', input: { command: 'node -e "for(let i=1;i<=120;i++)console.log(\'output line \'+i)"', description: 'Print a long output' } }]
  if (/Temporarily change keep/.test(r.last.text)) return [{ type: 'tool_use', name: 'Edit', input: { file_path: join(project, 'keep.txt'), old_string: 'never touched', new_string: 'temporarily changed' } }]
  if (/Put keep back/.test(r.last.text)) return [{ type: 'tool_use', name: 'Edit', input: { file_path: join(project, 'keep.txt'), old_string: 'temporarily changed', new_string: 'never touched' } }]
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
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
  mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
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
  // With no recent projects the button opens the folder window straight away: there is no menu to go through.
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
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

  console.log('\n# Reviewing')
  await page.getByRole('button', { name: 'Review the changes this message made' }).first().click()
  const review = page.getByRole('dialog', { name: 'Review changes' })
  const files = review.getByRole('navigation', { name: 'Changed files' }).getByRole('listitem')
  await review.getByRole('region', { name: 'Changes to a.txt' }).waitFor({ timeout: 30_000 })
  check('a message’s review shows only the file that turn changed', (await files.count()) === 1)
  const shown = await review.getByRole('region', { name: 'Changes to a.txt' }).innerText()
  check('with its lines: what was there and what the agent wrote', shown.includes('original') && shown.includes('edited by the agent'), shown)
  await review.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-review.png') })

  await review.getByLabel('Changes shown').selectOption('all')
  await files.nth(1).waitFor({ timeout: 30_000 })
  check('the whole session shows every file, the created one too', (await files.count()) === 2)
  await review.getByRole('checkbox', { name: 'Mark a.txt as viewed' }).click()
  check('marking a file viewed is counted', (await review.getByText('Viewed 1 of 2').count()) === 1)
  await files.nth(1).getByRole('button').first().click()
  await review.getByRole('region', { name: 'Changes to made/new.txt' }).waitFor()
  check('a new file shows all its lines as added', (await review.getByRole('region', { name: 'Changes to made/new.txt' }).innerText()).includes('created by the agent'))

  await review.getByRole('button', { name: 'Discard changes' }).click()
  check('discarding asks first, and nothing has happened yet', existsSync(NEW))
  await review.getByRole('button', { name: 'Yes, put it back' }).click()
  await until('the discarded file to go', () => !existsSync(NEW))
  // The list is read again after a discard, so it is empty for a moment.
  await page.waitForFunction(() => document.querySelectorAll('nav[aria-label="Changed files"] li').length === 1, undefined, { timeout: 30_000 })
  check('discarding one file leaves the other change alone, and the list updates', read('a.txt') === 'edited by the agent\n' && (await files.count()) === 1)
  await page.keyboard.press('Escape')
  await review.waitFor({ state: 'detached' })
  await page.getByText('Reverted: 1 removed.').last().waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await until('the discard to be undone', () => existsSync(NEW))
  check('a discard is undone like a revert', read('made/new.txt') === 'created by the agent\n')

  console.log('\n# The Changes panel')
  // The agent changes a file and then changes it back, in two messages: the net result has no change in it.
  await textbox(page).fill('Temporarily change keep please')
  await textbox(page).press('Enter')
  await until('the temporary change', () => read('keep.txt') === 'temporarily changed\n')
  await idle(page)
  await textbox(page).fill('Put keep back please')
  await textbox(page).press('Enter')
  await until('the change to be undone by the agent', () => read('keep.txt') === 'never touched\n')
  await idle(page)

  await page.getByRole('button', { name: 'Changes', exact: true }).click()
  const changes = page.locator('section', { has: page.getByRole('heading', { name: /^Changes/ }) })
  await changes.getByRole('button', { name: 'Discard changes to a.txt' }).waitFor({ timeout: 30_000 })
  check('the panel lists what differs now, from the saved copies', (await changes.getByRole('button', { name: /^Discard changes to/ }).count()) === 2)
  check('a file the agent changed and then changed back is not in it', (await changes.getByRole('button', { name: 'Discard changes to keep.txt' }).count()) === 0)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-changes.png') })

  await changes.getByRole('button', { name: 'Discard changes to made/new.txt' }).click()
  await changes.getByRole('button', { name: 'Put back' }).click()
  await until('the file to be put back', () => !existsSync(NEW))
  await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="Discard changes to"]').length === 1, undefined, { timeout: 30_000 })
  check('discarding a file from the panel removes it from the list', read('a.txt') === 'edited by the agent\n')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await until('the discard to be undone', () => existsSync(NEW))
  await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="Discard changes to"]').length === 2, undefined, { timeout: 30_000 })
  check('and undoing it from the conversation brings it back into the list', true)

  await changes.getByRole('button', { name: 'Revert all' }).click()
  const all = page.getByRole('dialog', { name: 'Revert everything in this session?' })
  await all.getByRole('list', { name: 'Files that will change' }).waitFor({ timeout: 30_000 })
  check('Revert all lists every file and asks first', (await all.getByRole('listitem').count()) === 2 && existsSync(NEW))
  await all.getByRole('button', { name: 'Cancel' }).click()

  console.log('\n# The terminal')
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await textbox(page).fill('Run the long command please')
  await textbox(page).press('Enter')
  const terminal = page.getByLabel('Terminal output')
  await terminal.getByText('output line 120', { exact: false }).waitFor({ timeout: 60_000 })
  await idle(page)
  const atEnd = () => terminal.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5)
  check('long output is more than the panel shows at once', await terminal.evaluate((el) => el.scrollHeight > el.clientHeight * 1.5))
  check('the terminal is scrolled to the newest output', await atEnd())
  await terminal.evaluate((el) => (el.scrollTop = 0))
  await page.getByRole('button', { name: 'Jump to latest' }).waitFor({ timeout: 5000 })
  check('scrolling up to read stays put, and offers a way back to the end', !(await atEnd()))
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  check('Jump to latest goes back to the end', await atEnd())

  console.log('\n# The file tree')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const tree = page.getByRole('tree', { name: 'Project files' })
  await tree.getByRole('treeitem', { name: /keep\.txt/ }).waitFor({ timeout: 20_000 })
  const names = (await tree.getByRole('treeitem').allInnerTexts()).map((t) => t.split('\n')[0].trim())
  check('the tree lists the real folder, folders first, and never .git', names.join('|') === 'made|node_modules|.gitignore|a.txt|keep.txt', names.join('|'))
  check('what the agent edited is marked changed', (await tree.getByRole('treeitem', { name: /a\.txt/ }).getByLabel('changed').count()) === 1)
  check('and a folder with changes in it shows a dot', (await tree.getByRole('treeitem', { name: /^made/ }).getByLabel('contains changes').count()) === 1)
  check('an untouched file has no marker', (await tree.getByRole('treeitem', { name: /keep\.txt/ }).getByLabel(/changed|new/).count()) === 0)
  await tree.getByRole('treeitem', { name: /^made/ }).click()
  await tree.getByRole('treeitem', { name: /new\.txt/ }).waitFor({ timeout: 10_000 })
  check('a folder opens in place, and the file the agent created is marked new', (await tree.getByRole('treeitem', { name: /new\.txt/ }).getByLabel('new', { exact: true }).count()) === 1)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-files.png') })
  await tree.getByRole('treeitem', { name: /^node_modules/ }).click()
  await tree.getByRole('treeitem', { name: /^pkg/ }).waitFor({ timeout: 10_000 })
  check('a folder like node_modules can be opened too', true)

  await tree.getByRole('treeitem', { name: /^a\.txt/ }).click()
  await page.getByLabel('File contents').waitFor({ timeout: 10_000 })
  check('a file opens as text, with its line numbers', (await page.getByLabel('File contents').innerText()).includes('edited by the agent'))
  await page.getByRole('button', { name: 'Show changes' }).click()
  await page.getByRole('dialog', { name: 'Review changes' }).getByRole('region', { name: 'Changes to a.txt' }).waitFor({ timeout: 30_000 })
  check('Show changes opens the review on that file', true)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Back to the files' }).click()
  await tree.waitFor()
  check('and Back returns to the tree', (await tree.getByRole('treeitem', { name: /keep\.txt/ }).count()) === 1)

  console.log('\n# Files as context')
  const chips = page.getByRole('list', { name: 'Files added as context' })
  // Dragged from the tree onto the message box.
  await tree.getByRole('treeitem', { name: /^a\.txt/ }).dragTo(textbox(page))
  await chips.getByText('a.txt').waitFor({ timeout: 10_000 })
  check('a file dragged from the tree onto the message box becomes a chip', (await chips.getByRole('listitem').count()) === 1)
  // The plus button does the same without dragging, and a chip can be taken off again.
  await tree.getByRole('treeitem', { name: /keep\.txt/ }).hover()
  await page.getByRole('button', { name: 'Add keep.txt to the message' }).click()
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Files added as context"] li').length === 2)
  check('the plus button on a row adds it too', true)
  await page.getByRole('button', { name: 'Remove keep.txt from the message' }).click()
  await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Files added as context"] li').length === 1)
  check('and a chip can be removed', (await chips.getByText('keep.txt').count()) === 0)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'checkpoints-context.png') })

  await textbox(page).fill('Describe the context please')
  await textbox(page).press('Enter')
  await page.getByText('I can see a.txt: edited by the agent.').waitFor({ timeout: 60_000 })
  await idle(page)
  check('the agent was given the file’s contents with the message, and only that file', true)
  check('the sent message shows the file as a chip, and the box is empty again', (await chips.count()) === 1 && (await chips.getByRole('button').count()) === 0)
  check('the message itself holds only what was typed', (await page.getByText('Describe the context please', { exact: true }).count()) >= 1)
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
