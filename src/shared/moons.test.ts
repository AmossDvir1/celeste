import { describe, expect, it } from 'vitest'
import { MAX_FINDINGS, MAX_STEPS, MOON_PATTERN_ORDER, MOON_TEXT_MAX, PATTERNS, matchFindings, mention, moonName, otherSeat, readBlock, readFix, readPlan, readReview, readTest, withoutBlock, type Finding } from './moons'

const fence = (json: string, info = 'moons') => '```' + info + '\n' + json + '\n```'

describe('the patterns', () => {
  it('are listed in the order of the picker, and each has a pen and a track', () => {
    expect(MOON_PATTERN_ORDER).toEqual(['build', 'plan', 'bug', 'reviews'])
    expect(MOON_PATTERN_ORDER.map((p) => PATTERNS[p].label)).toEqual(['Build and review', 'Plan, then build', 'Find and fix a bug', 'Two reviews'])
    expect(PATTERNS.build).toMatchObject({ roles: ['builder', 'reviewer'], pen: 0, track: ['Build', 'Review', 'Fix', 'Check'] })
    expect(PATTERNS.plan).toMatchObject({ roles: ['planner', 'builder'], pen: 1, track: ['Plan', 'You agree', 'Build'] })
    expect(PATTERNS.bug).toMatchObject({ roles: ['tester', 'builder'], pen: 1, track: ['Make it happen', 'Fix', 'Try again'] })
    expect(PATTERNS.reviews).toMatchObject({ roles: ['reviewer', 'reviewer'], pen: 0, track: ['Review apart', 'Compare'] })
  })

  it('name the moons, and number them when both have the same role', () => {
    expect([moonName('build', 0), moonName('build', 1)]).toEqual(['Builder', 'Reviewer'])
    expect([moonName('plan', 0), moonName('plan', 1)]).toEqual(['Planner', 'Builder'])
    expect([moonName('bug', 0), moonName('bug', 1)]).toEqual(['Tester', 'Builder'])
    expect([moonName('reviews', 0), moonName('reviews', 1)]).toEqual(['Reviewer 1', 'Reviewer 2'])
  })

  it('say which seat is the child session', () => {
    expect(otherSeat('build')).toBe(1)
    expect(otherSeat('plan')).toBe(0)
    expect(otherSeat('bug')).toBe(0)
    expect(otherSeat('reviews')).toBe(1)
  })
})

describe('finding the block in a reply', () => {
  it('reads a block at the end of the words', () => {
    expect(readBlock('Looks fine.\n\n' + fence('{"say": "ok", "findings": []}'))).toEqual({ say: 'ok', findings: [] })
  })

  it('takes the last block when there are two', () => {
    expect(readBlock(fence('{"a": 1}') + '\nmore words\n' + fence('{"a": 2}'))).toEqual({ a: 2 })
  })

  it('accepts json in the words of the fence', () => {
    expect(readBlock(fence('{"a": 1}', 'moons json'))).toEqual({ a: 1 })
    expect(readBlock(fence('{"a": 1}', 'MOONS'))).toEqual({ a: 1 })
  })

  it('reads a block that never closed when the JSON is complete, and not when it is cut short', () => {
    expect(readBlock('Done.\n```moons\n{"say": "ok"}')).toEqual({ say: 'ok' })
    expect(readBlock('Done.\n```moons\n{"say": "ok", "findi')).toBeUndefined()
    expect(readBlock('Done.\n```moons\n')).toBeUndefined()
    expect(readBlock('Done.\n```moons')).toBeUndefined()
  })

  it('ignores other fences, other words that start with moons, and a block that is not an object', () => {
    expect(readBlock('```json\n{"a": 1}\n```')).toBeUndefined()
    expect(readBlock('```moonshot\n{"a": 1}\n```')).toBeUndefined()
    expect(readBlock(fence('[1, 2]'))).toBeUndefined()
    expect(readBlock(fence('"text"'))).toBeUndefined()
    expect(readBlock(fence('null'))).toBeUndefined()
    expect(readBlock('no block here')).toBeUndefined()
  })

  it('does not forgive a trailing comma, and does not take a later broken block as the earlier good one', () => {
    expect(readBlock(fence('{"a": 1,}'))).toBeUndefined()
    expect(readBlock(fence('{"a": 1}') + '\n' + fence('{"a": '))).toBeUndefined()
  })

  it('is not fooled by a moons fence written inside another code fence', () => {
    const text = '```md\nEnd your reply with:\n```moons\n{"a": 1}\n```\n'
    // The outer fence is still open at the inner words, so they are only text in it.
    expect(readBlock(text)).toBeUndefined()
    expect(withoutBlock(text)).toBe(text)
  })

  it('reads a block that follows words on the same line, and keeps the words', () => {
    const text = 'Looks fine. ```moons\n{"say": "ok"}\n```'
    expect(readBlock(text)).toEqual({ say: 'ok' })
    expect(withoutBlock(text)).toBe('Looks fine.')
    expect(readBlock('Use a ```moons block to answer.')).toBeUndefined()
    expect(withoutBlock('Use a ```moons block to answer.')).toBe('Use a ```moons block to answer.')
  })

  it('reads a block that has words after it, and does not read JSON with smart quotes', () => {
    const text = fence('{"say": "ok"}') + '\nHope that helps!'
    expect(readBlock(text)).toEqual({ say: 'ok' })
    expect(withoutBlock(text)).toBe('Hope that helps!')
    expect(readBlock(fence('{“say”: “ok”}'))).toBeUndefined()
  })

  it('copes with Windows line endings and a fence with spaces before it', () => {
    expect(readBlock('Fine.\r\n```moons\r\n{"a": 1}\r\n```\r\n')).toEqual({ a: 1 })
    expect(readBlock('Fine.\n  ```moons\n{"a": 1}\n  ```')).toEqual({ a: 1 })
  })

  it('reads the JSON when it is on the line of the fence, or the closing fence is on the line of the JSON', () => {
    expect(readBlock('```moons {"a": 1}```')).toEqual({ a: 1 })
    expect(readBlock('```moons\n{"a": 1}```')).toEqual({ a: 1 })
    expect(readBlock('```moons json\n{\n  "a": 1\n}\n```')).toEqual({ a: 1 })
  })

  it('reads a block with a longer fence and with code in its text', () => {
    expect(readBlock('````moons\n{"code": "```ts\\nlet a\\n```"}\n````')).toEqual({ code: '```ts\nlet a\n```' })
  })
})

