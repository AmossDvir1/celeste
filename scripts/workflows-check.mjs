// The Workflows tab, in the real built app: the empty start, making a workflow on the canvas (adding steps, filling them in, moving and
// removing them), the checks that explain what is missing, saving and versions, keeping or losing unsaved changes, and deleting.
// npm run verify:workflows       (no account, no cost)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-workflows-'))
const out = mkdtempSync(join(tmpdir(), 'celeste-workflows-out-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

let app
try {
  app = await launch({ width: 1440, height: 900, theme: null, profile })
  const { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })

  const nodes = page.locator('.react-flow__node')
  const details = page.getByRole('region', { name: 'Step details' })
  const addStep = async (name) => {
    await page.getByRole('button', { name: 'Add a step' }).click()
    await page.getByRole('menuitem', { name }).click()
    await details.waitFor()
  }
  // The steps left to right, by name: the order on the page is the order they run in, whatever order the page lists them in.
  const line = async () =>
    (await nodes.evaluateAll((els) => els.map((e) => ({ x: e.getBoundingClientRect().x, name: e.querySelector('.truncate')?.textContent ?? '' })))).sort((a, b) => a.x - b.x).map((n) => n.name)
  const toast = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 8000 })

  console.log('\n# The way in')
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Workflows' }).click()
  await page.getByRole('heading', { name: 'No workflows yet' }).waitFor()
  check('with none made, the tab says so and offers one way in', (await page.getByRole('button', { name: 'New workflow' }).count()) >= 1)
  check('nothing is pretended: no example workflows', (await page.getByRole('list', { name: 'Your workflows' }).count()) === 0)
  check('the sidebar has the workflows part under the chats', (await page.getByRole('region', { name: 'Workflows' }).getByText('None yet').count()) === 1)

  console.log('\n# Making one')
  await page.getByRole('region', { name: 'Workflows' }).getByRole('button', { name: 'New workflow' }).click()
  await page.getByRole('textbox', { name: 'Workflow name' }).waitFor()
  check('a new workflow is just Start and End, joined', (await nodes.count()) === 2)
  await page.getByRole('textbox', { name: 'Workflow name' }).fill('Update old KBs')
  await page.getByRole('textbox', { name: 'Workflow description' }).fill('Find old KBs and install the newest of each.')

  await page.getByRole('button', { name: /^Start/ }).first().click().catch(() => undefined)
  await nodes.first().click()
  await details.waitFor()
  await details.getByRole('button', { name: 'Add input' }).click()
  await details.getByRole('textbox', { name: 'Input 1 name' }).fill('older_than_days')
  await details.getByRole('textbox', { name: 'Input 1 label' }).fill('Older than (days)')
  await details.getByRole('combobox', { name: 'Input 1 type' }).selectOption('number')
  await details.getByRole('textbox', { name: 'Input 1 default' }).fill('365')
  check('Start takes inputs', (await details.getByRole('textbox', { name: 'Input 1 name' }).inputValue()) === 'older_than_days')

  await addStep('Run a command')
  check('a step added is on the canvas, before End, and open for filling in', (await nodes.count()) === 3)
  const banner = page.getByRole('status').filter({ hasText: 'To save:' })
  check('and it says what is missing before the workflow can be saved', /the command is empty/.test(await banner.innerText()))
  await details.getByRole('textbox', { name: 'Step name' }).fill('Find old KBs')
  await details.getByRole('textbox', { name: 'Command' }).fill('find-kbs --days {{inputs.older_than_days}}')
  await addStep('Ask the assistant')
  await details.getByRole('textbox', { name: 'Step name' }).fill('Summarize')
  check('the new step is added after the one that was open', (await line()).join('|') === 'Start|Find old KBs|Summarize|End', (await line()).join('|'))
  await details.getByRole('textbox', { name: 'Prompt' }).fill('Summarize {{nodes.nope.output}}')
  check('a reference to a step that is not there is explained', /does not run before it/.test(await banner.innerText()), await banner.innerText())
  await details.getByRole('textbox', { name: 'Prompt' }).fill('Summarize: {{nodes.find_old_kbs.output}}')
  const refs = await details.innerText()
  check('the text box says what can be used', refs.includes('{{nodes.find_old_kbs.output}}') && refs.includes('{{inputs.older_than_days}}'))
  await details.getByRole('button', { name: 'Error handling' }).click()
  await details.getByRole('combobox', { name: 'If this step fails' }).selectOption('retry')
  check('error handling offers tries after the first', (await details.getByRole('textbox', { name: 'Tries after the first (1 to 5)' }).inputValue()) === '2')
  check('nothing is left to fix', (await banner.count()) === 0, (await banner.allInnerTexts()).join(' / '))
  mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'workflow-editor.png') })

  console.log('\n# Moving, removing and the keyboard')
  await nodes.filter({ hasText: 'Find old KBs' }).first().click()
  await details.getByRole('button', { name: 'Later' }).click()
  check('a step moves later, and the line follows', (await line()).join('|') === 'Start|Summarize|Find old KBs|End', (await line()).join('|'))
  await details.getByRole('button', { name: 'Earlier' }).click()
  await page.keyboard.press('Escape')
  const summarize = nodes.filter({ hasText: 'Summarize' }).first()
  // The canvas may still be fitting the steps to its new width when the key is pressed, which takes the press away: try a few times, as a person would.
  for (let i = 0; i < 4; i++) {
    await summarize.focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    if ((await details.getByRole('textbox', { name: 'Step name' }).inputValue().catch(() => '')) === 'Summarize') break
  }
  const opened = details.getByRole('textbox', { name: 'Step name' })
  // The panel may still be showing the step that was open before; give the new one a moment to take its place.
  for (let i = 0; i < 40 && (await opened.inputValue().catch(() => '')) !== 'Summarize'; i++) await page.waitForTimeout(100)
  check('Enter on a step with the keyboard opens its details', (await details.count()) === 1 && (await opened.inputValue()) === 'Summarize', `details ${await details.count()}, name ${await opened.inputValue().catch(() => 'none')}, focused ${await page.evaluate(() => document.activeElement?.className?.toString().slice(0, 60))}`)
  await details.getByRole('button', { name: 'Close panel' }).click()

  console.log('\n# Saving')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await toast('Saved.')
  check('it is saved, and listed in the sidebar', (await page.getByRole('region', { name: 'Workflows' }).getByRole('button', { name: 'Update old KBs' }).count()) === 1)
  check('it says it is version 1', (await page.getByText('v1', { exact: true }).count()) === 1)
  check('nothing is unsaved now', (await page.getByText('Unsaved changes').count()) === 0)

  await nodes.nth(1).click()
  await details.getByRole('textbox', { name: 'Command' }).fill('find-kbs --days {{inputs.older_than_days}} --all')
  check('a change shows as unsaved', (await page.getByText('Unsaved changes').count()) === 1)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await toast('Saved as version 2.')

  await page.getByRole('button', { name: 'More about this workflow' }).click()
  await page.getByRole('menuitem', { name: 'Versions' }).click()
  const versions = page.getByRole('dialog', { name: 'Versions' })
  // The list is read from Core when the dialog opens, which a slower computer takes a moment over.
  await versions.getByRole('listitem').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(300)
  check('both versions are kept', (await versions.getByRole('listitem').count()) === 2)
  await versions.getByRole('button', { name: 'Restore version 1' }).click()
  await page.getByText('Unsaved changes').first().waitFor({ timeout: 10_000 }).catch(() => undefined)
  check('restoring puts the old steps back as an unsaved change', (await page.getByText('Unsaved changes').count()) === 1)
  await nodes.nth(1).click()
  check('the command is the one from version 1', (await details.getByRole('textbox', { name: 'Command' }).inputValue()) === 'find-kbs --days {{inputs.older_than_days}}')

  console.log('\n# Leaving with changes')
  await page.getByRole('button', { name: 'Back to all workflows' }).click()
  const leave = page.getByRole('dialog', { name: 'Leave without saving?' })
  check('leaving with unsaved changes asks first', (await leave.count()) === 1)
  await leave.getByRole('button', { name: 'Cancel' }).click()
  check('cancelling stays where it was', (await page.getByRole('textbox', { name: 'Workflow name' }).count()) === 1)
  await page.getByRole('button', { name: 'Back to all workflows' }).click()
  await page.getByRole('dialog', { name: 'Leave without saving?' }).getByRole('button', { name: 'Leave without saving' }).click()
  const list = page.getByRole('list', { name: 'Your workflows' })
  await list.waitFor()
  check('the list shows the workflow at version 2, as it was saved', /Update old KBs/.test(await list.innerText()) && /Version 2/.test(await list.innerText()))

  console.log('\n# It is kept')
  await app.close()
  app = await launch({ width: 1440, height: 900, theme: null, profile })
  const again = app.page
  await again.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Workflows' }).click()
  await again.getByRole('list', { name: 'Your workflows' }).getByRole('button', { name: /Update old KBs/ }).click()
  await again.locator('.react-flow__node').first().waitFor()
  check('after a restart the workflow opens with all its steps', (await again.locator('.react-flow__node').count()) === 4)
  await again.locator('.react-flow__node').nth(1).click()
  check('and the saved command', (await again.getByRole('textbox', { name: 'Command' }).inputValue()).endsWith('--all'))

  console.log('\n# Running')
  await again.getByRole('button', { name: 'Back to all workflows' }).click()
  // A second workflow that can really run here: write a file, run a command, read the file back.
  const made = await again.evaluate(
    (def) => window.celeste.core.call('workflows.save', [{ name: 'Greeting', description: 'Says hello.', definition: def }]),
    {
      nodes: [
        { id: 'start', type: 'start', name: 'Start', inputs: [{ name: 'who', label: 'Who to greet', type: 'text', default: 'world' }] },
        { id: 'write_it', type: 'tool', name: 'Write it', tool: { kind: 'file', op: 'write', path: 'greeting.txt', content: 'Hello {{inputs.who}}' } },
        { id: 'say', type: 'tool', name: 'Say it', tool: { kind: 'shell', command: 'echo from-the-shell' } },
        { id: 'read_it', type: 'tool', name: 'Read it', tool: { kind: 'file', op: 'read', path: 'greeting.txt' } },
        { id: 'end', type: 'end', name: 'End', output: '{{nodes.read_it.output}} / {{nodes.say.output}}' }
      ],
      edges: [{ from: 'start', to: 'write_it' }, { from: 'write_it', to: 'say' }, { from: 'say', to: 'read_it' }, { from: 'read_it', to: 'end' }]
    }
  )
  await again.getByRole('list', { name: 'Your workflows' }).getByRole('button', { name: /Greeting/ }).click()
  await again.locator('.react-flow__node').first().waitFor()
  const panel = again.getByRole('region', { name: 'Run', exact: true })
  await again.getByRole('button', { name: 'Run', exact: true }).click()
  const dialog = again.getByRole('dialog', { name: /^Run “Greeting”/ })
  check('Run asks the start questions, with their defaults', (await dialog.getByRole('textbox', { name: 'Who to greet' }).inputValue()) === 'world')
  check('and says where it works: a private folder, unless one is chosen', (await dialog.innerText()).includes('A private folder Celeste keeps for this workflow'))
  await dialog.getByRole('textbox', { name: 'Who to greet' }).fill('Dana')
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  const card = again.getByRole('group', { name: 'Approval needed' })
  await card.waitFor({ timeout: 15_000 })
  const listed = await card.innerText()
  check('before anything happens, one card lists everything it will do, with the answers filled in', /Write greeting\.txt/.test(listed) && /echo from-the-shell/.test(listed) && !/Read it/.test(listed), listed)
  const home = join(profile, 'workflows', made.id)
  check('and nothing has happened yet', !existsSync(join(home, 'greeting.txt')))
  await card.getByRole('button', { name: 'Allow and run' }).click()
  const result = panel.getByRole('region', { name: 'Result' })
  await result.waitFor({ timeout: 30_000 })
  check('the run finishes with the result of its last step', /Hello Dana \/ from-the-shell/.test(await result.innerText()), await result.innerText())
  check('every step shows as done, on the canvas and in the run', (await panel.getByRole('list', { name: 'Steps' }).getByText('Done', { exact: true }).count()) === 5 && (await again.locator('.react-flow__node').getByText('Done', { exact: true }).count()) === 5)
  check('the file really is in the workflow’s private folder', existsSync(join(home, 'greeting.txt')) && readFileSync(join(home, 'greeting.txt'), 'utf8') === 'Hello Dana')
  await panel.getByRole('button', { name: /Say it/ }).click()
  check('a step opens to show what it produced', /from-the-shell/.test(await panel.getByRole('list', { name: 'Steps' }).innerText()))
  await again.screenshot({ path: join(import.meta.dirname, '.output', 'workflow-run.png') })

  await panel.getByRole('button', { name: 'Run again' }).click()
  const second = again.getByRole('dialog', { name: /^Run “Greeting”/ })
  await second.getByRole('textbox', { name: 'Who to greet' }).fill('Zed')
  await second.getByRole('button', { name: 'Run', exact: true }).click()
  await again.getByRole('group', { name: 'Approval needed' }).getByRole('button', { name: 'Cancel' }).click()
  await panel.getByText('You did not allow this run, so nothing was done.').waitFor({ timeout: 15_000 })
  check('saying no does nothing: the file is as it was', readFileSync(join(home, 'greeting.txt'), 'utf8') === 'Hello Dana')

  await again.getByRole('button', { name: 'More about this workflow' }).click()
  await again.getByRole('menuitem', { name: 'Run history' }).click()
  const runs = again.getByRole('dialog', { name: 'Run history' }).getByRole('list', { name: 'Runs' })
  await runs.getByRole('listitem').first().waitFor({ timeout: 10_000 })
  await again.waitForTimeout(300)
  const entries = await runs.getByRole('listitem').allInnerTexts()
  check('the history keeps both runs, newest first', entries.length === 2 && /Stopped/.test(entries[0]) && /Finished/.test(entries[1]), entries.join(' | '))
  await runs.getByRole('listitem').nth(1).getByRole('button').click()
  await result.waitFor({ timeout: 10_000 })
  check('an old run opens as it was, with its result', /Hello Dana/.test(await result.innerText()))
  await panel.getByRole('button', { name: 'Close panel' }).click()

  console.log('\n# Sharing and importing')
  const shared = join(out, 'greeting.celeste-workflow.json')
  await again.getByRole('button', { name: 'More about this workflow' }).press('Escape').catch(() => undefined)
  await app.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, shared)
  await again.getByRole('button', { name: 'Share', exact: true }).click()
  await again.getByText('Saved greeting.celeste-workflow.json.', { exact: false }).first().waitFor({ timeout: 8000 })
  const text = readFileSync(shared, 'utf8')
  const file = JSON.parse(text)
  check('Share writes a file in the workflow file format, with the steps in order', file.format === 'celeste-workflow' && file.name === 'Greeting' && file.definition.nodes.map((n) => n.id).join() === 'start,write_it,say,read_it,end', text.slice(0, 120))
  check('and nothing about this computer: no positions, no folder', !/position|workflows[\\/]/.test(text))
  await again.getByRole('button', { name: 'Back to all workflows' }).click()
  await again.getByRole('button', { name: 'Import', exact: true }).click()
  await again.getByRole('textbox', { name: 'Workflow name' }).waitFor({ timeout: 8000 })
  check('Import opens it as a new workflow, renamed because that name is taken', (await again.getByRole('textbox', { name: 'Workflow name' }).inputValue()) === 'Greeting (2)')
  check('and not saved yet: nothing is kept or run until the person says so', (await again.getByText('Unsaved changes').count()) === 1 && (await again.locator('.react-flow__node').count()) === 5)
  await again.getByRole('button', { name: 'Save', exact: true }).click()
  await again.getByText('Saved.', { exact: false }).first().waitFor({ timeout: 8000 })
  await again.getByRole('button', { name: 'Back to all workflows' }).click()
  const both = await again.getByRole('list', { name: 'Your workflows' }).innerText()
  check('after saving there are two, the original and the copy', /Greeting \(2\)/.test(both) && /Greeting\n/.test(both + '\n'))
  await again.getByRole('list', { name: 'Your workflows' }).getByRole('button', { name: /Update old KBs/ }).click()
  await again.locator('.react-flow__node').first().waitFor()

  console.log('\n# Deleting')
  await again.getByRole('button', { name: 'More about this workflow' }).click()
  await again.getByRole('menuitem', { name: 'Delete this workflow' }).click()
  const sure = again.getByRole('dialog', { name: 'Delete this workflow?' })
  await sure.getByRole('button', { name: 'Cancel' }).click()
  check('cancelling keeps it', (await again.getByRole('textbox', { name: 'Workflow name' }).count()) === 1)
  await again.getByRole('button', { name: 'More about this workflow' }).click()
  await again.getByRole('menuitem', { name: 'Delete this workflow' }).click()
  await again.getByRole('dialog', { name: 'Delete this workflow?' }).getByRole('button', { name: 'Delete it' }).click()
  const left = again.getByRole('list', { name: 'Your workflows' })
  await left.waitFor({ timeout: 10_000 })
  check('deleting takes it away, and leaves the other one', !/Update old KBs/.test(await left.innerText()) && /Greeting/.test(await left.innerText()), await left.innerText())
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'workflows-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
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
