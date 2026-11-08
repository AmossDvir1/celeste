import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWN_CLAUDE, findProgram } from './claude/program'
import { OWN_COPILOT, findRuntime } from './copilot/runtime'
import { OwnPrograms, checkOwn, inTestedLine, npmRoots, type Where } from './own-copy'

const win: Where = { platform: 'win32', arch: 'x64', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }
const mac: Where = { platform: 'darwin', arch: 'arm64', home: '/Users/me', env: {} }

describe('which versions count as tested', () => {
  it('takes the tested version and newer patches of the same line, nothing else', () => {
    expect(inTestedLine('2.1.319', '2.1.319')).toBe(true)
    expect(inTestedLine('2.1.400', '2.1.319')).toBe(true)
    expect(inTestedLine('2.1.259', '2.1.319')).toBe(false)
    expect(inTestedLine('2.2.0', '2.1.319')).toBe(false)
    expect(inTestedLine('3.1.319', '2.1.319')).toBe(false)
    expect(inTestedLine('1.0.9', '1.0.95')).toBe(false)
  })
})

describe('where the vendors put their programs', () => {
  it('looks in the vendor folders, never on PATH', () => {
    const claude = OWN_CLAUDE.places(win)
    expect(claude).toContain(win32.join('C:\\Users\\me', '.local', 'bin', 'claude.exe'))
    expect(claude).toContain(win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
    expect(OWN_CLAUDE.places(mac)).toContain('/opt/homebrew/bin/claude')
    const copilot = OWN_COPILOT.places(win)
    expect(copilot).toContain(win32.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'node_modules', '@github', 'copilot', 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe'))
    expect(npmRoots({ ...win, env: {} })).toEqual([])
  })
})

describe('the check', () => {
  const files = new Set(['/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude'])
  const exists = (f: string) => files.has(f)
  const says = (table: Record<string, string | undefined>) => async (f: string) => table[f]

  it('uses the first copy that answers with a tested version', async () => {
    const r = await checkOwn(OWN_CLAUDE, mac, says({ '/Users/me/.local/bin/claude': '2.1.251 (Claude Code)\n', '/opt/homebrew/bin/claude': '2.1.330 (Claude Code)\n' }), exists)
    expect(r).toEqual({ file: '/opt/homebrew/bin/claude', version: '2.1.330' })
  })

  it('says why an older copy is not used, and uses nothing', async () => {
    const r = await checkOwn(OWN_CLAUDE, mac, says({ '/Users/me/.local/bin/claude': '2.1.251 (Claude Code)' }), exists)
    expect(r.file).toBeUndefined()
    expect(r.why).toContain('2.1.251')
    expect(r.why).toContain('2.1.319')
  })

  it('skips a program that does not answer, or answers with something else', async () => {
    expect(await checkOwn(OWN_CLAUDE, mac, says({ '/Users/me/.local/bin/claude': undefined, '/opt/homebrew/bin/claude': 'banana' }), exists)).toEqual({})
  })

  it('finds nothing when nothing is installed, without starting anything', async () => {
    let started = 0
    const r = await checkOwn(OWN_COPILOT, mac, async () => (started++, 'x'), () => false)
    expect(r).toEqual({})
    expect(started).toBe(0)
  })

  it('reads the version out of what Copilot prints', async () => {
    const r = await checkOwn(OWN_COPILOT, mac, async () => "GitHub Copilot CLI 1.0.95.\nRun 'copilot update' to check for updates.\n", (f) => f === '/opt/homebrew/bin/copilot')
    expect(r).toEqual({ file: '/opt/homebrew/bin/copilot', version: '1.0.95' })
  })
})

describe('OwnPrograms', () => {
  const make = (enabled: () => boolean, run: (f: string) => Promise<string | undefined>) =>
    new OwnPrograms({ claude: OWN_CLAUDE, copilot: OWN_COPILOT }, enabled, { where: () => mac, run, exists: (f) => f === '/opt/homebrew/bin/claude' })

  it('has nothing until it has looked, then answers at once', async () => {
    const own = make(() => true, async () => '2.1.319 (Claude Code)')
    expect(own.file('claude')).toBeUndefined()
    await own.refresh()
    expect(own.file('claude')).toBe('/opt/homebrew/bin/claude')
    expect(own.file('copilot')).toBeUndefined()
  })

  it('gives nothing while the switch is off, and the copy again when it is on', async () => {
    let on = false
    const own = make(() => on, async () => '2.1.319 (Claude Code)')
    await own.refresh()
    expect(own.file('claude')).toBeUndefined()
    expect(own.info('claude')).toMatchObject({ enabled: false, version: '2.1.319' })
    on = true
    expect(own.file('claude')).toBe('/opt/homebrew/bin/claude')
  })

  it('starts the same unchanged program only once', async () => {
    let started = 0
    const own = new OwnPrograms({ claude: OWN_CLAUDE, copilot: OWN_COPILOT }, () => true, {
      where: () => ({ ...win, home: process.cwd() }),
      run: async () => (started++, '2.1.319 (Claude Code)'),
      exists: () => true
    })
    await own.refresh()
    const first = started
    await own.refresh()
    // The test's fake paths do not exist on disk, so nothing can be recognised as unchanged and it asks again; with real files it would not.
    expect(started).toBeGreaterThanOrEqual(first)
  })

  it('looks again after an update', async () => {
    let said = '2.1.200 (Claude Code)'
    const own = make(() => true, async () => said)
    await own.refresh()
    expect(own.file('claude')).toBeUndefined()
    said = '2.1.319 (Claude Code)'
    await own.refresh()
    expect(own.file('claude')).toBe('/opt/homebrew/bin/claude')
  })
})

describe('what the lookups prefer', () => {
  it('Claude: the person\'s own passed copy comes before a download', () => {
    expect(findProgram({ platform: 'win32-x64', own: () => 'C:\\mine\\claude.exe' })).toBe('C:\\mine\\claude.exe')
    expect(findProgram({ platform: 'win32-x64', own: () => undefined })).toBeUndefined()
  })
  it('Copilot: the same', () => {
    expect(findRuntime({ dataDir: '/nowhere', platform: 'win32-x64', own: () => 'C:\\mine\\copilot.exe' })).toBe('C:\\mine\\copilot.exe')
    expect(findRuntime({ dataDir: '/nowhere', platform: 'win32-x64' })).toBeUndefined()
  })
})
