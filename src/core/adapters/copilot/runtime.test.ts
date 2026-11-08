import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeRegistry, sha512, tar, type RegistryOverrides } from '../../testing/npm-registry'
import { RUNTIME_VERSION, RuntimeDownloadError, downloadRuntime, downloadedRuntime, extractTarGz, findRuntime, safeTarget } from './runtime'

const PLATFORM = 'win32-x64'

function runtimeTarball(extra: { name: string; data?: string }[] = []): Buffer {
  return gzipSync(
    tar([
      { name: 'package/package.json', data: '{"name":"x"}' },
      { name: 'package/prebuilds/', type: '5' },
      { name: `package/prebuilds/${PLATFORM}/copilot-runtime.exe`, data: 'MZ-program' },
      { name: `package/prebuilds/${PLATFORM}/runtime.node`, data: 'x'.repeat(5000) },
      { name: 'package/empty.txt', data: '' },
      ...extra
    ])
  )
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'celeste-runtime-'))
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  await closeRegistry?.()
  closeRegistry = undefined
})

let closeRegistry: (() => Promise<void>) | undefined
/** A pretend registry. */
async function registry(tarball: Buffer, over: RegistryOverrides = {}) {
  const made = await fakeRegistry(['/%40github%2fcopilot-sdk-', '/@github%2fcopilot-sdk-'], tarball, over)
  closeRegistry = made.close
  return made
}

async function* chunks(buf: Buffer, size: number) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}

describe('unpacking', () => {
  it('writes the files without the leading package folder, whatever the chunk size', async () => {
    const archive = tar([
      { name: 'package/a.txt', data: 'hello' },
      { name: 'package/dir/', type: '5' },
      { name: 'package/dir/big.bin', data: 'y'.repeat(1300) },
      { name: 'package/empty', data: '' }
    ])
    for (const size of [1, 7, 512, 4096, archive.length]) {
      const out = join(dir, `out-${size}`)
      await extractTarGz(chunks(archive, size), out)
      expect(readFileSync(join(out, 'a.txt'), 'utf8')).toBe('hello')
      expect(readFileSync(join(out, 'dir', 'big.bin'), 'utf8')).toBe('y'.repeat(1300))
      expect(readFileSync(join(out, 'empty'), 'utf8')).toBe('')
    }
  })

  it('understands a long name sent as an extended header', async () => {
    const long = `package/${'deep/'.repeat(30)}file.txt`
    const out = join(dir, 'pax')
    await extractTarGz(chunks(tar([{ name: 'package/short', data: 'long one' }], { pax: { 'package/short': long } }), 100), out)
    expect(readFileSync(join(out, ...'deep/'.repeat(30).split('/').filter(Boolean), 'file.txt'), 'utf8')).toBe('long one')
  })

  it('refuses a name that would leave the folder', async () => {
    await expect(extractTarGz(chunks(tar([{ name: 'package/../../evil.txt', data: 'x' }]), 512), join(dir, 'a'))).rejects.toThrow(RuntimeDownloadError)
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false)
    expect(safeTarget('/r', 'package/../x')).toBeUndefined()
    expect(safeTarget('/r', 'package/a/../../x')).toBeUndefined()
    expect(safeTarget('/r', 'package/C:/x')).toBeUndefined()
    expect(safeTarget('/r', 'package')).toBeUndefined()
    expect(safeTarget('/r', 'package/ok/file')).toMatch(/ok[\\/]file$/)
  })

  it('does not follow a link that points outside', async () => {
    const out = join(dir, 'links')
    await extractTarGz(chunks(tar([{ name: 'package/out', type: '2', link: '../../etc' }, { name: 'package/abs', type: '2', link: '/etc' }, { name: 'package/ok.txt', data: 'fine' }]), 512), out)
    expect(existsSync(join(out, 'out'))).toBe(false)
    expect(existsSync(join(out, 'abs'))).toBe(false)
    expect(readFileSync(join(out, 'ok.txt'), 'utf8')).toBe('fine')
  })

  it('says so when the archive ends in the middle of a file', async () => {
    const whole = tar([{ name: 'package/a.txt', data: 'z'.repeat(2000) }])
    await expect(extractTarGz(chunks(whole.subarray(0, 900), 512), join(dir, 'cut'))).rejects.toThrow(/ended early/)
  })
})

