import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * The app the install page hands to phones. A release of Celeste has the matching APK beside its installers on GitHub
 * (release.yml), so the computer fetches the one for its own version the first time phones are switched on, checks it
 * against the release's SHA256SUMS.txt, and keeps it. A build from source finds the one built in phone/ instead.
 */

const RELEASES = 'https://github.com/AmossDvir1/celeste/releases/download'

export const apkName = (version: string) => `Celeste-${version}.apk`

/** Where the fetched APK for `version` is kept. */
export const cachedApk = (dataDir: string, version: string) => join(dataDir, 'phone', apkName(version))

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>

/**
 * Fetches this version's APK from its GitHub release, once. Resolves with the file, or null when there is none to fetch
 * (a development build, a release without an Android app, no network). Never throws.
 */
export async function fetchReleasedApk(dataDir: string, version: string, f: Fetch = (u) => fetch(u)): Promise<string | null> {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version === '0.0.0') return null
  const file = cachedApk(dataDir, version)
  if (existsSync(file)) return file
  try {
    const base = `${RELEASES}/v${version}`
    const sums = await f(`${base}/SHA256SUMS.txt`)
    if (!sums.ok) return null
    const want = (await sums.text())
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1]?.replace(/^\*/, '') === apkName(version))?.[0]
    if (!want || !/^[0-9a-f]{64}$/i.test(want)) return null
    const res = await f(`${base}/${apkName(version)}`)
    if (!res.ok) return null
    const data = Buffer.from(await res.arrayBuffer())
    if (createHash('sha256').update(data).digest('hex') !== want.toLowerCase()) return null
    mkdirSync(join(dataDir, 'phone'), { recursive: true })
    const partial = `${file}.partial`
    writeFileSync(partial, data)
    renameSync(partial, file)
    return file
  } catch {
    rmSync(`${file}.partial`, { force: true })
    return null
  }
}
