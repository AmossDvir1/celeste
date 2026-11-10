import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedApk, fetchReleasedApk } from './apk'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'celeste-apk-'))
  dirs.push(d)
  return d
}

function release(files: Record<string, Buffer | string>) {
  const asked: string[] = []
  const f = async (url: string) => {
    asked.push(url)
    const name = url.split('/').pop() as string
    const body = files[name]
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      arrayBuffer: async () => Uint8Array.from(Buffer.from(body ?? '')).buffer,
      text: async () => String(body ?? '')
    }
  }
  return { f, asked }
}

describe('the released app', () => {
  const apk = Buffer.from('PK fake apk bytes')
  const sum = createHash('sha256').update(apk).digest('hex')

  it('is fetched once for this version, checked against the release’s checksums, and kept', async () => {
    const dir = tmp()
    const r = release({ 'SHA256SUMS.txt': `${sum}  Celeste-1.2.0.apk\nabc  Celeste-Setup.exe\n`, 'Celeste-1.2.0.apk': apk })
    const file = await fetchReleasedApk(dir, '1.2.0', r.f)
    expect(file).toBe(cachedApk(dir, '1.2.0'))
    expect(readFileSync(file as string)).toEqual(apk)
    expect(r.asked[1]).toBe('https://github.com/AmossDvir1/celeste/releases/download/v1.2.0/Celeste-1.2.0.apk')
    // Kept: not fetched again.
    expect(await fetchReleasedApk(dir, '1.2.0', r.f)).toBe(file)
    expect(r.asked).toHaveLength(2)
  })

  it('is refused when it does not match, and not looked for in a development build or a release without one', async () => {
    const dir = tmp()
    expect(await fetchReleasedApk(dir, '1.2.0', release({ 'SHA256SUMS.txt': `${'0'.repeat(64)}  Celeste-1.2.0.apk`, 'Celeste-1.2.0.apk': apk }).f)).toBeNull()
    expect(existsSync(cachedApk(dir, '1.2.0'))).toBe(false)
    expect(await fetchReleasedApk(dir, '1.2.0', release({ 'SHA256SUMS.txt': 'abc  Celeste-Setup.exe' }).f)).toBeNull()
    const none = release({})
    expect(await fetchReleasedApk(dir, '0.0.0', none.f)).toBeNull()
    expect(none.asked).toEqual([])
  })
})
