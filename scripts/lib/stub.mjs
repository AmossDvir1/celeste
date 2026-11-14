// What the app checks use in place of a vendor account: Claude, for real (the real SDK and the real Claude Code program),
// talking to a stand-in for Anthropic's API on this computer (src/core/adapters/claude/fake-anthropic.ts). No account, no cost.
// Needs Claude Code's program beside the SDK, which a normal `npm install` puts there.
import { FakeAnthropic } from '../../src/core/adapters/claude/fake-anthropic.ts'

/** The key a check pastes in. The stand-in accepts any. */
export const KEY = 'sk-ant-api03-a-key-for-the-checks-1234'

/** Answers with what it was asked and a fixed phrase to search for; or, for a message that says HOLD, starts an answer and never ends it. */
export const echo = (r) => {
  if (r.last.kind === 'text' && r.last.text.includes('HOLD')) return [{ type: 'hold' }]
  return [{ type: 'text', text: r.last.kind === 'text' ? `Echo: ${r.last.text}. The canary hosts go first.` : 'Finished' }]
}

/** Starts the stand-in. `api.url` goes to the app as ANTHROPIC_BASE_URL (see `env`). */
export async function startStub(script = echo) {
  const api = new FakeAnthropic(script)
  await api.start()
  return Object.assign(api, { env: { ANTHROPIC_BASE_URL: api.url } })
}

/** Opens a card's key field: the key is a choice in the menu on the right of the Connect button. */
export async function openKeyField(card) {
  await card.getByRole('button', { name: 'More ways to connect' }).click()
  await card.page().getByRole('menuitem', { name: /Paste an API key|I already have a key/ }).click()
}

/** Pastes the key into the Claude card of whatever screen shows it (Settings, or the wizard's Connect step). */
export async function pasteClaudeKey(page) {
  const card = page.getByRole('heading', { name: 'Claude Agent', exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
  await openKeyField(card)
  await card.getByLabel(/API key/).fill(KEY)
  await card.getByRole('button', { name: 'Save key' }).click()
  await card.getByText(/Connected · API key ending 1234/).waitFor({ timeout: 60_000 })
}

/** Waits until Claude's own models have arrived and the composer has settled on one. */
export const claudeReady = (page) =>
  page.waitForFunction(() => /Claude Agent/.test(document.querySelector('[aria-label^="Model:"]')?.getAttribute('aria-label') ?? ''), undefined, { timeout: 60_000 })

/** Sends a message in the open composer and waits for the stand-in's answer to it. */
export async function say(page, text) {
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await box.press('Enter')
  await page.getByText(`Echo: ${text}`, { exact: false }).first().waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
}