describe('withoutBlock', () => {
  it('leaves a text with no block as it is', () => {
    expect(withoutBlock('Just words.\n')).toBe('Just words.\n')
  })

  it('takes the block off the end and the blank lines before it', () => {
    expect(withoutBlock('All good.\n\n' + fence('{"say": "ok"}') + '\n')).toBe('All good.')
  })

  it('takes off every block, and keeps the words around them', () => {
    expect(withoutBlock('One.\n' + fence('{"a":1}') + '\nTwo.\n' + fence('{"a":2}'))).toBe('One.\nTwo.')
  })

  it('hides a block that is still arriving', () => {
    expect(withoutBlock('Words.\n```moons\n{"say": "o')).toBe('Words.')
    expect(withoutBlock('Words.\n```moons')).toBe('Words.')
    expect(withoutBlock('Words.\n```moons json\n{"a": 1}')).toBe('Words.')
  })

  it('hides a fence that has only arrived as far as three backticks and part of the word', () => {
    expect(withoutBlock('Words.\n```')).toBe('Words.')
    expect(withoutBlock('Words.\n```m')).toBe('Words.')
    expect(withoutBlock('Words.\n```mo')).toBe('Words.')
    expect(withoutBlock('Words.\n\n```moon')).toBe('Words.')
    expect(withoutBlock('```mo')).toBe('')
  })

  it('does not hide a partial fence that is not at the very end, or is not three backticks', () => {
    expect(withoutBlock('Words.\n```mo\nmore')).toBe('Words.\n```mo\nmore')
    expect(withoutBlock('Use `mo')).toBe('Use `mo')
    expect(withoutBlock('Words.\n``')).toBe('Words.\n``')
  })

  it('does not touch other code fences', () => {
    const code = 'Here:\n```ts\nconst a = 1\n```\nDone.'
    expect(withoutBlock(code)).toBe(code)
    expect(withoutBlock(code + '\n' + fence('{"a":1}'))).toBe(code)
    // The closing fence of a code block at the very end is the end of that block, not the start of a moons block.
    expect(withoutBlock('Here:\n```ts\nconst a = 1\n```')).toBe('Here:\n```ts\nconst a = 1\n```')
    expect(withoutBlock('Here:\n```ts\nconst a = 1\n')).toBe('Here:\n```ts\nconst a = 1\n')
  })

  it('agrees with readBlock about what is a block', () => {
    expect(withoutBlock('A\n```moonshot\nx\n```')).toBe('A\n```moonshot\nx\n```')
  })
})

