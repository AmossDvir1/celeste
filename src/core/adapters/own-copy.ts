import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/*
 * Before downloading a vendor's program, Celeste looks for the one the person already has, in the places the vendor's own
 * installers put it (never by trusting whatever comes first on PATH), and uses it only if it passes a check: it answers when
 * asked its version, and that version is one Celeste has been tried with. Otherwise Celeste uses its own pinned copy.
 * Nothing is installed or changed on the computer either way.
 */

export type OwnVendor = 'claude' | 'copilot'

export interface Where {
  platform: NodeJS.Platform
  arch: string
  home: string
  env: Record<string, string | undefined>
}

export interface OwnSpec {
  /** "Claude Code", in the messages. */
  name: string
  /** The version Celeste's adapter was written and tried against. */
  tested: string
  /** Picks the version out of what the program prints for `--version`. */
  pattern: RegExp
  /** The files to look at, most likely first. */
  places(where: Where): string[]
}

/** What the check found for one vendor. */
export interface OwnCopy {
  /** The program that passed, when one did. */
  file?: string
  version?: string
  /** Why a copy that was found is not used, said to the person. Absent when nothing was found or one passed. */
  why?: string
}

/** Paths are written for the platform being asked about, not the one the code runs on. */
export const pathFor = (w: Where) => (w.platform === 'win32' ? win32.join : posix.join)

export const hereNow = (): Where => ({ platform: process.platform, arch: process.arch, home: homedir(), env: process.env })

/** Where `npm install -g` puts packages on this system. */
export function npmRoots(w: Where): string[] {
  const join = pathFor(w)
  if (w.platform === 'win32') return w.env['APPDATA'] ? [join(w.env['APPDATA'], 'npm', 'node_modules')] : []
  if (w.platform === 'darwin') return ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules', join(w.home, '.npm-global', 'lib', 'node_modules')]
  return ['/usr/local/lib/node_modules', '/usr/lib/node_modules', join(w.home, '.npm-global', 'lib', 'node_modules')]
}

const parts = (v: string) => v.split('.').map((n) => Number(n))

/** The same release line as the tested version, and not older: a newer patch is taken to be the same program. */
export function inTestedLine(version: string, tested: string): boolean {
  const [a, b, c] = parts(version)
  const [x, y, z] = parts(tested)
  return a === x && b === y && (c ?? 0) >= (z ?? 0)
}

export type RunVersion = (file: string) => Promise<string | undefined>

/** Starts the program with `--version` and returns what it printed. Gives up after a few seconds. */
export const runVersion: RunVersion = (file) =>
  new Promise((resolve) => {
    try {
      execFile(file, ['--version'], { timeout: 6000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? undefined : String(stdout)))
    } catch {
      resolve(undefined)
    }
  })

/** Looks through the places and returns the first copy that passes, or why the best one that was found does not. */
export async function checkOwn(spec: OwnSpec, where: Where, run: RunVersion = runVersion, exists: (file: string) => boolean = existsSync): Promise<OwnCopy> {
  let why: string | undefined
  for (const file of [...new Set(spec.places(where))]) {
    if (!exists(file)) continue
    const version = spec.pattern.exec((await run(file)) ?? '')?.[1]
    if (!version) continue
    if (inTestedLine(version, spec.tested)) return { file, version }
    why ??= `Your copy of ${spec.name} (${version}) is not one Celeste has been tried with (${spec.tested} or a newer ${spec.tested.split('.').slice(0, 2).join('.')}), so Celeste uses a copy of its own.`
  }
  return why ? { why } : {}
}

/** Remembers what the check found, so asking is instant; `refresh` looks again (a copy may have been installed or updated). */
export class OwnPrograms {
  private found = new Map<OwnVendor, OwnCopy>()
  private looking: Promise<void> | undefined
  /** What was looked at last, so the same files are not started again when they have not changed. */
  private seen = new Map<string, string>()

  constructor(
    private readonly specs: Record<OwnVendor, OwnSpec>,
    private readonly enabled: () => boolean,
    private readonly options: { where?: () => Where; run?: RunVersion; exists?: (file: string) => boolean } = {}
  ) {}

  refresh(): Promise<void> {
    this.looking ??= (async () => {
      const where = (this.options.where ?? hereNow)()
      const run: RunVersion = async (file) => {
        // The same file with the same size and date answers the same, so it is not started again.
        let stamp = ''
        try {
          const s = statSync(file)
          stamp = `${s.size}:${s.mtimeMs}`
        } catch {
          /* checked below */
        }
        const key = `${file}|${stamp}`
        const known = this.seen.get(key)
        if (known !== undefined && stamp) return known
        const out = (await (this.options.run ?? runVersion)(file)) ?? ''
        if (stamp && out) this.seen.set(key, out)
        return out
      }
      await Promise.all(
        (Object.keys(this.specs) as OwnVendor[]).map(async (vendor) => {
          this.found.set(vendor, await checkOwn(this.specs[vendor], where, run, this.options.exists))
        })
      )
    })().finally(() => (this.looking = undefined))
    return this.looking
  }

  /** The program to use, or undefined when the switch is off, nothing passed, or no look has finished. */
  file(vendor: OwnVendor): string | undefined {
    return this.enabled() ? this.found.get(vendor)?.file : undefined
  }

  info(vendor: OwnVendor): OwnCopy & { enabled: boolean } {
    return { ...(this.found.get(vendor) ?? {}), enabled: this.enabled() }
  }
}
