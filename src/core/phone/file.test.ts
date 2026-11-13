import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PHONE_ATTACH_PART } from '@shared/phone'
import { readFilePart } from './file'

const ID = 's-12345678-1234-1234-1234-123456789abc'
let dir: string
let chat: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'celeste-file-'))
  chat = join(dir, 'chats', ID)
  mkdirSync(chat, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('phone.file', () => {
  it('sends a small file in one part, with its kind', () => {
    writeFileSync(join(chat, 'a.png'), Buffer.from([1, 2, 3]))
    const r = readFilePart(dir, ID, 'a.png', 0)
    expect(r).toMatchObject({ name: 'a.png', mime: 'image/png', size: 3, part: 0, parts: 1 })
    expect(Buffer.from(r.data, 'base64')).toEqual(Buffer.from([1, 2, 3]))
  })

  it('sends a large file in parts that join back to the same bytes', () => {
    const bytes = Buffer.alloc(PHONE_ATTACH_PART * 2 + 10, 7)
    bytes[PHONE_ATTACH_PART] = 9
    mkdirSync(join(chat, 'out'))
    writeFileSync(join(chat, 'out', 'big.jpg'), bytes)
    const got = [0, 1, 2].map((n) => readFilePart(dir, ID, 'out/big.jpg', n))
    expect(got.map((p) => p.parts)).toEqual([3, 3, 3])
    expect(got.map((p) => Buffer.from(p.data, 'base64').length)).toEqual([PHONE_ATTACH_PART, PHONE_ATTACH_PART, 10])
    expect(Buffer.concat(got.map((p) => Buffer.from(p.data, 'base64')))).toEqual(bytes)
  })

  it('sends an empty file as one empty part', () => {
    writeFileSync(join(chat, 'empty.txt'), '')
    expect(readFilePart(dir, ID, 'empty.txt', 0)).toMatchObject({ size: 0, parts: 1, data: '' })
  })

  it('refuses a part that does not exist', () => {
    writeFileSync(join(chat, 'a.png'), 'x')
    expect(() => readFilePart(dir, ID, 'a.png', 1)).toThrow('does not exist')
    expect(() => readFilePart(dir, ID, 'a.png', -1)).toThrow('does not exist')
    expect(() => readFilePart(dir, ID, 'a.png', '0')).toThrow('does not exist')
  })

  it('refuses anything outside the chat’s folder', () => {
    writeFileSync(join(dir, 'secret.txt'), 'no')
    expect(() => readFilePart(dir, ID, '../../secret.txt', 0)).toThrow()
    expect(() => readFilePart(dir, ID, join(dir, 'secret.txt'), 0)).toThrow()
    expect(() => readFilePart(dir, '../x', 'a.png', 0)).toThrow('not a chat')
    expect(() => readFilePart(dir, ID, 'missing.png', 0)).toThrow()
  })

  it('does not follow a link out of the folder', () => {
    writeFileSync(join(dir, 'secret.txt'), 'no')
    try {
      symlinkSync(join(dir, 'secret.txt'), join(chat, 'link.txt'))
    } catch {
      return // Windows without the right to make links: nothing to test here.
    }
    expect(() => readFilePart(dir, ID, 'link.txt', 0)).toThrow()
  })
})