describe('reading a review', () => {
  const block = (o: unknown) => 'Words.\n' + fence(JSON.stringify(o))

  it('reads the sentence and the findings', () => {
    const reply = readReview(block({ say: ' Two problems. ', findings: [{ text: ' No check for empty ', file: 'src/a.ts', line: 12, code: 'if (x) {' }, { text: 'Second' }] }))
    expect(reply).toEqual({ say: 'Two problems.', findings: [{ text: 'No check for empty', file: 'src/a.ts', line: 12, code: 'if (x) {' }, { text: 'Second' }] })
  })

  it('accepts nothing wrong as an empty list', () => {
    expect(readReview(block({ say: 'Nothing found.', findings: [] }))).toEqual({ say: 'Nothing found.', findings: [] })
  })

  it('is undefined when a required field is missing or of the wrong type', () => {
    expect(readReview('no block')).toBeUndefined()
    expect(readReview(block({ findings: [] }))).toBeUndefined()
    expect(readReview(block({ say: 1, findings: [] }))).toBeUndefined()
    expect(readReview(block({ say: 'x' }))).toBeUndefined()
    expect(readReview(block({ say: 'x', findings: 'many' }))).toBeUndefined()
    expect(readReview(block({ say: 'x', findings: { text: 'a' } }))).toBeUndefined()
  })

  it('takes a line that is a number or digits, and drops a line that is not a line, but keeps the finding', () => {
    const lines = [7, '8', ' 9 ', 0, -3, 2.5, '12abc', 'ten', null, true, '', '1.5']
    const reply = readReview(block({ say: 'x', findings: lines.map((line) => ({ text: 't', line })) }))
    expect(reply?.findings.map((f) => f.line)).toEqual([7, 8, 9, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined])
    expect(reply?.findings).toHaveLength(lines.length > MAX_FINDINGS ? MAX_FINDINGS : lines.length)
    expect(reply?.findings.every((f) => !('line' in f) || typeof f.line === 'number')).toBe(true)
  })

  it('drops findings with no text, and entries that are not objects', () => {
    const reply = readReview(block({ say: 'x', findings: [{ text: '' }, { text: '   ' }, { text: 5 }, { file: 'a.ts' }, 'text', null, [], { text: 'real' }] }))
    expect(reply?.findings).toEqual([{ text: 'real' }])
  })

  it('drops a file or code of the wrong type and keeps the finding', () => {
    const reply = readReview(block({ say: 'x', findings: [{ text: 't', file: 3, code: {}, line: 4 }, { text: 'u', file: '  ', code: '' }] }))
    expect(reply?.findings).toEqual([{ text: 't', line: 4 }, { text: 'u' }])
  })

  it('cuts every text at 600 characters and keeps at most 12 findings', () => {
    const long = 'a'.repeat(MOON_TEXT_MAX + 50)
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `n${i}` }))
    const reply = readReview(block({ say: long, findings: [{ text: long, code: long, file: long }, ...many] }))
    expect(reply?.say).toHaveLength(MOON_TEXT_MAX)
    expect(reply?.findings[0]).toMatchObject({ text: 'a'.repeat(MOON_TEXT_MAX), code: 'a'.repeat(MOON_TEXT_MAX) })
    expect(reply?.findings).toHaveLength(MAX_FINDINGS)
    expect(reply?.findings[1]?.text).toBe('n0')
  })

  it('does not count the dropped entries against the 12', () => {
    const entries = [...Array.from({ length: 5 }, () => ({ text: '' })), ...Array.from({ length: 12 }, (_, i) => ({ text: `n${i}` }))]
    expect(readReview(block({ say: 'x', findings: entries }))?.findings).toHaveLength(12)
  })
})

