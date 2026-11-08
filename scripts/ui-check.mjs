// Interface check, in the real built app: (1) messages pile up, spread out when pointed at, and wait while you read them;
// (2) an accessibility audit of the screens, in both themes, with axe-core (WCAG 2.2 A and AA plus its best practices), and a
// keyboard check that dialogs keep focus inside, close with Escape and give focus back.   npm run verify:ui
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, say, startStub } from './lib/stub.mjs'

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

/** Rules that are knowingly not followed, each with the reason. Empty is the goal. */
const ACCEPTED = {}

const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: r.last.isError ? `That did not work: ${r.last.text}` : 'Finished that step.' }]
  if (/Run the change/.test(r.last.text)) {
    const command = `node -e "require('fs').writeFileSync('a.txt','changed\\n')"`
    return [{ type: 'tool_use', name: 'Bash', input: { command, description: 'Change a file here' } }]
  }
  return echo(r)
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-ui-'))
const project = mkdtempSync(join(tmpdir(), 'celeste-ui-project-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })

/** Every violation found, keyed so the same one on the same element is reported once however many screens show it. */
const found = new Map()
let audited = 0
async function audit(page, screen) {
  audited++
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.waitForTimeout(250)
    if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(axeSource)
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        resultTypes: ['violations']
      })
      return result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target.join(' > '), html: n.html.slice(0, 140), why: (n.any[0] ?? n.all[0] ?? n.none[0])?.message ?? '' }))
      }))
    })
    for (const v of violations) {
      if (ACCEPTED[v.id]) continue
      for (const n of v.nodes) {
        const key = `${v.id}|${n.target}|${theme}`
        if (!found.has(key)) found.set(key, { ...v, ...n, screen, theme })
      }
    }
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
}

async function closeSettings(page) {
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached', timeout: 10_000 })
}

