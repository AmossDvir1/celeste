import type { ModelInfo, VendorId } from '@shared/agent'

/*
 * Naming a new session. After the first message, a small, quick model of the same vendor writes a short title, which the sidebar
 * shows in place of the first words of the message. The vendor is the session's own, so the message goes nowhere it was not
 * already going. If nothing small is on offer, or anything goes wrong, the first words stay as the title.
 */

export interface Titler {
  /** A raw reply from a small model of this vendor, or undefined when it cannot be asked. Never throws for a normal failure. */
  title(vendor: VendorId, text: string): Promise<string | undefined>
}

/** Words in a model's name that mean it is the small, quick, cheap one of its family, best first. */
const SMALL = [/nano/i, /mini/i, /flash/i, /lite/i, /haiku/i, /small/i]

/**
 * The model to ask: the smallest-looking one the vendor lists, going by its name, since the vendors do not say what a model costs.
 * Undefined when none looks small, so a large model is never spent on a title. A model that is only "auto" is not a choice.
 */
export function cheapest(models: ModelInfo[]): ModelInfo | undefined {
  for (const word of SMALL) {
    const found = models.filter((m) => !/^(claude:)?(auto|default)$/i.test(m.id) && word.test(`${m.id} ${m.label}`))
    // Of several, the one with the shortest name is usually the plain version (haiku, not haiku-extended-thinking).
    if (found.length) return [...found].sort((a, b) => a.id.length - b.id.length)[0]
  }
  return undefined
}

/** What the small model is asked. The message is cut short: a title does not need a whole pasted file. */
export function titlePrompt(text: string): string {
  const message = text.length > 1500 ? `${text.slice(0, 1500)}…` : text
  return [
    'Write a title for a conversation that begins with the message below.',
    'Rules: at most 6 words, in the same language as the message, no quotation marks, no full stop at the end.',
    'Describe what it is about; do not answer it and do not address the writer.',
    'Reply with the title and nothing else.',
    '',
    'Message:',
    message
  ].join('\n')
}

/** The instructions to a model that is only here to name things, so a vendor's long default instructions are not paid for. */
export const TITLE_SYSTEM = 'You name conversations. You reply with a short title and nothing else.'

const LONGEST = 60

/** A model's reply as a title: one line, no quotes or markup, or undefined if it is not a title (empty, a refusal, a paragraph). */
export function cleanTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!line) return undefined
  const title = line
    // Bold and code marks are decoration; a title is plain text.
    .replace(/[*`]/g, '')
    .replace(/^[#>\-\s]+/, '')
    .replace(/^(title|name)\s*:\s*/i, '')
    .replace(/^["'“”‘’_]+|["'“”‘’_]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (title.length < 2 || title.length > LONGEST) return undefined
  return title
}
