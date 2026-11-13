import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { extname } from 'node:path'
import { PHONE_ATTACH_PART, PHONE_FILE_MAX_BYTES, type PhoneFilePart } from '@shared/phone'
import { resolveChatFile } from '../chat-files'

/** What a phone is told a file is, by its ending. Anything not listed is sent as plain bytes. */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json'
}

/**
 * One part of a file the assistant made in a chat's private folder, for a phone (`phone.file`). The phone names a chat and a path;
 * the path is checked the way the computer's own window is checked (it must stay inside that chat's folder, links followed, and be a
 * plain file), so a phone cannot read anything else. Only the part asked for is read, so a large file is never held whole.
 */
export function readFilePart(dataDir: string, sessionId: unknown, path: unknown, part: unknown): PhoneFilePart {
  const found = resolveChatFile(dataDir, sessionId, path)
  if ('error' in found) throw new Error(found.error)
  const fd = openSync(found.file, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > PHONE_FILE_MAX_BYTES) throw new Error(`That file is over ${PHONE_FILE_MAX_BYTES / 1_048_576} MB, too large for the phone.`)
    const parts = Math.max(1, Math.ceil(size / PHONE_ATTACH_PART))
    if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part >= parts) throw new Error('That part of the file does not exist.')
    const start = part * PHONE_ATTACH_PART
    const buf = Buffer.alloc(Math.min(PHONE_ATTACH_PART, size - start))
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n === 0) break
      got += n
    }
    const name = (found.file.split(/[\\/]/).pop() as string) || 'file'
    return { name, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', size, part, parts, data: buf.subarray(0, got).toString('base64') }
  } finally {
    closeSync(fd)
  }
}
