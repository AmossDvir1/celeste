import { existsSync } from 'node:fs'
import { downloadProgram, findDownloaded, type DownloadOptions as SharedOptions, type RuntimeSpec } from '../npm-runtime'

/*
 * Google's agent is the Gemini CLI (`@google/gemini-cli`, about 95 MB unpacked, 19 MB to download). Celeste talks to it through
 * `gemini --acp`, the Agent Client Protocol. It is one JavaScript file that runs on Node, so there is one program for every
 * platform, and Celeste runs it with Electron's own Node (see ./host.ts). It is not shipped: it is downloaded from npm the first
 * time Gemini is connected, in the same way as the other vendors' programs (../npm-runtime.ts).
 */

/** The Gemini CLI release Celeste has been tried with. A newer one may change how it behaves, so it is pinned. */
export const GEMINI_VERSION = '0.68.0'

/** The one "platform" of a program that runs everywhere. */
const ANY = 'any'

const SPEC: RuntimeSpec = {
  noun: 'the Gemini program',
  folder: 'gemini',
  platforms: [ANY],
  packageName: () => '@google/gemini-cli',
  program: () => ['bundle', 'gemini.js']
}

/** Gemini's program, when Celeste has already downloaded it (or, in development, `CELESTE_GEMINI_PROGRAM` names one). */
export function findGemini(options: { dataDir?: string; version?: string; override?: string }): string | undefined {
  if (options.override && existsSync(options.override)) return options.override
  if (!options.dataDir) return undefined
  return findDownloaded(SPEC, options.dataDir, ANY, options.version ?? GEMINI_VERSION)
}

export interface DownloadOptions extends Omit<SharedOptions, 'platform' | 'version'> {
  version?: string
}

/** Downloads, verifies and unpacks the program. Resolves with the file to start. Nothing is kept if anything fails. */
export function downloadGemini(options: DownloadOptions): Promise<string> {
  return downloadProgram(SPEC, { ...options, platform: ANY, version: options.version ?? GEMINI_VERSION })
}