describe('downloading the runtime', () => {
  const options = (registryUrl: string, extra: Partial<Parameters<typeof downloadRuntime>[0]> = {}) => ({ dataDir: dir, platform: PLATFORM, version: '9.9.9', registry: registryUrl, ...extra })

  it('downloads, checks the checksum, unpacks, and reports progress', async () => {
    const reg = await registry(runtimeTarball())
    const progress: number[] = []
    const wrapper = await downloadRuntime(options(reg.url, { onProgress: (f) => progress.push(f) }))
    expect(wrapper).toBe(downloadedRuntime(dir, PLATFORM, '9.9.9').wrapper)
    expect(readFileSync(wrapper, 'utf8')).toBe('MZ-program')
    expect(readFileSync(join(dir, 'runtimes', `copilot-9.9.9-${PLATFORM}`, 'prebuilds', PLATFORM, 'runtime.node'), 'utf8')).toHaveLength(5000)
    expect(progress[progress.length - 1]).toBe(1)
    expect(progress.every((p, i) => i === 0 || p >= (progress[i - 1] as number))).toBe(true)
    expect(findRuntime({ dataDir: dir, platform: PLATFORM, version: '9.9.9' })).toBe(wrapper)
    // Nothing is left beside it.
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([`copilot-9.9.9-${PLATFORM}`])
  })

  it('does not download again once it has it', async () => {
    const reg = await registry(runtimeTarball())
    await downloadRuntime(options(reg.url))
    await downloadRuntime(options(reg.url))
    expect(reg.hits).toEqual({ meta: 1, tarball: 1 })
  })

  it('throws away a download whose checksum does not match, and keeps nothing', async () => {
    const reg = await registry(runtimeTarball(), { integrity: sha512(Buffer.from('something else')) })
    await expect(downloadRuntime(options(reg.url))).rejects.toThrow(/checksum/)
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([])
    expect(findRuntime({ dataDir: dir, platform: PLATFORM, version: '9.9.9' })).toBeUndefined()
  })

  it('will not use a package the registry gives no checksum for', async () => {
    const reg = await registry(runtimeTarball(), { integrity: 'sha1-abc' })
    await expect(downloadRuntime(options(reg.url))).rejects.toThrow(/checksum/)
  })

  it('will not fetch from an address it does not trust', async () => {
    const reg = await registry(runtimeTarball(), { tarballUrl: () => 'http://evil.example/runtime.tgz' })
    // The registry here is http on 127.0.0.1, so only its own origin is trusted, not other http addresses.
    await expect(downloadRuntime(options(reg.url))).rejects.toThrow(/does not trust/)
  })

  it('refuses an archive that tries to write outside its folder', async () => {
    const reg = await registry(gzipSync(tar([{ name: 'package/../../escape.txt', data: 'x' }])))
    await expect(downloadRuntime(options(reg.url))).rejects.toThrow(/outside its folder/)
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
  })

  it('explains a registry that says no', async () => {
    const reg = await registry(runtimeTarball(), { status: 404 })
    await expect(downloadRuntime(options(reg.url))).rejects.toThrow(/answered 404/)
  })

  it('explains an archive without the program in it', async () => {
    const reg = await registry(gzipSync(tar([{ name: 'package/package.json', data: '{}' }])))
    await expect(downloadRuntime(options(reg.url))).rejects.toThrow(/missing its program/)
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([])
  })

  it('stops when cancelled and keeps nothing', async () => {
    const reg = await registry(runtimeTarball(), { slow: true })
    const controller = new AbortController()
    const pending = downloadRuntime(options(reg.url, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/Cancelled/)
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([])
  })

  it('removes a runtime of an older version once the new one is in', async () => {
    mkdirSync(join(dir, 'runtimes', `copilot-1.0.0-${PLATFORM}`), { recursive: true })
    writeFileSync(join(dir, 'runtimes', `copilot-1.0.0-${PLATFORM}`, 'x'), 'old')
    const reg = await registry(runtimeTarball())
    await downloadRuntime(options(reg.url))
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([`copilot-9.9.9-${PLATFORM}`])
  })

  it('says there is no runtime for a computer Copilot does not support', async () => {
    await expect(downloadRuntime({ dataDir: dir, platform: 'plan9-mips', version: '1' })).rejects.toThrow(/no Copilot runtime/)
  })
})

describe('finding the runtime', () => {
  it('prefers one installed next to the SDK', () => {
    const base = join(dir, 'node_modules')
    const wrapper = join(base, '@github', `copilot-sdk-${PLATFORM}`, 'prebuilds', PLATFORM, 'copilot-runtime.exe')
    mkdirSync(join(wrapper, '..'), { recursive: true })
    writeFileSync(wrapper, 'x')
    expect(findRuntime({ dataDir: dir, platform: PLATFORM, installedAt: [base] })).toBe(wrapper)
  })

  it('ignores a download that did not finish', () => {
    const mine = downloadedRuntime(dir, PLATFORM)
    mkdirSync(join(mine.wrapper, '..'), { recursive: true })
    writeFileSync(mine.wrapper, 'x')
    expect(findRuntime({ dataDir: dir, platform: PLATFORM })).toBeUndefined()
    writeFileSync(join(mine.dir, '.complete'), 'ok')
    expect(findRuntime({ dataDir: dir, platform: PLATFORM })).toBe(mine.wrapper)
  })

  it('is the version of the SDK that is installed', () => {
    const sdk = JSON.parse(readFileSync(join(process.cwd(), 'node_modules', '@github', 'copilot-sdk', 'package.json'), 'utf8')) as { version: string }
    expect(RUNTIME_VERSION).toBe(sdk.version)
  })
})
