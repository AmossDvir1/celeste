import { createHash } from 'node:crypto'
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

/*
 * Copilot's runtime is a large program (about 180 MB unpacked) that the SDK expects to find installed next to it.
 * Celeste does not ship it: it is downloaded from npm the first time someone connects Copilot, checked against the
 * checksum npm publishes, and kept in Celeste's own data folder.
 */

/** Must equal the installed @github/copilot-sdk, whose protocol it speaks. A test checks it. */
export const RUNTIME_VERSION = '1.0.29'

const PLATFORMS: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x64': 'linux-x64',
  'win32-arm64': 'win32-arm64',
  'win32-x64': 'win32-x64'
}

export function runtimePlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  return PLATFORMS[`${platform}-${arch}`]
}

const packageName = (platform: string) => `@github/copilot-sdk-${platform}`
const wrapperName = (platform: string) => (platform.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime')

/** Where a downloaded runtime lives, and the program inside it. */
export function downloadedRuntime(dataDir: string, platform: string, version: string = RUNTIME_VERSION): { dir: string; wrapper: string } {
  const dir = join(dataDir, 'runtimes', `copilot-${version}-${platform}`)
  return { dir, wrapper: join(dir, 'prebuilds', platform, wrapperName(platform)) }
}

/** The runtime Celeste already has: one installed next to the SDK (development) or one it downloaded earlier. */
export function findRuntime(options: { dataDir: string; platform?: string; version?: string; installedAt?: string[] }): string | undefined {
  const platform = options.platform ?? runtimePlatform()
  if (!platform) return undefined
  const version = options.version ?? RUNTIME_VERSION
  for (const base of options.installedAt ?? []) {
    const wrapper = join(base, ...packageName(platform).split('/'), 'prebuilds', platform, wrapperName(platform))
    if (existsSync(wrapper)) return wrapper
  }
  const mine = downloadedRuntime(options.dataDir, platform, version)
  return existsSync(join(mine.dir, '.complete')) && existsSync(mine.wrapper) ? mine.wrapper : undefined
}

export interface DownloadOptions {
  dataDir: string
  platform?: string
  version?: string
  registry?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export class RuntimeDownloadError extends Error {}

const MAX_ENTRIES = 5000
const MAX_FILE = 600 * 1024 * 1024
const MAX_TOTAL = 900 * 1024 * 1024

/** Downloads, verifies and unpacks the runtime. Resolves with the program to start. Nothing is kept if anything fails. */
export async function downloadRuntime(options: DownloadOptions): Promise<string> {
  const platform = options.platform ?? runtimePlatform()
  if (!platform || !Object.values(PLATFORMS).includes(platform)) throw new RuntimeDownloadError(`Copilot has no runtime for this computer (${process.platform}, ${process.arch}).`)
  const version = options.version ?? RUNTIME_VERSION
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  const get = options.fetch ?? fetch
  const target = downloadedRuntime(options.dataDir, platform, version)
  if (existsSync(join(target.dir, '.complete')) && existsSync(target.wrapper)) return target.wrapper

  const root = dirname(target.dir)
  mkdirSync(root, { recursive: true })
  const work = `${target.dir}.partial`
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const tarball = join(work, 'runtime.tgz')

  try {
    const meta = await get(`${registry}/${packageName(platform).replace('/', '%2f')}/${version}`, { signal: options.signal })
    if (!meta.ok) throw new RuntimeDownloadError(`The package registry answered ${meta.status} when asked for the Copilot runtime.`)
    const info = (await meta.json()) as { dist?: { tarball?: string; integrity?: string } }
    const url = info.dist?.tarball
    const integrity = info.dist?.integrity
    if (!url || !integrity?.startsWith('sha512-')) throw new RuntimeDownloadError('The package registry did not give a checksum for the Copilot runtime, so Celeste will not use it.')
    // The file must come from the registry itself or from npm, over a secure connection.
    const from = new URL(url)
    const trusted = from.origin === new URL(registry).origin || from.protocol === 'https:'
    if (!trusted) throw new RuntimeDownloadError('The package registry pointed to an address Celeste does not trust.')

    const res = await get(url, { signal: options.signal })
    if (!res.ok || !res.body) throw new RuntimeDownloadError(`The download of the Copilot runtime failed (${res.status}).`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const hash = createHash('sha512')
    let received = 0
    const out = createWriteStream(tarball)
    const body = Readable.fromWeb(res.body as never)
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      if (total > 0) options.onProgress?.(Math.min(0.95, (received / total) * 0.95))
    })
    await pipeline(body, out, { signal: options.signal })
    if (`sha512-${hash.digest('base64')}` !== integrity) {
      throw new RuntimeDownloadError('The Copilot runtime did not match its published checksum, so it was thrown away.')
    }

    // The npm tarball puts everything under "package/"; unpacking drops that folder.
    await extractTarGz(createReadStream(tarball).pipe(createGunzip()), join(work, 'files'))
    if (!existsSync(join(work, 'files', 'prebuilds', platform, wrapperName(platform)))) {
      throw new RuntimeDownloadError('The downloaded Copilot runtime is missing its program.')
    }
    rmSync(target.dir, { recursive: true, force: true })
    renameSync(join(work, 'files'), target.dir)
    if (process.platform !== 'win32') chmodSync(target.wrapper, 0o755)
    writeFileSync(join(target.dir, '.complete'), `${version}\n`)
    options.onProgress?.(1)
    return target.wrapper
  } catch (err) {
    if (options.signal?.aborted) throw new RuntimeDownloadError('Cancelled.')
    throw err instanceof RuntimeDownloadError ? err : new RuntimeDownloadError(`Could not download the Copilot runtime: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
    // A leftover from an older version is not needed once the new one is in place.
    try {
      for (const name of readdirSync(root)) {
        if (name.startsWith('copilot-') && name.endsWith(`-${platform}`) && name !== `copilot-${version}-${platform}`) rmSync(join(root, name), { recursive: true, force: true })
      }
    } catch {
      /* nothing to tidy */
    }
  }
}

// --- unpacking ---------------------------------------------------------------------------------------------

const BLOCK = 512

function text(buf: Buffer, from: number, length: number): string {
  const end = buf.indexOf(0, from)
  return buf.toString('utf8', from, end >= from && end < from + length ? end : from + length)
}
function octal(buf: Buffer, from: number, length: number): number {
  const value = parseInt(text(buf, from, length).trim() || '0', 8)
  if (!Number.isFinite(value) || value < 0) throw new RuntimeDownloadError('The Copilot runtime archive is damaged.')
  return value
}

/** Where an archive entry goes, or undefined when the name would leave the folder. */
export function safeTarget(root: string, name: string): string | undefined {
  // npm tarballs start every path with a folder called "package". It is dropped.
  const clean = name.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = clean.split('/').filter(Boolean)
  if (parts.length === 0) return undefined
  const inner = parts.slice(1)
  if (inner.length === 0) return undefined
  if (inner.some((p) => p === '..' || /^[a-z]:$/i.test(p))) return undefined
  const full = resolve(root, ...inner)
  return full === resolve(root) || full.startsWith(resolve(root) + sep) ? full : undefined
}

/** Unpacks a tar stream (already decompressed) into a folder, refusing names that escape it and anything oversized. */
export async function extractTarGz(stream: AsyncIterable<Buffer>, root: string): Promise<void> {
  mkdirSync(root, { recursive: true })
  let pending: Buffer = Buffer.alloc(0)
  let entries = 0
  let total = 0
  let longName: string | undefined
  let paxPath: string | undefined
  let file: { fd: number; left: number; pad: number } | undefined
  let skip = 0
  let special: { kind: 'x' | 'L'; left: number; pad: number } | undefined
  let ended = false

  for await (const incoming of stream) {
    pending = pending.length ? Buffer.concat([pending, incoming]) : incoming
    for (;;) {
      if (file) {
        if (file.left > 0) {
          if (pending.length === 0) break
          const take = Math.min(file.left, pending.length)
          writeSync(file.fd, pending, 0, take)
          pending = pending.subarray(take)
          file.left -= take
          if (file.left > 0) break
        }
        if (pending.length < file.pad) break
        pending = pending.subarray(file.pad)
        closeSync(file.fd)
        file = undefined
        continue
      }
      if (special) {
        // A long name or extended header: small, so wait until all of it has arrived.
        const need = special.left + special.pad
        if (pending.length < need) break
        const body = pending.subarray(0, special.left)
        pending = pending.subarray(need)
        if (special.kind === 'L') longName = text(body, 0, body.length)
        else {
          for (const line of body.toString('utf8').split('\n')) {
            const m = /^\d+ path=(.*)$/.exec(line)
            if (m) paxPath = m[1]
          }
        }
        special = undefined
        continue
      }
      if (skip > 0) {
        const take = Math.min(skip, pending.length)
        pending = pending.subarray(take)
        skip -= take
        if (skip > 0) break
        continue
      }
      if (pending.length < BLOCK) break
      const header = pending.subarray(0, BLOCK)
      if (header.every((b) => b === 0)) {
        ended = true
        pending = pending.subarray(BLOCK)
        continue
      }
      pending = pending.subarray(BLOCK)
      const size = octal(header, 124, 12)
      const kind = String.fromCharCode(header[156] || 48)
      const mode = octal(header, 100, 8)
      const prefix = text(header, 345, 155)
      const name = paxPath ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))
      const pad = (BLOCK - (size % BLOCK)) % BLOCK
      if (kind === 'x') {
        special = { kind: 'x', left: size, pad }
        continue
      }
      if (kind === 'L') {
        special = { kind: 'L', left: size, pad }
        continue
      }
      paxPath = undefined
      longName = undefined
      if (kind === 'g') {
        skip = size + pad
        continue
      }
      if (++entries > MAX_ENTRIES) throw new RuntimeDownloadError('The Copilot runtime archive has too many files.')
      const dest = safeTarget(root, name)
      if (kind === '5') {
        if (dest) mkdirSync(dest, { recursive: true })
        continue
      }
      if (kind === '2') {
        // A link is kept only when it points inside the folder.
        const linkTo = text(header, 157, 100)
        if (dest && linkTo && !linkTo.startsWith('/') && !/(^|[\\/])\.\.([\\/]|$)/.test(linkTo)) {
          mkdirSync(dirname(dest), { recursive: true })
          try {
            symlinkSync(linkTo, dest)
          } catch {
            /* symlinks may be unavailable; the runtime does not need them on Windows */
          }
        }
        continue
      }
      if (kind !== '0' && kind !== '7') {
        skip = size + pad
        continue
      }
      if (!dest) throw new RuntimeDownloadError(`The Copilot runtime archive has a file outside its folder (${name}).`)
      if (size > MAX_FILE || (total += size) > MAX_TOTAL) throw new RuntimeDownloadError('The Copilot runtime archive is larger than expected.')
      mkdirSync(dirname(dest), { recursive: true })
      const fd = openSync(dest, 'w', mode & 0o111 ? 0o755 : 0o644)
      file = { fd, left: size, pad }
    }
  }
  if (file) {
    closeSync(file.fd)
    throw new RuntimeDownloadError('The Copilot runtime archive ended early.')
  }
  if (!ended && entries === 0) throw new RuntimeDownloadError('The Copilot runtime archive is empty.')
}
