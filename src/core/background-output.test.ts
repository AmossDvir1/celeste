import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OUTPUT_TAIL, isOutputFile, outputFileFor, readTail } from './background-output'

const dir = mkdtempSync(join(tmpdir(), 'celeste-bgout-'))
const tasks = join(dir, 'claude', 'abc', 'tasks')
mkdirSync(tasks, { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('which files may be shown', () => {
  it('takes only an absolute path to <id>.output in a folder called tasks', () => {
    expect(isOutputFile(join(tasks, 'b1.output'))).toBe(true)
    expect(isOutputFile('tasks/b1.output')).toBe(false)
    expect(isOutputFile(join(dir, 'b1.output'))).toBe(false)
    expect(isOutputFile(join(tasks, 'b1.txt'))).toBe(false)
    expect(isOutputFile(`${tasks}\\..\\..\\secret\\tasks\\x.output`)).toBe(false)
    expect(isOutputFile(undefined)).toBe(false)
    expect(isOutputFile('x'.repeat(2000))).toBe(false)
  })
})

describe('finding the file in a chat\'s log', () => {
  const log = [
    { event: { type: 'background.started', taskId: 'b1' } },
    { event: { type: 'background.output', taskId: 'b1', outputFile: '/a/tasks/b1.output' } },
    { event: { type: 'background.output', taskId: 'b2', outputFile: '/a/tasks/b2.output' } },
    { event: { type: 'background.finished', taskId: 'b1', outputFile: '/a/tasks/b1-final.output' } }
  ]
  it('takes the newest event about that command, and only that command', () => {
    expect(outputFileFor(log, 'b1')).toBe('/a/tasks/b1-final.output')
    expect(outputFileFor(log, 'b2')).toBe('/a/tasks/b2.output')
    expect(outputFileFor(log, 'nope')).toBeUndefined()
  })
})

describe('reading the end of an output file', () => {
  it('reads a short file whole', () => {
    const f = join(tasks, 'short.output')
    writeFileSync(f, 'one\ntwo\n')
    expect(readTail(f)).toEqual({ text: 'one\ntwo\n', truncated: false })
  })

  it('keeps the end of a long one, from a whole line', () => {
    const f = join(tasks, 'long.output')
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    writeFileSync(f, `${lines.join('\n')}\n`)
    const r = readTail(f)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(OUTPUT_TAIL)
    expect(r.text.startsWith('line ')).toBe(true)
    expect(r.text.trimEnd().endsWith('line 19999')).toBe(true)
  })

  it('refuses a file that is not one of these, and says plainly when it is gone', () => {
    expect(() => readTail(join(dir, 'other.txt'))).toThrow('not a file Celeste shows')
    expect(() => readTail(join(tasks, 'gone.output'))).toThrow('not there any more')
  })

  it('does not follow a link out of the folder', () => {
    const target = join(dir, 'secret.txt')
    writeFileSync(target, 'secret')
    const link = join(tasks, 'link.output')
    try {
      symlinkSync(target, link)
    } catch {
      return // links need a privilege on some systems: nothing to check there
    }
    expect(() => readTail(link)).toThrow('not there any more')
  })
})
