import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { CorePush, TerminalOpened } from '@shared/api'

/*
 * The integrated terminal in Develop: a real shell, started in the session's project folder (or in its separate copy), shown in
 * the window with xterm.js. One shell per session. It keeps running while the person looks at something else, and the last part
 * of what it printed is kept so that coming back shows it again. Shells end when the person closes the terminal, when the session
 * is removed, and when Celeste quits.
 */

export interface PtyLike {
  readonly pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnOptions {
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
}
export type SpawnPty = (file: string, args: string[], options: SpawnOptions) => PtyLike

/** The shell the person would expect: PowerShell on Windows, their login shell elsewhere. */
export function defaultShell(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  const file = env['SHELL'] && existsSync(env['SHELL']) ? env['SHELL'] : platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  return { file, args: [] }
}

const loadPty = async (): Promise<SpawnPty> => {
  // Loaded when a terminal is first opened: the program starts faster, and nothing breaks for someone who never uses one.
  const pty = await import('@lydell/node-pty')
  return (file, args, options) => pty.spawn(file, args, { name: 'xterm-256color', ...options }) as unknown as PtyLike
}

const KEEP = 200_000
const MAX_TERMINALS = 8
const MAX_WRITE = 64 * 1024

interface Running {
  pty: PtyLike
  /** The end of what was printed. Starts a few characters into an escape sequence at worst, which a terminal ignores. */
  tail: string
  cols: number
  rows: number
  exited: number | undefined
}

const size = (n: unknown, fallback: number, max: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(2, Math.round(n))) : fallback)

export class TerminalService {
  private readonly running = new Map<string, Running>()
  private spawn: SpawnPty | undefined

  constructor(
    private readonly options: {
      /** The folder to start in, for a session. Throws when the session has none. */
      folderOf(sessionId: string): string
      push(p: CorePush): void
      spawn?: SpawnPty
      shell?: () => { file: string; args: string[] }
    }
  ) {
    this.spawn = options.spawn
  }

  readonly api = {
    'terminal.open': (sessionId: string, cols: number, rows: number) => this.open(sessionId, cols, rows),
    'terminal.write': async (sessionId: string, data: string) => this.write(sessionId, data),
    'terminal.resize': async (sessionId: string, cols: number, rows: number) => this.resize(sessionId, cols, rows),
    'terminal.close': async (sessionId: string) => this.close(sessionId)
  }

  private async open(sessionId: string, cols: number, rows: number): Promise<TerminalOpened> {
    if (typeof sessionId !== 'string') throw new Error('Invalid session')
    const c = size(cols, 80, 500)
    const r = size(rows, 24, 200)
    const mine = this.running.get(sessionId)
    if (mine && mine.exited === undefined) {
      this.resize(sessionId, c, r)
      return { output: mine.tail, running: true }
    }
    // A shell that has ended is replaced by a fresh one.
    if (mine) this.running.delete(sessionId)
    if (this.running.size >= MAX_TERMINALS) throw new Error(`There are already ${MAX_TERMINALS} terminals open. Close one first.`)
    const cwd = this.options.folderOf(sessionId)
    this.spawn ??= await loadPty()
    const shell = (this.options.shell ?? defaultShell)()
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'
    const pty = this.spawn(shell.file, shell.args, { cwd: existsSync(cwd) ? cwd : homedir(), cols: c, rows: r, env })
    const entry: Running = { pty, tail: '', cols: c, rows: r, exited: undefined }
    this.running.set(sessionId, entry)
    pty.onData((data) => {
      entry.tail = (entry.tail + data).slice(-KEEP)
      this.options.push({ type: 'terminal', sessionId, data })
    })
    pty.onExit(({ exitCode }) => {
      entry.exited = exitCode
      this.options.push({ type: 'terminal', sessionId, data: '', exited: exitCode })
    })
    return { output: '', running: true }
  }

  private write(sessionId: string, data: string): void {
    const t = this.running.get(sessionId)
    if (!t || t.exited !== undefined || typeof data !== 'string') return
    // Typing and pasting arrive in small pieces; something enormous is not either.
    t.pty.write(data.length > MAX_WRITE ? data.slice(0, MAX_WRITE) : data)
  }

  private resize(sessionId: string, cols: number, rows: number): void {
    const t = this.running.get(sessionId)
    if (!t || t.exited !== undefined) return
    const c = size(cols, t.cols, 500)
    const r = size(rows, t.rows, 200)
    if (c === t.cols && r === t.rows) return
    t.cols = c
    t.rows = r
    try {
      t.pty.resize(c, r)
    } catch {
      /* the shell ended a moment ago */
    }
  }

  /** Ends the shell, if there is one, and forgets what it printed. */
  close(sessionId: string): void {
    const t = this.running.get(sessionId)
    if (!t) return
    this.running.delete(sessionId)
    if (t.exited === undefined) {
      try {
        t.pty.kill()
      } catch {
        /* already gone */
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.running.keys()]) this.close(id)
  }

  /** How many shells are running, for tests. */
  get count(): number {
    return this.running.size
  }
}
