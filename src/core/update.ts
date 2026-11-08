import type { UpdateInfo } from '@shared/api'

/** The release page of the project, where the newest version is announced. */
const LATEST = 'https://api.github.com/repos/AmossDvir1/celeste/releases/latest'

/** 1 if `a` is a later version than `b`, -1 if earlier, 0 if the same. Ignores a leading "v" and anything after a "-" (a pre-release). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * Asks GitHub which release is newest. It runs only when the person presses "Check for updates", and sends nothing about them: it is the
 * same request anyone's browser could make. It never downloads or installs anything.
 */
export async function checkForUpdate(current: string, fetcher: typeof fetch = fetch): Promise<UpdateInfo> {
  let res: Response
  try {
    res = await fetcher(LATEST, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Celeste' }, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error('Could not reach GitHub. Check the internet connection and try again.')
  }
  // No release has been published yet.
  if (res.status === 404) return { current, newer: false }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}, so Celeste could not tell which version is newest.`)
  const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : undefined
  if (!tag) throw new Error('GitHub did not say which version is newest.')
  const latest = tag.replace(/^v/i, '')
  // Only a page on github.com for this project is offered as the place to download from.
  const page = typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/AmossDvir1/celeste/') ? release.html_url : 'https://github.com/AmossDvir1/celeste/releases'
  return { current, latest, url: page, newer: compareVersions(latest, current) > 0 }
}
