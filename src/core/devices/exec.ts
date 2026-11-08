import { spawn } from 'node:child_process'

export interface ExecOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Added to the environment. Secrets travel this way, never on a command line. */
  env?: Record<string, string>
  /** Stops reading after this many bytes of output. */
  maxBytes?: number
  input?: Buffer | string
  /** The folder the program starts in. */
  cwd?: string
}

export interface ExecResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
  cancelled: boolean
  /** The program is not installed. */
  missing: boolean
}

/** Runs a program. Every outside tool Celeste uses goes through this, so tests can answer for it. */
export type Exec = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

export const runProcess: Exec = (file, args, options = {}) =>
  new Promise((resolve) => {
    const max = options.maxBytes ?? 8 * 1024 * 1024
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let timedOut = false
    let cancelled = false
    let settled = false
    const done = (code: number | null, missing = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, cancelled, missing })
    }
    const child = spawn(file, args, { env: { ...process.env, ...options.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}) })
    const stop = () => child.kill()
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs ?? 60_000)
    const onAbort = () => {
      cancelled = true
      stop()
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size <= max) into.push(chunk)
      else stop()
    }
    child.stdout.on('data', take(out))
    child.stderr.on('data', take(err))
    child.once('error', (e: NodeJS.ErrnoException) => done(null, e.code === 'ENOENT'))
    child.once('close', (code) => done(code))
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input)
  })

/** Output as text. Some Windows tools write UTF-16, which shows up as text with a zero byte after each letter. */
export function textOf(buffer: Buffer): string {
  const sample = buffer.subarray(0, 64)
  const utf16 = sample.length > 1 && sample.filter((b) => b === 0).length >= sample.length / 4
  return (utf16 ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^﻿/, '')
}
