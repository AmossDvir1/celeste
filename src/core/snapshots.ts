import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import type { CheckpointChanges, CheckpointFile } from '@shared/api'

/*
 * Checkpoints: before each message in a Develop session, the project folder is saved, so that a turn that went wrong can be
 * undone whichever vendor ran it.
 *
 * The copy is a private git repository kept in Celeste's own data folder (one per session), pointed at the project folder
 * as its working tree. The project's own `.git` is never read for this and never written to: nothing appears in the person's
 * history, branches or stash. The project's `.gitignore` is honoured, so what it ignores (node_modules, build output, `.env`)
 * is neither saved nor touched by a revert. A few things are always left out, and so is any file over 25 MB.
 *
 * Reverting puts back what changed since the checkpoint and deletes what was created since: it does not overwrite the whole
 * folder. How the folder is just before a revert is saved first, so a revert can itself be undone.
 */

export interface Snapshots {
  /** Saves the folder as it is now. Resolves with an id that `restore` and `changes` take. */
  take(sessionId: string, cwd: string): Promise<string>
  /** What changed in the folder between two saves. */
  changes(sessionId: string, cwd: string, from: string, to: string): Promise<CheckpointChanges>
  /** What `restore` to this save would change in the folder, as it would be afterwards. */
  preview(sessionId: string, cwd: string, to: string): Promise<CheckpointChanges>
  /** Puts the folder back as it was at `to`, after saving how it is now (`undoId`). */
  restore(sessionId: string, cwd: string, to: string): Promise<{ restored: number; removed: number; undoId: string }>
  /** Deletes everything kept for a session. */
  forget(sessionId: string): void
}

/** Something to tell the person: git is missing, the folder is too large, and so on. */
export class SnapshotError extends Error {}

export interface SnapshotLimits {
  /** Files larger than this are left out of the save. */
  file: number
  /** More changed files than this in one save, and the folder is too large to checkpoint. */
  files: number
  /** More changed bytes than this in one save, and the folder is too large to checkpoint. */
  bytes: number
  /** How long one git command may take. */
  timeoutMs: number
}

const DEFAULT_LIMITS: SnapshotLimits = { file: 25 * 1024 * 1024, files: 50_000, bytes: 1024 * 1024 * 1024, timeoutMs: 120_000 }

/** Never saved, whatever the project says: folders that are rebuilt from a lock file and are far too big. */
const ALWAYS_LEFT_OUT = ['node_modules/', '.venv/', '__pycache__/', '*.pyc', '.DS_Store', 'Thumbs.db']

const COMMIT = /^[0-9a-f]{40}$/
const MAX_LISTED = 200

/** Everything that must be the same on every computer, whatever the person has set up in git. */
const GIT_SETTINGS = [
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.quotePath=false',
  'core.longpaths=true',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'gc.auto=0',
  'commit.gpgsign=false',
  'user.name=Celeste',
  'user.email=celeste@localhost',
  'init.defaultBranch=main',
  // The folder may belong to another user (a shared drive); this copy only reads and writes it as the person asked.
  'safe.directory=*'
].flatMap((s) => ['-c', s])

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  // The person's own git settings (hooks, templates, filters) must not reach this private copy.
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra }
}

interface RunOptions {
  workTree?: string
  input?: string
  env?: Record<string, string>
  /** Do not fail on a non-zero exit (git add --ignore-errors still exits 1 when it skipped a file). */
  tolerant?: boolean
  timeoutMs: number
}

