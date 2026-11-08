import { describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import { TerminalService, defaultShell, type PtyLike, type SpawnOptions } from './terminal'

/** A shell that is only a list of what happened to it. */
class FakePty implements PtyLike {
  pid = 1
  written: string[] = []
  sizes: Array<[number, number]> = []
  killed = false
  private data: Array<(d: string) => void> = []
  private exit: Array<(e: { exitCode: number }) => void> = []
  constructor(readonly file: string, readonly args: string[], readonly options: SpawnOptions) {}
  onData(l: (d: string) => void) {
    this.data.push(l)
    return { dispose: () => undefined }
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.exit.push(l)
    return { dispose: () => undefined }
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r])
  }
  kill() {
    this.killed = true
  }
  says(d: string) {
    this.data.forEach((l) => l(d))
  }
  ends(code: number) {
    this.exit.forEach((l) => l({ exitCode: code }))
  }
}

function setup(folderOf: (id: string) => string = () => process.cwd()) {
  const made: FakePty[] = []
  const pushed: CorePush[] = []
  const terminals = new TerminalService({
    folderOf,
    push: (p) => pushed.push(p),
    spawn: (file, args, options) => {
      const p = new FakePty(file, args, options)
      made.push(p)
      return p
    },
    shell: () => ({ file: 'sh', args: ['-l'] })
  })
  return { terminals, made, pushed, api: terminals.api }
}

describe('the integrated terminal', () => {
  it('starts a shell in the session folder, at the size asked, with a terminal type', async () => {
    const { api, made } = setup(() => process.cwd())
    await api['terminal.open']('s1', 100, 30)
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ file: 'sh', args: ['-l'] })
    expect(made[0]?.options).toMatchObject({ cwd: process.cwd(), cols: 100, rows: 30 })
    expect(made[0]?.options.env['TERM']).toBe('xterm-256color')
  })

  it('asks which folder from the session, never from the window', async () => {
    const asked: string[] = []
    const { api } = setup((id) => (asked.push(id), process.cwd()))
    await api['terminal.open']('abc', 80, 24)
    expect(asked).toEqual(['abc'])
  })

  it('refuses a session that has no folder', async () => {
    const { api, made } = setup(() => {
      throw new Error('Only Develop sessions have a project folder.')
    })
    await expect(api['terminal.open']('chat', 80, 24)).rejects.toThrow('Develop')
    expect(made).toHaveLength(0)
  })

  it('sends what the shell prints to the window, and keeps the end of it for a window that was away', async () => {
    const { api, made, pushed } = setup()
    await api['terminal.open']('s1', 80, 24)
    made[0]?.says('hello ')
    made[0]?.says('world')
    expect(pushed).toEqual([
      { type: 'terminal', sessionId: 's1', data: 'hello ' },
      { type: 'terminal', sessionId: 's1', data: 'world' }
    ])
    // Opening again joins the shell that is running instead of starting another, and brings back what it printed.
    const again = await api['terminal.open']('s1', 90, 20)
    expect(made).toHaveLength(1)
    expect(again).toEqual({ output: 'hello world', running: true })
    expect(made[0]?.sizes).toEqual([[90, 20]])
  })

  it('keeps only the last part of a very long output', async () => {
    const { api, made } = setup()
    await api['terminal.open']('s1', 80, 24)
    made[0]?.says('a'.repeat(150_000))
    made[0]?.says('b'.repeat(150_000))
    const out = (await api['terminal.open']('s1', 80, 24)).output
    expect(out.length).toBe(200_000)
    expect(out.endsWith('b')).toBe(true)
  })

  it('passes typing through, and drops anything absurdly large or not text', async () => {
    const { api, made } = setup()
    await api['terminal.open']('s1', 80, 24)
    await api['terminal.write']('s1', 'ls\r')
    await api['terminal.write']('s1', 'x'.repeat(100_000))
    await api['terminal.write']('s1', 5 as never)
    await api['terminal.write']('nobody', 'ls\r')
    expect(made[0]?.written[0]).toBe('ls\r')
    expect(made[0]?.written[1]).toHaveLength(64 * 1024)
    expect(made[0]?.written).toHaveLength(2)
  })

  it('keeps the size within sane limits', async () => {
    const { api, made } = setup()
    await api['terminal.open']('s1', 80, 24)
    await api['terminal.resize']('s1', 100_000, 0)
    await api['terminal.resize']('s1', Number.NaN, 40)
    expect(made[0]?.sizes).toEqual([[500, 2], [500, 40]])
  })

  it('says when the shell ends, and starts a fresh one the next time it is opened', async () => {
    const { api, made, pushed } = setup()
    await api['terminal.open']('s1', 80, 24)
    made[0]?.ends(0)
    expect(pushed.at(-1)).toEqual({ type: 'terminal', sessionId: 's1', data: '', exited: 0 })
    await api['terminal.write']('s1', 'ignored')
    expect(made[0]?.written).toEqual([])
    await api['terminal.open']('s1', 80, 24)
    expect(made).toHaveLength(2)
  })

  it('closing ends the shell and forgets what it printed', async () => {
    const { api, made, terminals } = setup()
    await api['terminal.open']('s1', 80, 24)
    made[0]?.says('secret')
    await api['terminal.close']('s1')
    expect(made[0]?.killed).toBe(true)
    expect(terminals.count).toBe(0)
    expect((await api['terminal.open']('s1', 80, 24)).output).toBe('')
  })

  it('has a limit on how many shells run at once, and closeAll ends them all', async () => {
    const { api, made, terminals } = setup()
    for (let i = 0; i < 8; i++) await api['terminal.open'](`s${i}`, 80, 24)
    await expect(api['terminal.open']('one-too-many', 80, 24)).rejects.toThrow('8 terminals')
    terminals.closeAll()
    expect(made.every((p) => p.killed)).toBe(true)
    expect(terminals.count).toBe(0)
  })
})

describe('the shell that is started', () => {
  it('is PowerShell on Windows and the login shell elsewhere', () => {
    expect(defaultShell('win32', {})).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] })
    expect(defaultShell('linux', { SHELL: '/definitely/not/here' }).file).toBe('/bin/bash')
    expect(defaultShell('darwin', {}).file).toBe('/bin/zsh')
  })
})

describe('a real shell', () => {
  it('runs a command and shows its output', async () => {
    const pushed: CorePush[] = []
    const terminals = new TerminalService({ folderOf: () => process.cwd(), push: (p) => pushed.push(p) })
    try {
      await terminals.api['terminal.open']('real', 100, 30)
      // The sum is only in the output if the shell ran the command: the typed text has the sum itself in it.
      const command = process.platform === 'win32' ? 'echo celeste-$(6*7)-done' : 'echo celeste-$((6*7))-done'
      await terminals.api['terminal.write']('real', command + '\r')
      // PowerShell redraws the line as it is typed, so colour codes can sit inside a word.
      const seen = () =>
        pushed
          .map((p) => (p.type === 'terminal' ? p.data : ''))
          .join('')
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
      for (let i = 0; i < 150 && !seen().includes('celeste-42-done'); i++) await new Promise((r) => setTimeout(r, 100))
      expect(seen()).toContain('celeste-42-done')
    } finally {
      terminals.closeAll()
    }
  }, 20_000)
})
