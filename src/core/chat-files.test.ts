import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveChatFile } from './chat-files'

const ID = 's-123e4567-e89b-12d3-a456-426614174000'
let data: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'celeste-chatfile-'))
  mkdirSync(join(data, 'chats', ID, 'out'), { recursive: true })
  writeFileSync(join(data, 'chats', ID, 'report.csv'), 'a,b')
  writeFileSync(join(data, 'chats', ID, 'out', 'x.txt'), 'x')
  writeFileSync(join(data, 'secret.txt'), 'not for the window')
})
afterEach(() => rmSync(data, { recursive: true, force: true }))

describe('which file the window may name', () => {
  it('finds a file in the chat’s folder, also in a subfolder', () => {
    expect(resolveChatFile(data, ID, 'report.csv')).toMatchObject({ file: expect.stringMatching(/report\.csv$/) })
    expect(resolveChatFile(data, ID, 'out/x.txt')).toMatchObject({ file: expect.stringMatching(/x\.txt$/) })
  })

  it('refuses a path that climbs out of the folder, an absolute path, and odd input', () => {
    for (const bad of ['../../secret.txt', '..\..\secret.txt', 'out/../../../secret.txt', join(data, 'secret.txt'), '/etc/passwd', 'C:\Windows\win.ini', '', 'a\0b', 5, null, undefined]) {
      expect(resolveChatFile(data, ID, bad), String(bad)).toHaveProperty('error')
    }
  })

  it('refuses anything that is not a chat of ours', () => {
    for (const bad of ['..', 's-../..', 'chats', '', '123e4567-e89b-12d3-a456-426614174000', 5, null]) {
      expect(resolveChatFile(data, bad, 'report.csv'), String(bad)).toHaveProperty('error')
    }
  })

  it('refuses a folder, and a file that is gone', () => {
    expect(resolveChatFile(data, ID, 'out')).toHaveProperty('error')
    expect(resolveChatFile(data, ID, 'missing.txt')).toHaveProperty('error')
  })

  it('refuses a link that leads outside the folder', () => {
    try {
      symlinkSync(join(data, 'secret.txt'), join(data, 'chats', ID, 'link.txt'))
    } catch {
      // Windows may not allow links without special rights; the other checks above still hold.
      return
    }
    expect(resolveChatFile(data, ID, 'link.txt')).toHaveProperty('error')
  })
})