let stub
let app
try {
  stub = await startStub(script)
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  const page = app.page

  console.log('# Screens')
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await audit(page, 'the setup wizard')
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await pasteClaudeKey(page)
  await audit(page, 'Settings, AI vendors')
  for (const section of ['General', 'Appearance', 'Agent defaults', 'Tools & Integrations', 'Devices', 'Data', 'About']) {
    await settingsNav(page, section).click()
    await page.waitForTimeout(150)
    await audit(page, `Settings, ${section}`)
  }
  await closeSettings(page)
  await claudeReady(page)
  await audit(page, 'Chat, start screen')

  await say(page, 'Hello there')
  await audit(page, 'Chat, a conversation')

  console.log('\n# Keyboard')
  const insideDialog = () => page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor()
  await page.waitForTimeout(300)
  let trapped = await insideDialog()
  for (let i = 0; i < 45 && trapped; i++) {
    await page.keyboard.press('Tab')
    trapped = await insideDialog()
  }
  check('in a dialog, focus starts inside it and Tab never leaves it', trapped)
  // A tooltip that is showing takes the first Escape (it has to be dismissable on its own); the dialog takes the next.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (await page.getByRole('navigation', { name: 'Settings sections' }).count()) await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached', timeout: 10_000 })
  check('Escape closes it, and focus goes back to the button that opened it', await page.evaluate(() => /Settings/.test(document.activeElement?.textContent ?? '')))
  await page.evaluate(() => document.activeElement?.blur())
  const bare = []
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    const seen = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const css = getComputedStyle(el)
      const ring = css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0
      const name = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName
      return { name, ring, field: /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) }
    })
    if (seen && !seen.ring && !seen.field) bare.push(seen.name)
  }
  check('every control reached with Tab shows where focus is', bare.length === 0, bare.join(', '))
  await page.evaluate(() => document.activeElement?.blur())

  console.log('\n# Messages pile up')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'Tools & Integrations').click()
  for (const n of ['one', 'two', 'three']) {
    await page.getByRole('button', { name: 'Paste a configuration' }).click()
    const paste = page.getByRole('dialog', { name: 'Paste a configuration' })
    await paste.getByLabel('Configuration').fill(JSON.stringify({ mcpServers: { [`not-there-${n}`]: { command: 'definitely-not-a-program-xyz' } } }))
    await paste.getByRole('button', { name: 'Add tool' }).click()
    await paste.waitFor({ state: 'detached', timeout: 15_000 })
  }
  await audit(page, 'Settings, Tools with tools that do not work')
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
  // The pointer rests where the last click was, which can be right where the messages appear; park it out of the way.
  await page.mouse.move(700, 300)
  const toasts = page.getByTestId('toast')
  const stack = page.getByTestId('toast-stack')
  const rows = () => toasts.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, w: r.width })))
  check('three messages are three cards', (await toasts.count()) === 3, String(await toasts.count()))
  check('piled up, they are not spread out', (await stack.getAttribute('data-open')) === 'false')
  const piled = await rows()
  check('the older ones show only as edges behind the newest', Math.max(...piled.map((r) => r.top)) - Math.min(...piled.map((r) => r.top)) <= 30, JSON.stringify(piled))
  check('they really are piled: each older one peeks out a little above the next', new Set(piled.map((r) => Math.round(r.top))).size === 3, JSON.stringify(piled))
  // The newest must be the one on top, with its words showing: whatever is at its centre belongs to it.
  const frontOnTop = await toasts.last().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return Boolean(hit && el.contains(hit)) && el.textContent.trim().length > 0
  })
  check('the newest message is in front and readable', frontOnTop)
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'toasts-piled.png') })
  await audit(page, 'Messages, piled')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(400)
  check('Tabbing into the messages with the keyboard spreads them out too', (await stack.getAttribute('data-open')) === 'true' && (await page.evaluate(() => Boolean(document.querySelector('[data-testid="toast-stack"]')?.contains(document.activeElement)))))
  await page.evaluate(() => document.activeElement?.blur())
  await page.waitForTimeout(400)
  check('and leaving them puts the pile back', (await stack.getAttribute('data-open')) === 'false')
  await stack.hover()
  await page.waitForTimeout(400)
  check('pointing at the pile spreads it out', (await stack.getAttribute('data-open')) === 'true')
  const spread = (await rows()).sort((a, b) => a.top - b.top)
  check('each message has a row of its own, none over another', spread.every((r, i) => i === 0 || r.top >= spread[i - 1].bottom - 1), JSON.stringify(spread))
  await audit(page, 'Messages, spread out')
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'toasts-spread.png') })
  await page.waitForTimeout(8000)
  check('while it is spread out nothing disappears, however long you read', (await toasts.count()) === 3)
  await toasts.nth(1).getByRole('button', { name: 'Dismiss' }).click()
  check('one can be dismissed from the spread', (await toasts.count()) === 2)
  await page.mouse.move(700, 300)
  await page.waitForTimeout(400)
  check('moving away puts the pile back', (await stack.getAttribute('data-open')) === 'false')
  await toasts.first().waitFor({ state: 'detached', timeout: 15_000 })
  check('and the rest go by themselves', (await toasts.count()) === 0)

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Search chats and sessions' }).waitFor()
  await audit(page, 'the search box')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Tools & Integrations' }).first().click()
  await page.getByRole('region', { name: 'Tools' }).waitFor()
  await audit(page, 'the Tools panel')
  await page.getByRole('button', { name: 'Add a tool' }).first().click()
  await page.getByRole('dialog', { name: 'Add a tool' }).waitFor()
  await audit(page, 'the Add a tool dialog')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Manage devices' }).click()
  await page.getByRole('button', { name: 'Add a device' }).first().click()
  await page.getByRole('dialog').first().waitFor()
  await audit(page, 'the Add a device dialog')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
  await audit(page, 'Develop, start screen')
  await app.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  writeFileSync(join(project, 'a.txt'), 'original\n')
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await page.getByText(/celeste-ui-project-/).first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(800)
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('Run the change please')
  await box.press('Enter')
  await page.getByText('Finished that step.').first().waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
  await audit(page, 'Develop, a session')
  for (const panel of ['Files', 'Changes', 'Terminal']) {
    await page.getByRole('button', { name: panel, exact: true }).first().click()
    await page.waitForTimeout(500)
    await audit(page, `Develop, the ${panel} panel`)
  }
  await page.getByRole('button', { name: /^Discard changes to/ }).first().click().catch(() => undefined)
  await page.waitForTimeout(300)
  await audit(page, 'Develop, a confirmation')
  await page.keyboard.press('Escape')

  console.log(`audited ${audited} screens in both themes`)
  const list = [...found.values()]
  writeFileSync(join(import.meta.dirname, '.output', 'a11y.json'), JSON.stringify(list, null, 1))
  const byRule = new Map()
  for (const v of list) byRule.set(v.id, [...(byRule.get(v.id) ?? []), v])
  for (const [id, items] of byRule) {
    console.log(`\n  ${id} (${items[0].impact}): ${items[0].help} — ${items.length} place${items.length === 1 ? '' : 's'}`)
    for (const v of items.slice(0, 6)) console.log(`     [${v.screen}, ${v.theme}] ${v.target}\n        ${v.html}\n        ${v.why}`)
    if (items.length > 6) console.log(`     … and ${items.length - 6} more`)
  }
  check('no accessibility violations on any screen, in either theme', list.length === 0, `${byRule.size} rules, ${list.length} places`)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'ui-failure.png') }).catch(() => undefined)
} finally {
  await app?.app.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const dir of [profile, project]) {
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
