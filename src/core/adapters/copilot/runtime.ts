import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { downloadProgram, downloadedProgram, findDownloaded, type DownloadOptions as SharedOptions, type RuntimeSpec } from '../npm-runtime'

export { RuntimeDownloadError, extractTarGz, safeTarget } from '../npm-runtime'

/*
 * Copilot's runtime is a large program (about 180 MB unpacked) that the SDK expects to find installed next to it.
 * Celeste does not ship it: it is downloaded from npm the first time someone connects Copilot, checked against the
 * checksum npm publishes, and kept in Celeste's own data folder (see ../npm-runtime.ts).
 */

/** Must equal the installed @github/copilot-sdk, whose protocol it speaks. A test checks it. */
export const RUNTIME_VERSION = '1.0.29'

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'] as const

export function runtimePlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const key = `${platform}-${arch}`
  return (PLATFORMS as readonly string[]).includes(key) ? key : undefined
}

const packageName = (platform: string) => `@github/copilot-sdk-${platform}`
const wrapperName = (platform: string) => (platform.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime')

const SPEC: RuntimeSpec = {
  noun: 'the Copilot runtime',
  folder: 'copilot',
  platforms: PLATFORMS,
  packageName,
  program: (platform) => ['prebuilds', platform, wrapperName(platform)]
}

/** Where a downloaded runtime lives, and the program inside it. */
export function downloadedRuntime(dataDir: string, platform: string, version: string = RUNTIME_VERSION): { dir: string; wrapper: string } {
  const { dir, program } = downloadedProgram(SPEC, dataDir, platform, version)
  return { dir, wrapper: program }
}

/** The runtime Celeste already has: one installed next to the SDK (development) or one it downloaded earlier. */
export function findRuntime(options: { dataDir: string; platform?: string; version?: string; installedAt?: string[] }): string | undefined {
  const platform = options.platform ?? runtimePlatform()
  if (!platform) return undefined
  for (const base of options.installedAt ?? []) {
    const wrapper = join(base, ...packageName(platform).split('/'), 'prebuilds', platform, wrapperName(platform))
    if (existsSync(wrapper)) return wrapper
  }
  return findDownloaded(SPEC, options.dataDir, platform, options.version ?? RUNTIME_VERSION)
}

export interface DownloadOptions extends Omit<SharedOptions, 'platform' | 'version'> {
  platform?: string
  version?: string
}

/** Downloads, verifies and unpacks the runtime. Resolves with the program to start. Nothing is kept if anything fails. */
export function downloadRuntime(options: DownloadOptions): Promise<string> {
  return downloadProgram(SPEC, { ...options, platform: options.platform ?? runtimePlatform() ?? `${process.platform}-${process.arch}`, version: options.version ?? RUNTIME_VERSION })
}