describe('reading a fix', () => {
  const block = (o: unknown) => fence(JSON.stringify(o))

  it('reads the answers', () => {
    expect(readFix(block({ say: ' Done. ', answers: [{ n: 1, fixed: true }, { n: 2, fixed: false, say: ' It is already handled. ' }] }))).toEqual({
      say: 'Done.',
      answers: [{ n: 1, fixed: true }, { n: 2, fixed: false, say: 'It is already handled.' }]
    })
  })

  it('drops answers whose number or fixed is wrong, and keeps the rest', () => {
    const answers = [{ n: 0, fixed: true }, { n: -1, fixed: true }, { n: 1.5, fixed: true }, { n: '2', fixed: true }, { n: 3, fixed: 'yes' }, { n: 4 }, { fixed: true }, 7, null, { n: 5, fixed: true, say: 9 }]
    expect(readFix(block({ say: 'x', answers }))?.answers).toEqual([{ n: 5, fixed: true }])
  })

  it('is undefined without a sentence or without a list of answers', () => {
    expect(readFix(block({ answers: [] }))).toBeUndefined()
    expect(readFix(block({ say: 'x' }))).toBeUndefined()
    expect(readFix(block({ say: 'x', answers: 'all' }))).toBeUndefined()
    expect(readFix('plain words')).toBeUndefined()
  })

  it('cuts texts at 600 characters', () => {
    const long = 'b'.repeat(900)
    const reply = readFix(block({ say: long, answers: [{ n: 1, fixed: false, say: long }] }))
    expect(reply?.say).toHaveLength(MOON_TEXT_MAX)
    expect(reply?.answers[0]?.say).toHaveLength(MOON_TEXT_MAX)
  })
})

describe('reading a plan', () => {
  const block = (o: unknown) => fence(JSON.stringify(o))

  it('reads the steps, trimmed', () => {
    expect(readPlan(block({ say: 'Plan.', steps: [' Add the table ', 'Write the test'] }))).toEqual({ say: 'Plan.', steps: ['Add the table', 'Write the test'] })
  })

  it('drops steps that are not text or are empty, and keeps at most 20', () => {
    expect(readPlan(block({ say: 'x', steps: ['a', '', 4, null, '  ', { text: 'b' }, 'c'] }))?.steps).toEqual(['a', 'c'])
    const many = Array.from({ length: 30 }, (_, i) => `s${i}`)
    const reply = readPlan(block({ say: 'x', steps: many }))
    expect(reply?.steps).toHaveLength(MAX_STEPS)
    expect(reply?.steps[19]).toBe('s19')
  })

  it('cuts a step at 600 characters', () => {
    expect(readPlan(block({ say: 'x', steps: ['c'.repeat(700)] }))?.steps[0]).toHaveLength(MOON_TEXT_MAX)
  })

  it('is undefined when the sentence or the steps are missing or of the wrong type', () => {
    expect(readPlan(block({ steps: ['a'] }))).toBeUndefined()
    expect(readPlan(block({ say: 'x' }))).toBeUndefined()
    expect(readPlan(block({ say: 'x', steps: 'a, b' }))).toBeUndefined()
  })
})

describe('reading a test', () => {
  const block = (o: unknown) => fence(JSON.stringify(o))

  it('reads a failure with its place', () => {
    expect(readTest(block({ say: 'It crashes.', failed: true, file: 'a.test.ts', line: '40', code: 'expect(x).toBe(1)' }))).toEqual({ say: 'It crashes.', failed: true, file: 'a.test.ts', line: 40, code: 'expect(x).toBe(1)' })
  })

  it('reads a pass with no place', () => {
    expect(readTest(block({ say: 'It works.', failed: false }))).toEqual({ say: 'It works.', failed: false })
  })

  it('is undefined when failed is not a boolean, or the sentence is missing', () => {
    expect(readTest(block({ say: 'x', failed: 'true' }))).toBeUndefined()
    expect(readTest(block({ say: 'x' }))).toBeUndefined()
    expect(readTest(block({ failed: true }))).toBeUndefined()
  })

  it('drops a bad line and keeps the rest', () => {
    expect(readTest(block({ say: 'x', failed: true, line: 0, file: 'a.ts' }))).toEqual({ say: 'x', failed: true, file: 'a.ts' })
  })
})

