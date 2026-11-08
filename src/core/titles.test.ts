import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@shared/agent'
import { cheapest, cleanTitle, titlePrompt } from './titles'

const model = (id: string, label = id): ModelInfo => ({ id, vendor: 'copilot', label, efforts: [], images: false })

describe('choosing the model that names a session', () => {
  it('takes the small one: nano, then mini, flash, lite, haiku', () => {
    expect(cheapest([model('gpt-5'), model('gpt-5-mini'), model('gpt-5-nano')])?.id).toBe('gpt-5-nano')
    expect(cheapest([model('gpt-5'), model('claude-haiku-4.5'), model('gpt-5-mini')])?.id).toBe('gpt-5-mini')
    expect(cheapest([model('claude:default', 'Default'), model('claude:opus', 'Opus'), model('claude:haiku', 'Haiku')])?.id).toBe('claude:haiku')
  })

  it('prefers the plain version of a small model', () => {
    expect(cheapest([model('claude-haiku-4.5-thinking'), model('claude-haiku-4.5')])?.id).toBe('claude-haiku-4.5')
  })

  it('takes nothing rather than a large model, and never "auto"', () => {
    expect(cheapest([model('gpt-5'), model('claude-opus-5')])).toBeUndefined()
    expect(cheapest([model('auto', 'Auto (mini)')])).toBeUndefined()
    expect(cheapest([])).toBeUndefined()
  })
})

describe('turning a reply into a title', () => {
  it('keeps a plain title', () => {
    expect(cleanTitle('Plan the KB rollout')).toBe('Plan the KB rollout')
  })

  it('removes quotes, markup, a label and the full stop, and keeps the first line', () => {
    expect(cleanTitle('"Plan the KB rollout."')).toBe('Plan the KB rollout')
    expect(cleanTitle('**Title:** Plan the KB rollout')).toBe('Plan the KB rollout')
    expect(cleanTitle('# Plan the KB rollout\n\nHere is why…')).toBe('Plan the KB rollout')
    expect(cleanTitle('“Planifier le déploiement”')).toBe('Planifier le déploiement')
    expect(cleanTitle('  Fix   the   flaky  test  ')).toBe('Fix the flaky test')
  })

  it('refuses what is not a title: nothing, a paragraph, a single character', () => {
    expect(cleanTitle(undefined)).toBeUndefined()
    expect(cleanTitle('')).toBeUndefined()
    expect(cleanTitle('   \n  ')).toBeUndefined()
    expect(cleanTitle('x')).toBeUndefined()
    expect(cleanTitle('I am sorry, but I cannot help with that request because it is outside what I can do.')).toBeUndefined()
  })
})

describe('what the model is asked', () => {
  it('carries the message, cut short when it is very long, and the rules', () => {
    const prompt = titlePrompt('Explain how the build works')
    expect(prompt).toContain('at most 6 words')
    expect(prompt).toContain('same language')
    expect(prompt.endsWith('Message:\nExplain how the build works')).toBe(true)
    expect(titlePrompt('x'.repeat(5000)).length).toBeLessThan(1900)
  })
})
