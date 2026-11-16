// Diagrams, charts and steps in the chat, in the real built app (docs/plans/CHAT_DISPLAY_PLAN.md, section 11a): fenced blocks the assistant
// writes are drawn in the bubble under the page's real Content Security Policy, in both themes; a block that is still arriving is a quiet
// "Drawing…"; a broken one is a short note with Try again (at most twice) and its source folded away; a hostile one runs nothing; ticks on
// steps survive a reload; the Mermaid library is a chunk of its own.   npm run verify:visuals     (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``
const DIAGRAM = fence('mermaid', '%% summary: A request goes from the browser to the server and then to the database.\nflowchart TD\n  A[Browser] --> B[Server]\n  B --> C[(Database)]')
const CHART = fence('chart', JSON.stringify({ type: 'bar', title: 'Sales', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Units', data: [3, 5, 8] }], summary: 'Sales grew every quarter.' }))
const STEPS = fence(
  'steps',
  JSON.stringify({
    title: 'Turn on two-step sign-in',
    summary: 'Three steps in your account settings.',
    steps: [
      { title: 'Open settings', text: 'Click your picture, then Settings.', link: { label: 'Account settings', url: 'https://example.com/settings' } },
      { title: 'Choose two-step', copy: 'Security > Two-step' },
      { title: 'Save the backup codes' },
      { title: 'Never opened', link: { label: 'Bad link', url: 'javascript:window.__pwned=9' } }
    ]
  })
)
const BROKEN = fence('mermaid', 'flowchart TD\n  A --> --> ???')
const HOSTILE = fence('mermaid', 'flowchart TD\n  A["<img src=x onerror=window.__pwned=1>"] --> B["<script>window.__pwned=2</scr' + 'ipt>"]\n  click A href "javascript:window.__pwned=3"')
const SLOW = `Here is the flow:\n\n${DIAGRAM}\n\nThat is all.`

const script = (r) => {
  const text = r.last.kind === 'text' ? r.last.text : ''
  if (/^DRAW ALL/.test(text)) return [{ type: 'text', text: `Here is everything.\n\n${DIAGRAM}\n\nSales by quarter:\n\n${CHART}\n\nAnd how to set it up:\n\n${STEPS}\n\nDone.` }]
  if (/^DRAW BROKEN/.test(text)) return [{ type: 'text', text: `A diagram:\n\n${BROKEN}\n\nDone.` }]
  if (/^DRAW HOSTILE/.test(text)) return [{ type: 'text', text: `A diagram:\n\n${HOSTILE}\n\nDone.` }]
  if (/^DRAW SLOWLY/.test(text)) return [{ type: 'text', text: SLOW, chunk: 6, delayMs: 120 }]
  return [{ type: 'text', text: `Saw: ${text.slice(0, 120)}` }]
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-visuals-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const idle = (page) => page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 90_000 })
const send = async (page, text) => {
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await box.press('Enter')
}
const newChat = async (page) => {
  await page.keyboard.press('Control+n')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
}

let stub
let app
try {
  stub = await startStub(script)
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  let { page } = app
  const violations = []
  const watch = async (p) => {
    await p.evaluate(() => {
      window.__violations = window.__violations ?? []
      document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective}: ${e.blockedURI}`))
    })
  }
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana', theme: 'dark' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)
  await watch(page)

  console.log('\n# A diagram, a chart and steps in one answer')
  await send(page, 'DRAW ALL')
  const diagram = page.getByRole('img', { name: 'A request goes from the browser to the server and then to the database.' })
  await diagram.waitFor({ timeout: 60_000 })
  await idle(page)
  await diagram.locator('svg').waitFor({ timeout: 30_000 })
  check('the diagram is drawn in the bubble, with its summary as what a screen reader reads', (await diagram.locator('svg').count()) === 1 && /Browser/.test(await diagram.innerText()))
  const dark = await diagram.locator('svg').evaluate((el) => el.outerHTML)
  check('and its source is not shown as text', !/flowchart TD/.test(await page.locator('main, body').first().innerText()))
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'visuals-dark.png') })

  const chart = page.getByRole('img', { name: 'Sales grew every quarter.' })
  await chart.waitFor({ timeout: 30_000 })
  check('the chart is a canvas with its summary', (await chart.evaluate((el) => el.tagName)) === 'CANVAS' && (await chart.evaluate((el) => el.width > 50 && el.height > 50)))
  await page.getByText('Show the numbers').click()
  const numbers = await page.getByRole('table').last().innerText()
  check('and its numbers are there as a table for anyone who wants them', /Q1/.test(numbers) && /8/.test(numbers) && /Units/.test(numbers), numbers)

  const steps = page.getByRole('region', { name: 'Turn on two-step sign-in' })
  await steps.waitFor()
  check('the steps are a card with a count, a Copy button and a link', /0 of 4 done/.test(await steps.innerText()) && (await steps.getByRole('button', { name: /^Copy:/ }).count()) === 1 && (await steps.getByRole('link', { name: /Account settings/ }).count()) === 1)
  check('a link that is not https is left out and the step stays', (await steps.getByRole('link').count()) === 1 && /Never opened/.test(await steps.innerText()))
  await steps.getByRole('checkbox', { name: /^Step 2/ }).click()
  await steps.getByRole('checkbox', { name: /^Step 3/ }).click()
  check('steps can be ticked off, and it counts them', /2 of 4 done/.test(await steps.innerText()))
  await steps.getByRole('button', { name: /^Copy:/ }).click()
  check('Copy says it copied, and runs nothing', /Copied/.test(await steps.innerText()))
  const before = page.url()
  await steps.getByRole('link', { name: /Account settings/ }).click()
  await page.waitForTimeout(500)
  check('a link asks where to open it, as any link in an answer does, and the window does not go anywhere', page.url() === before && (await page.getByRole('dialog', { name: 'Open this link where?' }).count()) === 1)
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Open this link where?' }).waitFor({ state: 'detached', timeout: 5000 })

  console.log('\n# The policy of the page, and the library')
  const seen = await page.evaluate(() => window.__violations)
  check('nothing was blocked by the Content Security Policy while they were drawn', seen.length === 0, seen.join(' | '))
  const assets = join(import.meta.dirname, '..', 'out', 'renderer', 'assets')
  const files = readdirSync(assets).filter((f) => f.endsWith('.js'))
  const withMermaid = files.filter((f) => readFileSync(join(assets, f), 'utf8').includes('Parse error on line'))
  const main = readFileSync(join(import.meta.dirname, '..', 'out', 'renderer', 'index.html'), 'utf8').match(/assets\/(index-[^"]+\.js)/)?.[1]
  check('Mermaid is a chunk of its own, loaded when a diagram appears, not part of the main bundle', withMermaid.length > 0 && !!main && !withMermaid.includes(main), `${withMermaid.join(', ')} / ${main}`)

  console.log('\n# Both themes')
  // The theme is a data attribute the window puts on the page (the settings store does the same).
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.waitForTimeout(1500)
  const light = await page.getByRole('img', { name: /A request goes from the browser/ }).locator('svg').evaluate((el) => el.outerHTML)
  check('the diagram is drawn again in the light colours', light !== dark && /#111b4c/i.test(light) && !/#f7f8fc/i.test(light), `${dark.length} / ${light.length}`)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'visuals-light.png') })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))

  console.log('\n# A block that is still arriving')
  await newChat(page)
  await send(page, 'DRAW SLOWLY')
  await page.getByRole('status', { name: 'Drawing the diagram' }).waitFor({ timeout: 30_000 })
  check('while it is arriving there is a quiet “Drawing…”, not half a diagram or an error', (await page.getByText('Couldn’t draw this diagram').count()) === 0)
  await page.getByRole('img', { name: /A request goes from the browser/ }).locator('svg').waitFor({ timeout: 60_000 })
  await idle(page)
  check('and the diagram when the block is whole', (await page.getByRole('status', { name: 'Drawing the diagram' }).count()) === 0)

  console.log('\n# A diagram that cannot be drawn')
  await newChat(page)
  await send(page, 'DRAW BROKEN')
  const note = page.getByRole('group', { name: 'The diagram could not be drawn' })
  await note.waitFor({ timeout: 60_000 })
  await idle(page)
  check('there is a short sentence and Try again, and no raw code', /Couldn’t draw this diagram/.test(await note.innerText()) && (await note.getByRole('button', { name: 'Try again' }).count()) === 1 && !(await note.getByText('--> --> ???').isVisible()))
  await note.getByText('Show source').click()
  check('the source is there, folded, for the person who wants it', await note.getByText('--> --> ???').isVisible())
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'visuals-error.png') })
  const requests = stub.requests.length
  await note.getByRole('button', { name: 'Try again' }).click()
  await page.getByText(/\(automatic\) That diagram could not be drawn/).first().waitFor({ timeout: 30_000 })
  await idle(page)
  const sent = stub.requests.slice(requests).map((r) => (r.last.kind === 'text' ? r.last.text : ''))
  check('Try again sends the error back as a message in the chat, marked automatic', sent.some((t) => /^\(automatic\) That diagram could not be drawn: .+ Please fix it and send it again\.$/.test(t)), sent.join(' | ').slice(0, 300))
  await note.getByRole('button', { name: 'Try again' }).click()
  await idle(page)
  check('the second time it is the last: then only the source is left', (await page.getByRole('group', { name: 'The diagram could not be drawn' }).getByRole('button', { name: 'Try again' }).count()) === 0 && /twice/.test(await page.getByRole('group', { name: 'The diagram could not be drawn' }).innerText()))

  console.log('\n# A diagram that tries to run something')
  await newChat(page)
  await send(page, 'DRAW HOSTILE')
  await page.getByText('Done.').first().waitFor({ timeout: 60_000 })
  await idle(page)
  await page.waitForTimeout(2500)
  const pwned = await page.evaluate(() => window.__pwned ?? null)
  check('nothing ran: no script, no handler, no javascript: link', pwned === null, String(pwned))
  const html = await page.evaluate(() => [...document.querySelectorAll('figure')].map((f) => f.innerHTML).join('\n'))
  check('and what is on the page has none of them', !/<script/i.test(html) && !/onerror/i.test(html) && !/javascript:/i.test(html))

  console.log('\n# A reload, and a restart')
  await app.close()
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  page = app.page
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 })
  await page.getByText('DRAW ALL').first().click()
  const again = page.getByRole('img', { name: /A request goes from the browser/ })
  await again.locator('svg').waitFor({ timeout: 30_000 })
  check('a reopened chat draws the same diagram from what the log kept, with no assistant asked', (await again.locator('svg').count()) === 1)
  const steps2 = page.getByRole('region', { name: 'Turn on two-step sign-in' })
  await steps2.waitFor()
  check('and the steps are still ticked', /2 of 4 done/.test(await steps2.innerText()))
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'visuals-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
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