describe('matching the findings of two reviews', () => {
  const f = (text: string, file?: string, line?: number): Finding => ({ text, ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}) })

  it('matches the same file within 3 lines, and keeps the rest apart', () => {
    const a = [f('a1', 'src/a.ts', 10), f('a2', 'src/b.ts', 5), f('a3', 'src/c.ts', 1)]
    const b = [f('b1', 'src/a.ts', 13), f('b2', 'src/b.ts', 9)]
    const m = matchFindings(a, b)
    expect(m.both).toEqual([{ a: a[0], b: b[0] }])
    expect(m.first).toEqual([a[1], a[2]])
    expect(m.second).toEqual([b[1]])
  })

  it('compares files without regard to slashes or case', () => {
    const m = matchFindings([f('x', 'Src\\Core\\A.ts', 4)], [f('y', './src/core/a.ts', 5)])
    expect(m.both).toHaveLength(1)
    expect(m.first).toEqual([])
    expect(m.second).toEqual([])
  })

  it('does not match different files, or lines more than 3 apart', () => {
    expect(matchFindings([f('x', 'a.ts', 1)], [f('x', 'b.ts', 1)]).both).toEqual([])
    expect(matchFindings([f('x', 'a.ts', 1)], [f('x', 'a.ts', 5)]).both).toEqual([])
    expect(matchFindings([f('x', 'a.ts', 1)], [f('x', 'a.ts', 4)]).both).toHaveLength(1)
  })

  it('matches findings with no line only when the words are equal', () => {
    const m = matchFindings([f('Missing  check', 'a.ts'), f('other', 'a.ts')], [f('missing check', 'a.ts')])
    expect(m.both).toHaveLength(1)
    expect(m.first).toEqual([f('other', 'a.ts')])
    expect(matchFindings([f('one', 'a.ts')], [f('two', 'a.ts')]).both).toEqual([])
    expect(matchFindings([f('same')], [f('same')]).both).toHaveLength(1)
    expect(matchFindings([f('same')], [f('different')]).both).toEqual([])
  })

  it('does not match a finding with a line to one without, when the words differ', () => {
    expect(matchFindings([f('x', 'a.ts', 3)], [f('y', 'a.ts')]).both).toEqual([])
  })

  it('uses each finding once, and prefers the closest line', () => {
    const a = [f('a1', 'a.ts', 10), f('a2', 'a.ts', 12)]
    const b = [f('b1', 'a.ts', 12)]
    const m = matchFindings(a, b)
    expect(m.both).toEqual([{ a: a[1], b: b[0] }])
    expect(m.first).toEqual([a[0]])
    expect(m.second).toEqual([])

    const two = matchFindings([f('a1', 'a.ts', 10)], [f('b1', 'a.ts', 8), f('b2', 'a.ts', 11)])
    expect(two.both.map((p) => p.b.text)).toEqual(['b2'])
    expect(two.second.map((x) => x.text)).toEqual(['b1'])
  })

  it('handles empty lists', () => {
    expect(matchFindings([], [])).toEqual({ both: [], first: [], second: [] })
    expect(matchFindings([f('x', 'a.ts', 1)], [])).toEqual({ both: [], first: [f('x', 'a.ts', 1)], second: [] })
  })
})

describe('writing to one moon', () => {
  it('finds the moon at the start, with or without a colon or comma', () => {
    expect(mention('build', '@Reviewer please look at the cache')).toEqual({ seat: 1, rest: 'please look at the cache' })
    expect(mention('build', '@Reviewer: is this safe?')).toEqual({ seat: 1, rest: 'is this safe?' })
    expect(mention('build', '@reviewer, is this safe?')).toEqual({ seat: 1, rest: 'is this safe?' })
    expect(mention('build', '  \n@BUILDER do it')).toEqual({ seat: 0, rest: 'do it' })
    expect(mention('plan', '@planner a plan for the login')).toEqual({ seat: 0, rest: 'a plan for the login' })
    expect(mention('bug', '@Tester try with no network')).toEqual({ seat: 0, rest: 'try with no network' })
  })

  it('matches Reviewer 2 before Reviewer, and says neither for a plain Reviewer when both are reviewers', () => {
    expect(mention('reviews', '@Reviewer 2 look at the tests')).toEqual({ seat: 1, rest: 'look at the tests' })
    expect(mention('reviews', '@reviewer 1: and you?')).toEqual({ seat: 0, rest: 'and you?' })
    expect(mention('reviews', '@Reviewer2 hi')).toEqual({ seat: 1, rest: 'hi' })
    expect(mention('reviews', '@Reviewer please look')).toBeNull()
    expect(mention('reviews', '@Reviewer 3 please look')).toBeNull()
  })

  it('is null when nothing follows, when the text does not start with the name, and when it is a longer word', () => {
    expect(mention('build', '@Reviewer')).toBeNull()
    expect(mention('build', '@Reviewer:  ')).toBeNull()
    expect(mention('build', 'ask @Reviewer to look')).toBeNull()
    expect(mention('build', '@Reviewers look')).toBeNull()
    expect(mention('build', '@Tester look')).toBeNull()
    expect(mention('build', 'Reviewer look')).toBeNull()
    expect(mention('build', '')).toBeNull()
  })
})
