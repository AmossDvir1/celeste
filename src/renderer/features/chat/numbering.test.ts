import { describe, expect, it } from 'vitest'
import { continueNumbering } from '../../../shared/numbering'

describe('continueNumbering', () => {
  it('starts the next number on a new line', () => {
    expect(continueNumbering('1. first', 8)).toEqual({ text: '1. first\n2. ', caret: 12 })
  })

  it('renumbers the items below when a line is inserted in the middle', () => {
    expect(continueNumbering('1. one\n2. two', 6)).toEqual({ text: '1. one\n2. \n3. two', caret: 10 })
  })

  it('renumbers a whole block that follows the new line', () => {
    expect(continueNumbering('1. a\n5. b\n9. c', 4)).toEqual({ text: '1. a\n2. \n3. b\n4. c', caret: 8 })
  })

  it('handles numbers that gain a digit', () => {
    expect(continueNumbering('8. a\n9. b', 4)).toEqual({ text: '8. a\n9. \n10. b', caret: 8 })
  })

  it('moves the text after the caret onto the new item', () => {
    expect(continueNumbering('1. hello world', 8)).toEqual({ text: '1. hello\n2. world', caret: 12 })
  })

  it('keeps indentation and the ) delimiter', () => {
    expect(continueNumbering('  3) x\n  4) y', 6)).toEqual({ text: '  3) x\n  4) \n  5) y', caret: 12 })
  })

  it('stops renumbering at a line that is not part of the list', () => {
    expect(continueNumbering('1. a\nnote\n2. b', 4)).toEqual({ text: '1. a\n2. \nnote\n2. b', caret: 8 })
  })

  it('stops renumbering at an item with a different delimiter', () => {
    expect(continueNumbering('1. a\n2) b', 4)).toEqual({ text: '1. a\n2. \n2) b', caret: 8 })
  })

  it('removes an empty item to end the list', () => {
    expect(continueNumbering('1. ', 3)).toEqual({ text: '', caret: 0 })
    expect(continueNumbering('  2) ', 5)).toEqual({ text: '  ', caret: 2 })
  })

  it('leaves lines that are not list items alone', () => {
    expect(continueNumbering('hello', 5)).toBeNull()
  })

  it('leaves the caret before the marker alone', () => {
    expect(continueNumbering('1. a', 1)).toBeNull()
  })
})
