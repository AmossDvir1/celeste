import { spawn, type ChildProcess } from 'node:child_process'

/*
 * A client for `codex app-server --listen stdio://`: JSON messages, one per line, over the program's input and output.
 * Codex sends three kinds of message back: answers to what Celeste asked, notifications (events), and requests of its
 * own (an approval, a question), which Celeste must answer. The wire format leaves out the "jsonrpc" field.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined }

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
  }
}

export interface RpcHandlers {
  /** Something happened (a turn started, text arrived). */
  notification: (method: string, params: Record<string, unknown>) => void
  /** Codex needs an answer. Resolve with the result; reject to send an error back. */
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** The program ended, however it did. */
  exit: (code: number | null, stderr: string) => void
}

/** What the client needs of a running program, so a test can stand in for it. */
export interface Transport {
  write(line: string): void
  onLine(callback: (line: string) => void): void
  onExit(callback: (code: number | null) => void): void
  /** The end of what the program wrote to its error output, for the message when it fails. */
  stderr(): string
  kill(): void
}

export function spawnTransport(file: string, args: string[], env: Record<string, string | undefined>): Transport {
  const child: ChildProcess = spawn(file, args, { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-4000)
  })
  // A write to a program that has already gone is not an error worth crashing for: its exit says what happened.
  child.stdin?.on('error', () => undefined)
  return {
    write: (line) => void child.stdin?.write(`${line}\n`),
    onLine: (callback) => {
      let buffer = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let at: number
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).trim()
          buffer = buffer.slice(at + 1)
          if (line) callback(line)
        }
      })
    },
    onExit: (callback) => {
      child.once('exit', callback)
      child.once('error', () => callback(null))
    },
    stderr: () => tail,
    kill: () => {
      if (!child.killed && child.exitCode === null) child.kill()
    }
  }
}

export class RpcClient {
  private nextId = 1
  private readonly waiting = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false

  constructor(
    private readonly transport: Transport,
    private readonly handlers: RpcHandlers
  ) {
    transport.onLine((line) => this.receive(line))
    transport.onExit((code) => {
      this.closed = true
      const error = new RpcError('The OpenAI program stopped.')
      for (const w of this.waiting.values()) w.reject(error)
      this.waiting.clear()
      handlers.exit(code, transport.stderr())
    })
  }

  get running(): boolean {
    return !this.closed
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('The OpenAI program is not running.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.waiting.delete(id) && reject(new RpcError(`${method} did not answer in time.`)), timeoutMs) : undefined
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.transport.write(JSON.stringify({ method, id, ...(params !== undefined ? { params } : {}) }))
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.transport.write(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }))
  }

  close(): void {
    this.closed = true
    this.transport.kill()
  }

  private receive(line: string): void {
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } }
    try {
      m = JSON.parse(line) as typeof m
    } catch {
      return // not a message: Codex logs to its error output, but a stray line is not worth failing for
    }
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
    if (m.id !== undefined && m.method === undefined) {
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if (m.error) w.reject(new RpcError(m.error.message ?? 'The OpenAI program reported an error.', m.error.code))
      else w.resolve(m.result)
      return
    }
    if (m.method === undefined) return
    if (m.id === undefined) {
      this.handlers.notification(m.method, params)
      return
    }
    const id = m.id
    this.handlers.request(m.method, params).then(
      (result) => this.reply({ id, result: result ?? {} }),
      (err: unknown) => this.reply({ id, error: { code: -32601, message: err instanceof Error ? err.message : String(err) } })
    )
  }

  private reply(message: unknown): void {
    if (!this.closed) this.transport.write(JSON.stringify(message))
  }
}
