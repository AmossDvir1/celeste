import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { downloadProgram, findDownloaded, type DownloadOptions as SharedOptions, type RuntimeSpec } from '../npm-runtime'
import { npmRoots, pathFor, type OwnSpec } from '../own-copy'

/*
 * Claude Code's program (about 330 MB unpacked) is what the Agent SDK starts. Celeste does not ship it: in development it is the
 * one installed beside the SDK, and otherwise it is downloaded from npm the first time Claude is connected (see ../npm-runtime.ts).
 */

/** Must equal the installed @anthropic-ai/claude-agent-sdk, which is released together with the program it starts. A test checks it. */
export const PROGRAM_VERSION = '0.3.319'

const PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-arm64-musl',
  'linux-x64',
  'linux-x64-musl',
  'win32-arm64',
  'win32-x64'
] as const

/** Linux computers that do not use glibc (Alpine, for one) need a different build. Electron seldom runs on them. */
function usesMusl(): boolean {
  if (process.platform !== 'linux') return false
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  return !header?.glibcVersionRuntime
}

export function programPlatform(platform: string = process.platform, arch: string = process.arch, musl: boolean = usesMusl()): string | undefined {
  const key = `${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`
  return (PLATFORMS as readonly string[]).includes(key) ? key : undefined
}

/** The Claude Code release the SDK above starts, which is the one Celeste has been tried with (the SDK 0.3.N goes with Claude Code 2.1.N). */
export const TESTED_CLAUDE_CODE = '2.1.319'

/** Where Claude Code's own installers leave it: `~/.local/bin` (the native installer) and the npm package's folder. */
export const OWN_CLAUDE: OwnSpec = {
  name: 'Claude Code',
  tested: TESTED_CLAUDE_CODE,
  pattern: /^(\d+\.\d+\.\d+) \(Claude Code\)/m,
  places: (w) => {
    const join = pathFor(w)
    const exe = w.platform === 'win32' ? 'claude.exe' : 'claude'
    return [
      join(w.home, '.local', 'bin', exe),
      join(w.home, '.claude', 'local', exe),
      ...npmRoots(w).map((root) => join(root, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')),
      ...(w.platform === 'win32' ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
    ]
  }
}

const packageName = (platform: string) => `@anthropic-ai/claude-agent-sdk-${platform}`
const programName = (platform: string) => (platform.startsWith('win32') ? 'claude.exe' : 'claude')

const SPEC: RuntimeSpec = {
  noun: 'the Claude program',
  folder: 'claude',
  platforms: PLATFORMS,
  packageName,
  program: (platform) => [programName(platform)]
}

/** The program Celeste already has: the one installed beside the SDK (development), the person's own, or one it downloaded earlier. */
export function findProgram(options: { dataDir?: string; installedAt?: string[]; own?: () => string | undefined; platform?: string; version?: string }): string | undefined {
  const platform = options.platform ?? programPlatform()
  if (!platform) return undefined
  // The person's own copy, when it passed the check, comes first: it is what they would run themselves.
  const own = options.own?.()
  if (own) return own
  for (const base of options.installedAt ?? []) {
    const file = join(base, ...packageName(platform).split('/'), programName(platform))
    if (existsSync(file)) return file
  }
  return options.dataDir ? findDownloaded(SPEC, options.dataDir, platform, options.version ?? PROGRAM_VERSION) : undefined
}

export interface DownloadOptions extends Omit<SharedOptions, 'platform' | 'version'> {
  platform?: string
  version?: string
}

/** Downloads, verifies and unpacks the program. Resolves with the file to start. Nothing is kept if anything fails. */
export function downloadClaudeProgram(options: DownloadOptions): Promise<string> {
  return downloadProgram(SPEC, { ...options, platform: options.platform ?? programPlatform() ?? `${process.platform}-${process.arch}`, version: options.version ?? PROGRAM_VERSION })
}