function git(gitDir: string, args: string[], options: RunOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const full = [...GIT_SETTINGS, `--git-dir=${gitDir}`, ...(options.workTree ? [`--work-tree=${options.workTree}`] : []), ...args]
    const child = spawn('git', full, { cwd: options.workTree ?? dirname(gitDir), env: gitEnv(options.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      done(new SnapshotError(`Saving the folder took longer than ${Math.round(options.timeoutMs / 1000)} seconds, so Celeste stopped.`))
    }, options.timeoutMs)
    const done = (e?: Error, value?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolvePromise(value ?? Buffer.alloc(0))
    }
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.on('error', (e: NodeJS.ErrnoException) => done(new SnapshotError(e.code === 'ENOENT' ? 'Git was not found on this computer, and checkpoints need it.' : `Git could not start: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0 || options.tolerant) done(undefined, Buffer.concat(out))
      else done(new SnapshotError(`Git (${args[0]}) failed: ${err.trim().slice(0, 300) || `exit code ${code}`}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

const escapeGlob = (p: string) => p.replace(/([\\*?[\]])/g, '\\$1')
const mb = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)))

export class GitSnapshots implements Snapshots {
  private readonly queue = new Map<string, Promise<unknown>>()
  private readonly limits: SnapshotLimits

  /** `dir` is where the private copies are kept: one folder (`<session id>.git`) per session. */
  constructor(
    private readonly dir: string,
    limits: Partial<SnapshotLimits> = {}
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  private gitDir(sessionId: string): string {
    if (!/^[\w-]+$/.test(sessionId)) throw new SnapshotError('Invalid session')
    return join(this.dir, `${sessionId}.git`)
  }

  /** One thing at a time per session: two saves at once would fight over the same index. */
  private serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queue.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(fn)
    this.queue.set(sessionId, run.catch(() => undefined))
    return run
  }

  private run(gitDir: string, args: string[], extra: Omit<RunOptions, 'timeoutMs'> = {}): Promise<Buffer> {
    return git(gitDir, args, { ...extra, timeoutMs: this.limits.timeoutMs })
  }

  private checkFolder(cwd: string): string {
    const folder = resolve(cwd)
    let ok = false
    try {
      ok = statSync(folder).isDirectory()
    } catch {
      ok = false
    }
    if (!ok) throw new SnapshotError('The project folder is not there any more.')
    if (parse(folder).root === folder || folder === resolve(homedir())) {
      throw new SnapshotError('This folder is too broad to checkpoint. Choose the project’s own folder.')
    }
    return folder
  }

  private async ensure(gitDir: string): Promise<void> {
    if (existsSync(join(gitDir, 'HEAD'))) return
    mkdirSync(dirname(gitDir), { recursive: true })
    // No template: nothing in it that could run (hooks) and nothing to explain.
    await this.run(gitDir, ['init', '-q', '--template='])
    this.writeExclude(gitDir, [])
  }

  private bigFile(gitDir: string): string {
    return join(gitDir, 'celeste-left-out.txt')
  }

  private writeExclude(gitDir: string, big: string[]): void {
    mkdirSync(join(gitDir, 'info'), { recursive: true })
    writeFileSync(join(gitDir, 'info', 'exclude'), [...ALWAYS_LEFT_OUT, ...big.map((p) => `/${escapeGlob(p)}`)].join('\n') + '\n')
  }

  /** Looks at what has changed since the last save, leaves out files that are too big, and refuses a folder that is too large. */
  private async scan(gitDir: string, cwd: string): Promise<void> {
    const listed = await this.run(gitDir, ['ls-files', '-z', '--others', '--modified', '--exclude-standard'], { workTree: cwd })
    const paths = [...new Set(listed.toString('utf8').split('\0').filter(Boolean))]
    const big: string[] = []
    let count = 0
    let bytes = 0
    for (const p of paths) {
      let size: number
      try {
        const st = statSync(join(cwd, p))
        if (!st.isFile()) continue
        size = st.size
      } catch {
        continue
      }
      if (size > this.limits.file) {
        big.push(p)
        continue
      }
      count++
      bytes += size
    }
    if (count > this.limits.files || bytes > this.limits.bytes) {
      throw new SnapshotError(`This folder is too large to checkpoint (${count.toLocaleString('en')} files, ${mb(bytes).toLocaleString('en')} MB to save at once). Add the big folders to .gitignore.`)
    }
    if (big.length) {
      const known = existsSync(this.bigFile(gitDir)) ? readFileSync(this.bigFile(gitDir), 'utf8').split('\n').filter(Boolean) : []
      const all = [...new Set([...known, ...big])]
      writeFileSync(this.bigFile(gitDir), all.join('\n'))
      this.writeExclude(gitDir, all)
    }
  }

  private async snap(sessionId: string, cwd: string, label: string): Promise<string> {
    const folder = this.checkFolder(cwd)
    const gitDir = this.gitDir(sessionId)
    await this.ensure(gitDir)
    await this.scan(gitDir, folder)
    // A file that vanishes while it is being added makes git exit 1 after adding the rest, which is fine here.
    await this.run(gitDir, ['add', '-A', '--ignore-errors'], { workTree: folder, tolerant: true })
    await this.run(gitDir, ['commit', '-q', '--allow-empty', '--no-verify', '-m', label], { workTree: folder })
    return (await this.run(gitDir, ['rev-parse', 'HEAD'])).toString('utf8').trim()
  }

  take(sessionId: string, cwd: string): Promise<string> {
    return this.serial(sessionId, () => this.snap(sessionId, cwd, 'Before a message'))
  }

  private async diff(gitDir: string, from: string, to: string): Promise<CheckpointFile[]> {
    if (!COMMIT.test(from) || !COMMIT.test(to)) throw new SnapshotError('Invalid checkpoint')
    const [names, numbers] = await Promise.all([
      this.run(gitDir, ['diff', '--no-renames', '--name-status', '-z', from, to]),
      this.run(gitDir, ['diff', '--no-renames', '--numstat', '-z', from, to])
    ])
    const counts = new Map<string, { added: number; removed: number }>()
    for (const record of numbers.toString('utf8').split('\0')) {
      const [added, removed, ...path] = record.split('\t')
      if (path.length === 0) continue
      // A binary file shows "-" for both.
      counts.set(path.join('\t'), { added: Number(added) || 0, removed: Number(removed) || 0 })
    }
    const tokens = names.toString('utf8').split('\0').filter((t) => t !== '')
    const files: CheckpointFile[] = []
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const code = tokens[i] as string
      const path = tokens[i + 1] as string
      const n = counts.get(path) ?? { added: 0, removed: 0 }
      files.push({ path, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified', ...n })
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  private listed(files: CheckpointFile[]): CheckpointChanges {
    return { files: files.slice(0, MAX_LISTED), more: Math.max(0, files.length - MAX_LISTED) }
  }

  changes(sessionId: string, _cwd: string, from: string, to: string): Promise<CheckpointChanges> {
    return this.serial(sessionId, async () => this.listed(await this.diff(this.gitDir(sessionId), from, to)))
  }

  preview(sessionId: string, cwd: string, to: string): Promise<CheckpointChanges> {
    return this.serial(sessionId, async () => {
      const now = await this.snap(sessionId, cwd, 'Looking at what a revert would change')
      // The change from the checkpoint to now, turned around: what a revert does is the opposite.
      const files = (await this.diff(this.gitDir(sessionId), to, now)).map(
        (f): CheckpointFile => ({ path: f.path, status: f.status === 'added' ? 'deleted' : f.status === 'deleted' ? 'added' : 'modified', added: f.removed, removed: f.added })
      )
      return this.listed(files)
    })
  }

  restore(sessionId: string, cwd: string, to: string): Promise<{ restored: number; removed: number; undoId: string }> {
    return this.serial(sessionId, async () => {
      if (!COMMIT.test(to)) throw new SnapshotError('Invalid checkpoint')
      const folder = this.checkFolder(cwd)
      const gitDir = this.gitDir(sessionId)
      if (!existsSync(join(gitDir, 'HEAD'))) throw new SnapshotError('This checkpoint is no longer kept.')
      await this.run(gitDir, ['cat-file', '-e', `${to}^{commit}`]).catch(() => {
        throw new SnapshotError('This checkpoint is no longer kept.')
      })
      // How the folder is right now, so that this revert can be undone.
      const undoId = await this.snap(sessionId, folder, 'Before reverting')

      const names = (await this.run(gitDir, ['diff', '--no-renames', '--name-status', '-z', to, undoId])).toString('utf8').split('\0').filter((t) => t !== '')
      const restore: string[] = []
      const remove: string[] = []
      for (let i = 0; i + 1 < names.length; i += 2) {
        const path = names[i + 1] as string
        // Added since the checkpoint: it did not exist then, so it goes. Anything else comes back as it was.
        if ((names[i] as string).startsWith('A')) remove.push(path)
        else restore.push(path)
      }

      if (restore.length) {
        await this.run(gitDir, ['checkout', to, '--pathspec-from-file=-', '--pathspec-file-nul'], {
          workTree: folder,
          input: restore.join('\0'),
          // The names are file names, not patterns.
          env: { GIT_LITERAL_PATHSPECS: '1' }
        })
      }

      let removed = 0
      for (const path of remove) {
        const target = resolve(folder, path)
        if (!target.startsWith(folder + sep)) continue
        if (existsSync(target)) {
          rmSync(target, { force: true })
          removed++
        }
        // A folder the agent made and that is now empty goes too, but only as far as the project folder.
        for (let d = dirname(target); d !== folder && d.startsWith(folder + sep); d = dirname(d)) {
          try {
            rmdirSync(d)
          } catch {
            break
          }
        }
      }
      return { restored: restore.length, removed, undoId }
    })
  }

  forget(sessionId: string): void {
    let gitDir: string
    try {
      gitDir = this.gitDir(sessionId)
    } catch {
      return
    }
    this.queue.delete(sessionId)
    try {
      rmSync(gitDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // Held open for a moment on Windows; what is left is a small folder in Celeste's own data folder.
    }
  }
}
