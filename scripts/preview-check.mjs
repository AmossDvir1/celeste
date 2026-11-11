// Files shown inside Celeste, in the real built app (docs/FILE_VIEWER_PLAN.md): the check makes real files of every kind (Word, Excel,
// PowerPoint, OpenDocument, RTF, a notebook, Markdown, JSON, CSV, code, a zip, a PDF, an image, a web page, an old .doc), opens each in a
// tab of the browser pane, and looks at what shows. It also checks what must not be possible: the viewer cannot reach Celeste or the
// network, a web page cannot read a file, and the assistant's tools and other programs cannot see a viewer tab.   npm run verify:preview
// Claude is real (the real SDK and program) but what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, startStub } from './lib/stub.mjs'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const XLSX = require('xlsx')
const { chromium } = require('playwright-core')

const profile = mkdtempSync(join(tmpdir(), 'celeste-preview-'))
const dir = mkdtempSync(join(tmpdir(), 'celeste-preview-files-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${String(detail).slice(0, 300)})`}`)
  if (!ok) failures.push(label)
}
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

// ---- the files ---------------------------------------------------------------------------------------------------------------------
const path = (name) => join(dir, name)
const put = (name, data) => writeFileSync(path(name), data)

put('notes.md', '# Project Plan\n\nSome **bold** words and a [link](https://example.com).\n\n## Schedule\n\n| Week | Goal |\n|---|---|\n| 1 | Design |\n| 2 | Build |\n\n```ts\nconst answer = 42\n```\n\n## Risks\n\n- Money\n- Time\n')
put('people.csv', 'name,city,age\nAlice,Paris,31\n"Bob ""B""",Rome,45\nCarol,"Oslo, Norway",28\n')
put('config.json', JSON.stringify({ name: 'celeste', version: 3, tags: ['a', 'b'], nested: { deep: { value: true } } }))
put('broken.json', '{ "a": ')
put('app.ts', 'export const answer = 42\nexport function greet(name: string) {\n  return `Hello ${name}`\n}\n')
put('letter.rtf', String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0 Dear Dana,\par See you on Monday.\par}`)
put('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))
put('page.html', '<!doctype html><title>Hello page</title><h1>Hello from a web page</h1>')
put('photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
put(
  'doc.pdf',
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
)
put(
  'analysis.ipynb',
  JSON.stringify({
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Analysis\n', 'Some notes.'] },
      { cell_type: 'code', execution_count: 1, source: 'print(6 * 7)', outputs: [{ output_type: 'stream', name: 'stdout', text: ['42\n'] }] }
    ]
  })
)

const docx = new JSZip()
docx.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
docx.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
docx.file(
  'word/document.xml',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>Quarterly report</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Revenue grew in every region this quarter.</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Growth</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
)
put('report.docx', await docx.generateAsync({ type: 'nodebuffer' }))

const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Product', 'Units', 'Price'], ['Widget', 120, 9.5], ['Gadget', 75, 24]]), 'Sales')
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Item', 'Cost'], ['Rent', 1800], ['Power', 240]]), 'Costs')
put('book.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
put('book.ods', XLSX.write(book, { type: 'buffer', bookType: 'ods' }))

// A deck made from a full Office template (python-pptx's), 30 KB: pptx-preview reads real decks, and gives up silently on files with a minimal theme.
copyFileSync(join(import.meta.dirname, 'fixtures', 'deck.pptx'), path('deck.pptx'))

const odt = new JSZip()
odt.file('mimetype', 'application/vnd.oasis.opendocument.text')
odt.file('content.xml', '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">Meeting notes</text:h><text:p>The budget was approved.</text:p><text:list><text:list-item><text:p>Send the minutes</text:p></text:list-item></text:list></office:text></office:body></office:document-content>')
put('meeting.odt', await odt.generateAsync({ type: 'nodebuffer' }))

const zip = new JSZip()
zip.file('readme.txt', 'hello')
zip.file('src/index.js', 'console.log(1)')
zip.file('images/logo.png', 'x')
put('bundle.zip', await zip.generateAsync({ type: 'nodebuffer' }))

// ---- the app ----------------------------------------------------------------------------------------------------------------------
// The chat makes two files in its own folder, which is offered as cards under the answer.
const script = (r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: 'Here are your files.' }]
  if (/Make the files/.test(r.last.text)) {
    const command = `node -e "const fs=require('fs');fs.writeFileSync('summary.md','# Chat summary\\n\\nMade by the assistant.\\n');fs.writeFileSync('table.csv','a,b\\n1,2\\n')"`
    return [{ type: 'tool_use', name: 'Bash', input: { command, description: 'Make the files' } }]
  }
  return echo(r)
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
  const box = page.getByRole('textbox', { name: 'Message' })
  const idle = () => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })

  console.log('\n# A file the assistant made')
  await box.fill('Make the files please')
  await box.press('Enter')
  await page.getByText('Here are your files.').first().waitFor({ timeout: 60_000 })
  await idle()
  const pane = page.getByRole('region', { name: 'Browser' })
  const tabs = () => pane.getByTestId('browser-tab')
  const viewer = (name) => app.app.context().pages().find((p) => p.url().startsWith('celeste-view://') && p.url().includes(`n=${encodeURIComponent(name)}`))
  await page.getByRole('button', { name: 'Open summary.md', exact: true }).click()
  await pane.waitFor({ timeout: 10_000 })
  await until('the Markdown viewer', () => viewer('summary.md'))
  check('Open on a file’s card shows it in a tab of the browser pane, which comes up by itself', (await tabs().count()) === 1 && (await tabs().first().innerText()).includes('summary.md'))
  await viewer('summary.md').getByRole('heading', { name: 'Chat summary', level: 1 }).waitFor({ timeout: 10_000 })
  check('a Markdown file is drawn, not shown as text', true)
  check('the address bar shows the file’s path and cannot be typed over', (await pane.getByRole('textbox', { name: 'Address' }).inputValue()).endsWith('summary.md') && (await pane.getByRole('textbox', { name: 'Address' }).getAttribute('readonly')) !== null)
  await page.getByRole('button', { name: 'Open table.csv', exact: true }).click()
  await until('the table viewer', () => viewer('table.csv'))
  await viewer('table.csv').getByRole('table').waitFor({ timeout: 10_000 })
  check('a second file opens in a second tab', (await tabs().count()) === 2)
  await page.getByRole('button', { name: 'Open summary.md', exact: true }).click()
  await page.waitForTimeout(500)
  check('a file that is already open is shown again, not opened twice', (await tabs().count()) === 2)

  // ---- every kind, by the app's own call
  const chatId = (await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))).sessions[0].id
  const open = (name) => page.evaluate(([c, p]) => window.celeste.browser.call('openFile', { chatId: c, path: p }), [chatId, path(name)])
  const VIEW = {
    'notes.md': async (v) => {
      await v.getByRole('heading', { name: 'Project Plan', level: 1 }).waitFor({ timeout: 10_000 })
      // The pane is narrow, so the contents list starts closed, above the text.
      await v.getByRole('button', { name: 'Contents' }).click()
      return (await v.getByRole('cell', { name: 'Design' }).isVisible()) && (await v.getByRole('navigation', { name: 'Contents' }).getByText('Schedule').isVisible()) && /const answer = 42/.test(await v.locator('pre').first().innerText())
    },
    'people.csv': async (v) => {
      await v.getByRole('table').waitFor({ timeout: 10_000 })
      return (await v.getByRole('cell', { name: 'Alice' }).isVisible()) && (await v.getByRole('cell', { name: 'Bob "B"' }).isVisible()) && (await v.getByRole('cell', { name: 'Oslo, Norway' }).isVisible()) && (await v.getByRole('columnheader', { name: 'C' }).isVisible())
    },
    'config.json': async (v) => {
      await v.getByText('celeste').first().waitFor({ timeout: 10_000 })
      await v.getByRole('button', { name: 'Show the text' }).click()
      return /"version"/.test(await v.locator('body').innerText())
    },
    'broken.json': async (v) => {
      await v.getByText(/not valid JSON/).waitFor({ timeout: 10_000 })
      return true
    },
    'app.ts': async (v) => {
      await v.getByText('export const answer = 42').waitFor({ timeout: 10_000 })
      return (await v.getByText('4', { exact: true }).first().isVisible()) && (await v.getByText('4 lines').isVisible())
    },
    'report.docx': async (v) => {
      await v.getByText('Quarterly report').waitFor({ timeout: 20_000 })
      return (await v.getByText('Revenue grew in every region this quarter.').isVisible()) && (await v.getByText('North').isVisible())
    },
    'book.xlsx': async (v) => {
      await v.getByRole('cell', { name: 'Widget' }).waitFor({ timeout: 20_000 })
      await v.getByRole('tab', { name: 'Costs' }).click()
      await v.getByRole('cell', { name: 'Rent' }).waitFor({ timeout: 5000 })
      return (await v.getByRole('cell', { name: '1800' }).isVisible()) && (await v.getByRole('tab', { name: 'Sales' }).isVisible())
    },
    'book.ods': async (v) => {
      await v.getByRole('cell', { name: 'Gadget' }).waitFor({ timeout: 20_000 })
      return true
    },
    'deck.pptx': async (v) => {
      await v.getByText('Roadmap 2027').waitFor({ timeout: 30_000 })
      const text = await v.locator('body').innerText()
      return /3 slides/.test(text) && /Second slide: hiring plan/.test(text) && /Salaries/.test(text)
    },
    'meeting.odt': async (v) => {
      await v.getByRole('heading', { name: 'Meeting notes' }).waitFor({ timeout: 10_000 })
      return (await v.getByText('The budget was approved.').isVisible()) && (await v.getByText('Send the minutes').isVisible()) && (await v.getByText(/simplified view/i).isVisible())
    },
    'letter.rtf': async (v) => {
      await v.getByText('Dear Dana,').waitFor({ timeout: 10_000 })
      return (await v.getByText(/See you on Monday/).isVisible()) && !/Arial/.test(await v.locator('body').innerText())
    },
    'analysis.ipynb': async (v) => {
      await v.getByRole('heading', { name: 'Analysis', level: 1, exact: true }).waitFor({ timeout: 10_000 })
      return (await v.getByText('print(6 * 7)').isVisible()) && (await v.getByText('42', { exact: true }).isVisible())
    },
    'bundle.zip': async (v) => {
      await v.getByText('src/index.js').waitFor({ timeout: 10_000 })
      return (await v.getByText('readme.txt').isVisible()) && (await v.getByText('images/logo.png').isVisible()) && /3 files/.test(await v.locator('body').innerText())
    },
    'old.doc': async (v) => {
      await v.getByText(/\.docx/).waitFor({ timeout: 10_000 })
      return (await v.getByRole('heading', { name: 'old.doc' }).isVisible()) && (await v.getByText(/old format/i).isVisible())
    }
  }
  // CELESTE_PREVIEW_SHOTS=<folder> saves a picture of each viewer: the page is a native layer a window screenshot does not hold, so its own
  // picture is laid over the window's, where it sits.
  const shotsDir = process.env['CELESTE_PREVIEW_SHOTS']
  const snap = async (name) => {
    if (!shotsDir) return
    const { PNG } = require('pngjs')
    mkdirSync(shotsDir, { recursive: true })
    await page.waitForTimeout(600)
    const window_ = PNG.sync.read(await page.screenshot())
    const grabbed = await app.app.evaluate(async ({ BrowserWindow, webContents }, n) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(`n=${n}`))
      const v = wc && BrowserWindow.getAllWindows()[0]?.contentView.children.find((c) => c.webContents === wc)
      return wc && v ? { bounds: v.getBounds(), png: (await wc.capturePage()).toPNG().toString('base64') } : null
    }, encodeURIComponent(name))
    if (grabbed) {
      const shot = PNG.sync.read(Buffer.from(grabbed.png, 'base64'))
      PNG.bitblt(shot, window_, 0, 0, Math.min(shot.width, grabbed.bounds.width), Math.min(shot.height, grabbed.bounds.height), grabbed.bounds.x, grabbed.bounds.y)
    }
    writeFileSync(join(shotsDir, `${name}.png`), PNG.sync.write(window_))
  }
  console.log('\n# Each kind of file')
  for (const [name, looks] of Object.entries(VIEW)) {
    try {
      const r = await open(name)
      await until(`the viewer for ${name}`, () => viewer(name))
      const ok = await looks(viewer(name))
      await snap(name)
      if (ok !== true) console.log(`      (${name} says: ${String(await viewer(name).locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240)})`)
      check(`${name} opens in the viewer (${r.how}) and shows what it holds`, ok === true && r.how !== 'native')
    } catch (e) {
      const shown = await viewer(name)?.locator('body').innerText().catch(() => '')
      check(`${name} opens in the viewer and shows what it holds`, false, `${e.message.split('\n')[0]} | the page says: ${String(shown).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }

  console.log('\n# Accessibility of the viewer, in both themes')
  const axeSource = require('axe-core').source
  const audit = async (name) => {
    await open(name)
    await until(`the viewer for ${name}`, () => viewer(name))
    const v = viewer(name)
    const found = []
    for (const theme of ['dark', 'light']) {
      await v.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
      await v.waitForTimeout(350)
      if (!(await v.evaluate(() => Boolean(window.axe)))) await v.evaluate(axeSource)
      const violations = await v.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] })
        return result.violations.map((x) => ({ id: x.id, targets: x.nodes.slice(0, 2).map((n) => n.target.join(' > ')) }))
      })
      found.push(...violations.map((x) => `${theme}: ${x.id} (${x.targets.join(' | ')})`))
    }
    return found
  }
  for (const name of ['notes.md', 'people.csv', 'app.ts', 'report.docx', 'book.xlsx', 'deck.pptx', 'meeting.odt', 'letter.rtf', 'analysis.ipynb', 'bundle.zip', 'old.doc']) {
    try {
      const found = await audit(name)
      check(`${name}: no accessibility violations`, found.length === 0, found.join('; '))
    } catch (e) {
      check(`${name}: no accessibility violations`, false, e.message.split('\n')[0])
    }
  }

  console.log('\n# What Chromium shows itself')
  for (const [name, type] of [['photo.png', 'png'], ['doc.pdf', 'pdf'], ['page.html', 'html']]) {
    const r = await open(name)
    await until(`the ${name} tab`, () => app.app.context().pages().some((p) => p.url().toLowerCase().endsWith(`/${name}`)))
    check(`${name} is shown by Chromium on its own address, not by the viewer`, r.how === 'native' && !viewer(name))
  }
  const html = app.app.context().pages().find((p) => p.url().endsWith('page.html'))
  await html.getByRole('heading', { name: 'Hello from a web page' }).waitFor({ timeout: 10_000 })
  check('a web page runs as a page', true)

  console.log('\n# The pane for a file')
  await open('report.docx')
  const docTab = tabs().filter({ hasText: 'report.docx' })
  await docTab.getByRole('tab').or(docTab).first().click().catch(() => undefined)
  check('a file’s tab is named after the file', (await docTab.count()) === 1)
  await pane.getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu')
  check('its menu offers the file’s own program and its folder', (await menu.getByRole('menuitem', { name: /Open in your own program/ }).isVisible()) && (await menu.getByRole('menuitem', { name: /Show in its folder/ }).isVisible()) && (await menu.getByRole('menuitem', { name: /Open a file/ }).isVisible()))
  await page.keyboard.press('Escape')
  check('back and forward are not offered for a file', (await pane.getByRole('button', { name: /^Back/ }).isDisabled()) && (await pane.getByRole('button', { name: /^Forward/ }).isDisabled()))

  console.log('\n# What must not be possible')
  const v = viewer('report.docx')
  check('the viewer has no connection to Celeste', (await v.evaluate(() => [typeof window.celeste, typeof require, typeof process])).join() === 'undefined,undefined,undefined')
  const calls = await v.evaluate(async () => {
    const tries = {}
    for (const [name, url] of Object.entries({ web: 'https://example.com/', other: 'celeste-file://attachments/x.png', local: 'file:///C:/Windows/win.ini', fake: 'celeste-view://app/__file/00000000000000000000000000000000/x', app: 'celeste-view://app/index.html' })) {
      tries[name] = await fetch(url).then((r) => `status ${r.status}`, () => 'blocked')
    }
    return tries
  })
  check('it cannot fetch from the web, from other files, or from a token it was not given', calls.web === 'blocked' && calls.other === 'blocked' && calls.local === 'blocked' && (calls.fake === 'blocked' || calls.fake === 'status 404') && (calls.app === 'blocked' || calls.app === 'status 404'), JSON.stringify(calls))
  const fromWeb = await html.evaluate(() => fetch('celeste-view://app/viewer.html').then((r) => `status ${r.status}`, () => 'blocked'))
  check('a web page cannot read through the viewer’s address', fromWeb === 'blocked', fromWeb)
  const external = await page.evaluate(() => window.celeste.browser.call('external', { on: true }))
  const outside = await chromium.connectOverCDP(external.endpoint)
  const seen = outside.contexts()[0].pages().map((p) => p.url())
  check('another program sees the pages Chromium shows, and no viewer tab', seen.some((u) => u.endsWith('page.html')) && !seen.some((u) => u.startsWith('celeste-view://')), seen.join(' '))
  await outside.close().catch(() => undefined)
  await page.evaluate(() => window.celeste.browser.call('external', { on: false }))

  console.log('\n# Opening a file')
  const refusal = await page.evaluate(([c, p]) => window.celeste.browser.call('openFile', { chatId: c, path: p }).then(() => 'opened', (e) => String(e.message)), [chatId, path('no-such-file.docx')])
  check('a file that is not there is refused in words', /no longer there/.test(refusal), refusal)
  const relative = await page.evaluate((c) => window.celeste.browser.call('openFile', { chatId: c, path: 'notes.md' }).then(() => 'opened', (e) => String(e.message)), chatId)
  check('and so is a path that is not complete', /not the path of a file/.test(relative), relative)
  const folder = await page.evaluate(([c, p]) => window.celeste.browser.call('openFile', { chatId: c, path: p }).then(() => 'opened', (e) => String(e.message)), [chatId, dir])
  check('and a folder', /not a file/.test(folder), folder)
  await page.evaluate((c) => window.celeste.browser.call('closeChat', { chatId: c }), chatId)
  await page.waitForTimeout(500)
  check('closing the chat closes its file tabs and forgets their files', (await app.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith('celeste-view://')).length)) === 0)
} catch (err) {
  console.error(err)
  failures.push(String(err?.message ?? err))
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const d of [profile, dir]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 })
    } catch {
      // A leftover temporary folder is harmless.
    }
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll preview checks passed.')
process.exit(failures.length ? 1 : 0)
