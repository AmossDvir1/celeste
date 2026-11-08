import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeRegistry, gzipSync, sha512, tar } from '../../testing/npm-registry'
import { PROGRAM_VERSION, downloadClaudeProgram, findProgram, programPlatform } from './program'

const PLATFORM = 'win32-x64'
let dir: string
let close: (() => Promise<void>) | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'celeste-claude-program-'))
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  await close?.()
  close = undefined
})

const tarball = (extra: { name: string; data?: string }[] = []) =>
  gzipSync(
    tar([
      { name: 'package/package.json', data: '{"name":"@anthropic-ai/claude-agent-sdk-win32-x64"}' },
      { name: 'package/claude.exe', data: 'MZ-claude-code' },
      { name: 'package/README.md', data: 'hello' },
      ...extra
    ])
  )

async function registry(body: Buffer, over: Parameters<typeof fakeRegistry>[2] = {}) {
  const made = await fakeRegistry(['/@anthropic-ai%2fclaude-agent-sdk-', '/%40anthropic-ai%2fclaude-agent-sdk-'], body, over)
  close = made.close
  return made
}
const options = (url: string, extra: Partial<Parameters<typeof downloadClaudeProgram>[0]> = {}) => ({ dataDir: dir, platform: PLATFORM, version: '9.9.9', registry: url, ...extra })

describe('Claude Code’s program', () => {
  it('is the version of the SDK that is installed', () => {
    const sdk = JSON.parse(readFileSync(join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { version: string }
    expect(PROGRAM_VERSION).toBe(sdk.version)
  })

  it('knows its platforms, the Linux builds without glibc included', () => {
    expect(programPlatform('win32', 'x64')).toBe('win32-x64')
    expect(programPlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(programPlatform('linux', 'x64', false)).toBe('linux-x64')
    expect(programPlatform('linux', 'arm64', true)).toBe('linux-arm64-musl')
    expect(programPlatform('win32', 'ia32')).toBeUndefined()
    expect(programPlatform('freebsd', 'x64')).toBeUndefined()
  })

  it('is found beside the SDK first, then in the data folder, and only once a download is complete', async () => {
    expect(findProgram({ platform: PLATFORM, dataDir: dir })).toBeUndefined()
    const base = join(dir, 'node_modules')
    const beside = join(base, '@anthropic-ai', `claude-agent-sdk-${PLATFORM}`, 'claude.exe')
    mkdirSync(join(beside, '..'), { recursive: true })
    writeFileSync(beside, 'x')
    expect(findProgram({ platform: PLATFORM, installedAt: [base] })).toBe(beside)

    const reg = await registry(tarball())
    const downloaded = await downloadClaudeProgram(options(reg.url))
    expect(findProgram({ platform: PLATFORM, dataDir: dir, version: '9.9.9' })).toBe(downloaded)
    // A different version is a different program.
    expect(findProgram({ platform: PLATFORM, dataDir: dir, version: '1.0.0' })).toBeUndefined()
  })

  it('downloads, checks the checksum, unpacks, reports progress, and does not download twice', async () => {
    const reg = await registry(tarball())
    const progress: number[] = []
    const file = await downloadClaudeProgram(options(reg.url, { onProgress: (f) => progress.push(f) }))
    expect(file).toBe(join(dir, 'runtimes', `claude-9.9.9-${PLATFORM}`, 'claude.exe'))
    expect(readFileSync(file, 'utf8')).toBe('MZ-claude-code')
    expect(progress[progress.length - 1]).toBe(1)
    await downloadClaudeProgram(options(reg.url))
    expect(reg.hits).toEqual({ meta: 1, tarball: 1 })
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([`claude-9.9.9-${PLATFORM}`])
  })

  it('asks the registry for the right package', async () => {
    const reg = await registry(tarball())
    await downloadClaudeProgram(options(reg.url, { platform: 'win32-x64' }))
    expect(reg.hits.meta).toBe(1)
  })

  it('throws away a download that does not match its checksum, and keeps nothing', async () => {
    const reg = await registry(tarball(), { integrity: sha512(Buffer.from('something else')) })
    await expect(downloadClaudeProgram(options(reg.url))).rejects.toThrow(/Claude program did not match its published checksum/)
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([])
    expect(findProgram({ platform: PLATFORM, dataDir: dir, version: '9.9.9' })).toBeUndefined()
  })

  it('explains an archive without the program in it, and a registry that says no', async () => {
    const empty = await registry(gzipSync(tar([{ name: 'package/package.json', data: '{}' }])))
    await expect(downloadClaudeProgram(options(empty.url))).rejects.toThrow(/missing its program/)
    await empty.close()
    const no = await registry(tarball(), { status: 404 })
    close = no.close
    await expect(downloadClaudeProgram(options(no.url))).rejects.toThrow(/answered 404 when asked for the Claude program/)
  })

  it('refuses an archive that tries to write outside its folder', async () => {
    const reg = await registry(gzipSync(tar([{ name: 'package/../../escape.txt', data: 'x' }])))
    await expect(downloadClaudeProgram(options(reg.url))).rejects.toThrow(/outside its folder/)
  })

  it('stops when cancelled and keeps nothing', async () => {
    const reg = await registry(tarball(), { slow: true })
    const controller = new AbortController()
    const pending = downloadClaudeProgram(options(reg.url, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/Cancelled/)
    expect(readdirSync(join(dir, 'runtimes'))).toEqual([])
  })

  it('removes an older version once the new one is in, and leaves Copilot’s runtime alone', async () => {
    mkdirSync(join(dir, 'runtimes', `claude-1.0.0-${PLATFORM}`), { recursive: true })
    mkdirSync(join(dir, 'runtimes', `copilot-1.0.0-${PLATFORM}`), { recursive: true })
    const reg = await registry(tarball())
    await downloadClaudeProgram(options(reg.url))
    expect(readdirSync(join(dir, 'runtimes')).sort()).toEqual([`claude-9.9.9-${PLATFORM}`, `copilot-1.0.0-${PLATFORM}`])
  })

  it('says there is no program for a computer Claude Code does not support', async () => {
    await expect(downloadClaudeProgram({ dataDir: dir, platform: 'plan9-mips', version: '1' })).rejects.toThrow(/no Claude program/)
  })
})
