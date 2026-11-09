import { describe, expect, it } from 'vitest'
import { stepContext } from './context'

const step = (n: number, output = `result ${n}`) => ({ name: `Step ${n}`, task: `do thing ${n}`, output })

describe('what an assistant step is told about the steps before it', () => {
  it('is nothing for the first step', () => {
    expect(stepContext([])).toBe('')
  })

  it('gives each earlier step’s task and result, in order, and ends where the step’s own words go', () => {
    const text = stepContext([step(1), step(2)])
    expect(text.indexOf('do thing 1')).toBeLessThan(text.indexOf('do thing 2'))
    expect(text).toContain('Result: result 1')
    expect(text).toContain('Result: result 2')
    expect(text).toContain('“it”')
    expect(text.endsWith('Your step now:')).toBe(true)
  })

  it('says so when a step produced nothing', () => {
    expect(stepContext([step(1, '   ')])).toContain('Result: (nothing)')
  })

  it('cuts one long result in the middle, keeping its start and its end', () => {
    const text = stepContext([step(1, `START ${'x'.repeat(5000)} END`)])
    expect(text).toContain('START')
    expect(text).toContain('END')
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(2500)
  })

  it('drops the oldest steps first when there are too many, and says how many', () => {
    const many = Array.from({ length: 12 }, (_, i) => step(i + 1, 'y'.repeat(1400)))
    const text = stepContext(many)
    expect(text).toContain('do thing 12')
    expect(text).not.toContain('do thing 1\n')
    expect(text).toMatch(/\(\d+ earlier steps are left out\.\)/)
    expect(text.length).toBeLessThan(7500)
  })

  it('always keeps the latest step, however long', () => {
    const text = stepContext([step(1, 'z'.repeat(100_000))])
    expect(text).toContain('do thing 1')
  })
})
