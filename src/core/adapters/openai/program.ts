import { existsSync } from 'node:fs'
import { downloadProgram, findDownloaded, type DownloadOptions as SharedOptions, type RuntimeSpec } from '../npm-runtime'

/*
 * OpenAI's agent is the `codex` program (about 480 MB unpacked). Celeste talks to it through `codex app-server`. It is not shipped:
 * it is downloaded from npm the first time OpenAI is connected, in the same way as the other vendors' programs (../npm-runtime.ts).
 * OpenAI publishes one program per platform as versions of the one package: `@openai/codex@<version>-<platform>`.
 */

/** The Codex release Celeste has been tried with. A newer one may change the protocol, so it is pinned. */
export const CODEX_VERSION = '0.169.0'

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'] as const

/** The folder inside the package that holds the program, which is named after the Rust target. */
const TARGET: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc'
}

export function codexPlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const key = `${platform}-${arch}`
  return (PLATFORMS as readonly string[]).includes(key) ? key : undefined
}

const programPieces = (platform: string): string[] => ['vendor', TARGET[platform] ?? '', 'bin', platform.startsWith('win32') ? 'codex.exe' : 'codex']

const SPEC: RuntimeSpec = {
  noun: 'the OpenAI Codex program',
  folder: 'codex',
  platforms: PLATFORMS,
  packageName: () => '@openai/codex',
  program: programPieces
}

/** The version string the registry knows the platform's program by. */
export const registryVersion = (platform: string, version: string = CODEX_VERSION): string => `${version}-${platform}`

/** Codex's program, when Celeste has already downloaded it (or, in development, `CELESTE_CODEX_PROGRAM` names one). */
export function findCodex(options: { dataDir?: string; platform?: string; version?: string; override?: string }): string | undefined {
  if (options.override && existsSync(options.override)) return options.override
  const platform = options.platform ?? codexPlatform()
  if (!platform || !options.dataDir) return undefined
  return findDownloaded(SPEC, options.dataDir, platform, registryVersion(platform, options.version))
}

export interface DownloadOptions extends Omit<SharedOptions, 'platform' | 'version'> {
  platform?: string
  version?: string
}

/** Downloads, verifies and unpacks the program. Resolves with the file to start. Nothing is kept if anything fails. */
export function downloadCodex(options: DownloadOptions): Promise<string> {
  const platform = options.platform ?? codexPlatform() ?? `${process.platform}-${process.arch}`
  return downloadProgram(SPEC, { ...options, platform, version: registryVersion(platform, options.version) })
}
