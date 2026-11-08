// The Workflows tab, in the real built app: the empty start, making a workflow on the canvas (adding steps, filling them in, moving and
// removing them), the checks that explain what is missing, saving and versions, keeping or losing unsaved changes, and deleting.
// npm run verify:workflows       (no account, no cost)
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-workflows-'))
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
  await nodes.filter({ hasText: 'Summarize' }).first().focus()
  await page.keyboard.press('Enter')
  await details.waitFor({ timeout: 5000 }).catch(() => undefined)
  check('Enter on a step with the keyboard opens its details', (await details.count()) === 1 && (await details.getByRole('textbox', { name: 'Step name' }).inputValue()) === 'Summarize')
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
  check('both versions are kept', (await versions.getByRole('listitem').count()) === 2)
  await versions.getByRole('button', { name: 'Restore version 1' }).click()
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

  console.log('\n# Deleting')
  await again.getByRole('button', { name: 'More about this workflow' }).click()
  await again.getByRole('menuitem', { name: 'Delete this workflow' }).click()
  const sure = again.getByRole('dialog', { name: 'Delete this workflow?' })
  await sure.getByRole('button', { name: 'Cancel' }).click()
  check('cancelling keeps it', (await again.getByRole('textbox', { name: 'Workflow name' }).count()) === 1)
  await again.getByRole('button', { name: 'More about this workflow' }).click()
  await again.getByRole('menuitem', { name: 'Delete this workflow' }).click()
  await again.getByRole('dialog', { name: 'Delete this workflow?' }).getByRole('button', { name: 'Delete it' }).click()
  await again.getByRole('heading', { name: 'No workflows yet' }).waitFor({ timeout: 10_000 })
  check('deleting takes it away, and the tab is empty again', true)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'workflows-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(profile, { recursive: true, force: true })
      break
    } catch {
      if (i === 19) console.warn(`Could not remove ${profile}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
