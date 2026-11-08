import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { WorktreeInfo } from '@shared/api'

/*
 * A Develop session can work in its own copy of a git project: a worktree, which shares the project's repository but has its own
 * folder and its own branch. The agent can change things there without touching the folder the person has open, and two sessions
 * on one project do not trample each other.
 *
 * Copies are made in Celeste's own data folder, on a branch named `celeste/<words>-<id>` that starts from the project's last
 * commit. Nothing is ever removed unless the person asks, and only copies Celeste made can be removed.
 */

/** A git command, in a folder. Rejects with git's own message, shortened. */
function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolvePromise(stdout)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return reject(new Error('Git was not found on this computer, and a separate copy needs it.'))
      reject(new Error(stderr.trim().split('\n')[0]?.slice(0, 300) || err.message))
    })
  })
}

const tryGit = (cwd: string, args: string[]): Promise<string | undefined> => git(cwd, args).then((s) => s, () => undefined)

/** Words from the person's message, made safe to be part of a branch name. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      // Accents come apart from their letters here; they are dropped, so "é" stays an "e".
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '') || 'session'
  )
}

export class Worktrees {
  /** `dir` is where the copies live: Celeste's data folder, then `worktrees`. */
  constructor(readonly dir: string) {}

  /** True for a folder that is one of Celeste's copies. */
  isCopy(path: string | undefined): boolean {
    if (!path) return false
    const root = resolve(this.dir)
    const target = resolve(path)
    return process.platform === 'win32' ? target.toLowerCase().startsWith(root.toLowerCase() + sep) : target.startsWith(root + sep)
  }

  /** Makes a copy of the project at `repo` on a new branch from its last commit. `hint` (the person's words) names the branch. */
  async create(repo: string, hint: string): Promise<{ path: string; branch: string }> {
    if (typeof repo !== 'string' || repo.length > 1000) throw new Error('Invalid folder')
    let top: string
    try {
      if (!statSync(repo).isDirectory()) throw new Error('not a folder')
      top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim()
    } catch (err) {
      if (err instanceof Error && /Git was not found/.test(err.message)) throw err
      throw new Error('A separate copy needs a git project. This folder is not one.')
    }
    if ((await tryGit(top, ['rev-parse', '--verify', 'HEAD'])) === undefined) throw new Error('This project has no commits yet, so there is nothing to copy. Make a first commit.')
    const id = randomBytes(4).toString('hex')
    const branch = `celeste/${slug(String(hint))}-${id}`
    const path = join(this.dir, `${slug(basename(top))}-${id}`)
    mkdirSync(this.dir, { recursive: true })
    await git(top, ['worktree', 'add', '-b', branch, path, 'HEAD'])
    return { path, branch }
  }

  /** Whether git still lists this folder as a working copy of the project. */
  private async registered(repo: string, path: string): Promise<boolean> {
    const same = (p: string) => resolve(p).toLowerCase()
    const listing = (await tryGit(repo, ['worktree', 'list', '--porcelain'])) ?? ''
    return listing.split('\n').some((l) => l.startsWith('worktree ') && same(l.slice('worktree '.length).trim()) === same(path))
  }

  /** What is known about one copy. Undefined when the folder is not a working copy of anything. */
  private async inspect(path: string): Promise<Omit<WorktreeInfo, 'session'> | undefined> {
    if (!existsSync(join(path, '.git'))) return undefined
    const branch = (await tryGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
    if (!branch) return undefined
    // The first entry of the list is the project's own folder, the one the copy was made from.
    const listing = await tryGit(path, ['worktree', 'list', '--porcelain'])
    const repo = listing?.split('\n').find((l) => l.startsWith('worktree '))?.slice('worktree '.length).trim() ?? ''
    const status = (await tryGit(path, ['status', '--porcelain'])) ?? ''
    // Commits that are on this branch and nowhere else: work that would be lost with the branch.
    // (An excluded pattern is written without the refs/heads/ that --branches adds.)
    const ahead = await tryGit(path, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', '--remotes'])
    return { path, name: basename(path), branch, repo, changed: status.split('\n').filter(Boolean).length, ahead: Number(ahead?.trim()) || 0 }
  }

  /** The copies on disk, newest first. */
  async list(): Promise<Omit<WorktreeInfo, 'session'>[]> {
    if (!existsSync(this.dir)) return []
    const found: { info: Omit<WorktreeInfo, 'session'>; at: number }[] = []
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name)
      try {
        if (!statSync(path).isDirectory()) continue
        // An empty folder is what is left of a copy that was removed while something still held it. It is cleared when it can be.
        if (readdirSync(path).length === 0) {
          rmSync(path, { recursive: true, force: true })
          continue
        }
        const info = await this.inspect(path)
        if (info) found.push({ info, at: statSync(path).mtimeMs })
      } catch {
        /* not something that can be read: not listed */
      }
    }
    return found.sort((a, b) => b.at - a.at).map((f) => f.info)
  }

  /** Removes a copy and its branch. Only a copy Celeste made, and only when asked: what is in it is gone. */
  async remove(path: string): Promise<void> {
    if (typeof path !== 'string' || !this.isCopy(path) || resolve(path) === resolve(this.dir)) throw new Error('That is not a separate copy made by Celeste.')
    if (!existsSync(path)) return
    const info = await this.inspect(path)
    if (!info) {
      // A copy whose project was moved or deleted has a `.git` that leads nowhere: nothing else uses this folder, so it can go.
      if (existsSync(join(path, '.git'))) {
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        return
      }
      throw new Error('That folder is not a working copy of a git project.')
    }
    if (info.repo && existsSync(info.repo)) {
      // A program that was working in the folder may still be shutting down: try again for a few seconds before giving up.
      for (let attempt = 1; ; attempt++) {
        try {
          await git(info.repo, ['worktree', 'remove', '--force', path])
          break
        } catch (err) {
          // Git may have taken the copy out of its list and then failed to delete the folder, which something briefly held. The
          // folder is cleared below; asking git again would only say it is not a working copy.
          if (!(await this.registered(info.repo, path))) break
          // Otherwise a folder that cannot be deleted yet is most likely still in use: about fifteen seconds of tries.
          if (attempt >= 15) throw err
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
      // Git can report success and still leave the folder when a program had files in it; the leftover is cleared here.
      for (let attempt = 1; existsSync(path) && attempt <= 20; attempt++) {
        try {
          rmSync(path, { recursive: true, force: true })
        } catch {
          await new Promise((r) => setTimeout(r, 750))
        }
      }
      // Only a branch Celeste made is ever deleted.
      if (info.branch.startsWith('celeste/')) await tryGit(info.repo, ['branch', '-D', info.branch])
    } else {
      // The project it was made from has been moved or deleted: nothing links to this folder any more.
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
}
