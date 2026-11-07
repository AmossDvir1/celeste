import type { VendorProgress } from '@shared/api'
import { describe, expect, it } from 'vitest'
import { CopilotHost, RuntimeMissingError, type LoginSession, type RuntimeSource, type SdkClientHandle } from './host'
import { VendorService } from '../../vendors'

type Step = Parameters<LoginSession['rpc']['accounts']['login']['advance']> extends never ? never : Awaited<ReturnType<LoginSession['rpc']['accounts']['login']['advance']>>

interface Script {
  begin: Step
  /** What each `advance` call answers, in order. A function waits until released. An Error rejects. */
  advances: (Step | Error | (() => Promise<Step>))[]
  signedIn?: boolean
  startFails?: string
  /** `begin` waits for this before it answers, or fails if it rejects. */
  beginGate?: Promise<void>
}

function world(script: Script, runtime?: RuntimeSource) {
  const calls: string[] = []
  const state = { signedIn: script.signedIn ?? false, deleted: [] as string[], sessions: 0 }
  const advances = [...script.advances]
  const session: LoginSession = {
    sessionId: 'login-session',
    on: () => () => undefined,
    send: async () => '',
    abort: async () => undefined,
    setModel: async () => undefined,
    disconnect: async () => void calls.push('disconnect'),
    rpc: {
      accounts: {
        login: {
          begin: async (p) => {
            calls.push(`begin:${p.method}`)
            if (script.beginGate) await script.beginGate
            return { flowId: 'flow-1', step: script.begin }
          },
          advance: async () => {
            calls.push('advance')
            const next = advances.shift()
            if (!next) return new Promise<Step>(() => undefined)
            if (next instanceof Error) throw next
            const step = typeof next === 'function' ? await next() : next
            if (step.kind === 'completed' && step.result.status === 'completed') state.signedIn = true
            return step
          },
          cancel: async (p) => void calls.push(`cancel:${p.flowId}`)
        }
      }
    }
  }
  const handle = {
    start: async () => {
      if (script.startFails) throw new Error(script.startFails)
    },
    stop: async () => [],
    ping: async () => ({}),
    getAuthStatus: async () => (state.signedIn ? { isAuthenticated: true, login: 'octo' } : { isAuthenticated: false }),
    listModels: async () => [{ id: 'auto', name: 'Auto' }],
    createLoginSession: async () => {
      state.sessions++
      return session
    },
    deleteSession: async (id: string) => void state.deleted.push(id),
    createSession: async () => Promise.reject(new Error('unused')),
    resumeSession: async () => Promise.reject(new Error('unused'))
  } as unknown as SdkClientHandle
  const host = new CopilotHost(() => handle, runtime)
  const progress: VendorProgress[] = []
  return { host, calls, state, progress, on: (p: VendorProgress) => progress.push(p) }
}

const webStep = { kind: 'open-url', url: 'https://github.com/login/oauth/authorize?client_id=abc&state=x' } as const
const codeStep = { kind: 'device-code', userCode: '5C2D-038B', verificationUri: 'https://github.com/login/device', expiresIn: 899, interval: 5 } as const
const completed = { kind: 'completed', result: { status: 'completed', login: 'octo', host: 'https://github.com' } } as const
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('signing in to Copilot', () => {
  it('opens the browser address, waits, and reports the account', async () => {
    const w = world({ begin: webStep, advances: [completed] })
    await w.host.signIn('web', w.on)
    expect(w.progress).toEqual([
      { state: 'step', step: { kind: 'open-url', url: webStep.url } },
      { state: 'done', account: 'octo' }
    ])
    expect(w.calls[0]).toBe('begin:web')
  })

  it('shows a code and the page to type it on, for the code method', async () => {
    const w = world({ begin: codeStep, advances: [{ kind: 'awaiting' }, completed] })
    await w.host.signIn('code', w.on)
    expect(w.calls[0]).toBe('begin:device-code')
    expect(w.progress[0]).toEqual({ state: 'step', step: { kind: 'device-code', url: 'https://github.com/login/device', code: '5C2D-038B', expiresIn: 899 } })
    expect(w.progress[w.progress.length - 1]).toEqual({ state: 'done', account: 'octo' })
  })

  it('does nothing more when the person is already signed in', async () => {
    const w = world({ begin: webStep, advances: [], signedIn: true })
    await w.host.signIn('web', w.on)
    expect(w.progress).toEqual([{ state: 'done', account: 'octo' }])
    expect(w.state.sessions).toBe(0)
  })

  it('cleans up after itself: the sign-in session is closed and deleted', async () => {
    const w = world({ begin: webStep, advances: [completed] })
    await w.host.signIn('web', w.on)
    expect(w.calls).toContain('disconnect')
    expect(w.state.deleted).toEqual(['login-session'])
  })

  it('refreshes the model list after signing in', async () => {
    const w = world({ begin: webStep, advances: [completed] })
    w.host.forgetModels = () => void w.calls.push('forget')
    await w.host.signIn('web', w.on)
    expect(w.calls).toContain('forget')
  })

  it('reports what GitHub says went wrong', async () => {
    const w = world({ begin: webStep, advances: [{ kind: 'error', message: 'The code expired.' }] })
    await w.host.signIn('web', w.on)
    expect(w.progress[w.progress.length - 1]).toEqual({ state: 'failed', message: 'The code expired.' })
  })

  it('explains a sign-in that cannot be kept safely', async () => {
    const w = world({ begin: webStep, advances: [{ kind: 'completed', result: { status: 'needs-plaintext-consent' } }] })
    await w.host.signIn('web', w.on)
    expect(w.progress[w.progress.length - 1]).toMatchObject({ state: 'failed', message: expect.stringContaining('nowhere safe') })
  })

  it('reports a declined sign-in', async () => {
    const w = world({ begin: webStep, advances: [{ kind: 'completed', result: { status: 'declined' } }] })
    await w.host.signIn('web', w.on)
    expect(w.progress[w.progress.length - 1]).toEqual({ state: 'failed', message: 'The sign-in was declined.' })
  })

  it('sends account kinds it cannot handle to the command line tool', async () => {
    const w = world({ begin: { kind: 'input-required', prompt: 'Which host?' }, advances: [] })
    await w.host.signIn('web', w.on)
    expect(w.progress).toEqual([{ state: 'failed', message: expect.stringContaining('command line tool') }])
  })

  it('does not open an address that is not GitHub', async () => {
    for (const url of ['https://evil.example/login', 'http://github.com/login', 'javascript:alert(1)', 'https://github.com.evil.example/x', 'not a url']) {
      const w = world({ begin: { kind: 'open-url', url }, advances: [] })
      await w.host.signIn('web', w.on)
      expect(w.progress, url).toEqual([{ state: 'failed', message: expect.stringContaining('does not recognise') }])
    }
  })

  it('reports a runtime that will not start', async () => {
    const w = world({ begin: webStep, advances: [], startFails: 'spawn ENOENT' })
    await w.host.signIn('web', w.on)
    expect(w.progress).toEqual([{ state: 'failed', message: 'spawn ENOENT' }])
  })

  it('stops waiting when cancelled, tells GitHub\'s side, and reports nothing more', async () => {
    let release: (s: Step) => void = () => undefined
    const w = world({ begin: webStep, advances: [() => new Promise<Step>((r) => (release = r))] })
    const done = w.host.signIn('web', w.on)
    await sleep(20)
    await w.host.cancelSignIn()
    release(completed)
    await done
    expect(w.calls).toContain('cancel:flow-1')
    expect(w.state.deleted).toEqual(['login-session'])
    expect(w.progress).toEqual([{ state: 'step', step: { kind: 'open-url', url: webStep.url } }])
  })

  it('ends a flow that GitHub was still starting when the person cancelled, and shows nothing', async () => {
    let release: () => void = () => undefined
    const w = world({ begin: webStep, advances: [], beginGate: new Promise<void>((r) => (release = r)) })
    const done = w.host.signIn('web', w.on)
    await sleep(20)
    await w.host.cancelSignIn()
    release()
    await done
    expect(w.progress).toEqual([])
    expect(w.calls).toContain('cancel:flow-1')
    expect(w.state.deleted).toEqual(['login-session'])
  })

  it('deletes the sign-in session when the flow could not be started', async () => {
    const w = world({ begin: webStep, advances: [], beginGate: Promise.reject(new Error('GitHub could not be reached.')) })
    await w.host.signIn('web', w.on)
    expect(w.progress).toEqual([{ state: 'failed', message: 'GitHub could not be reached.' }])
    expect(w.state.deleted).toEqual(['login-session'])
  })

  it('starts a new attempt over an old one', async () => {
    const w = world({ begin: webStep, advances: [() => new Promise<Step>(() => undefined), completed] })
    const first = w.host.signIn('web', w.on)
    await sleep(20)
    await w.host.signIn('web', w.on)
    await first
    expect(w.progress[w.progress.length - 1]).toEqual({ state: 'done', account: 'octo' })
    expect(w.calls.filter((c) => c.startsWith('begin'))).toHaveLength(2)
  })
})

describe('getting the program first', () => {
  function source() {
    const state = { have: false, fraction: [] as number[], aborted: false }
    const runtime: RuntimeSource = {
      find: () => (state.have ? 'C:/runtime/copilot-runtime.exe' : undefined),
      download: async (onProgress, signal) => {
        signal.addEventListener('abort', () => (state.aborted = true))
        for (const f of [0.2, 0.7, 1]) {
          onProgress(f)
          state.fraction.push(f)
        }
        state.have = true
        return 'C:/runtime/copilot-runtime.exe'
      }
    }
    return { runtime, state }
  }

  it('downloads the program, then signs in', async () => {
    const { runtime } = source()
    const w = world({ begin: webStep, advances: [completed] }, runtime)
    await w.host.signIn('web', w.on)
    expect(w.progress.map((p) => p.state)).toEqual(['downloading', 'downloading', 'downloading', 'downloading', 'step', 'done'])
    expect(w.progress[0]).toEqual({ state: 'downloading', progress: 0 })
  })

  it('reports a download that failed', async () => {
    const runtime: RuntimeSource = { find: () => undefined, download: async () => Promise.reject(new Error('No connection to the registry.')) }
    const w = world({ begin: webStep, advances: [] }, runtime)
    await w.host.signIn('web', w.on)
    expect(w.progress[w.progress.length - 1]).toEqual({ state: 'failed', message: 'No connection to the registry.' })
  })

  it('stops a download when cancelled', async () => {
    let signal!: AbortSignal
    const runtime: RuntimeSource = {
      find: () => undefined,
      download: (_p, s) =>
        new Promise((_, reject) => {
          signal = s
          s.addEventListener('abort', () => reject(new Error('Cancelled.')))
        })
    }
    const w = world({ begin: webStep, advances: [] }, runtime)
    const done = w.host.signIn('web', w.on)
    await sleep(20)
    await w.host.cancelSignIn()
    await done
    expect(signal.aborted).toBe(true)
    expect(w.progress.every((p) => p.state === 'downloading')).toBe(true)
  })

  it('says the program is missing, instead of failing, when only asked for its status', async () => {
    const { runtime } = source()
    const w = world({ begin: webStep, advances: [] }, runtime)
    expect(await w.host.status()).toEqual({ state: 'runtime-missing' })
    await expect(w.host.ready()).rejects.toBeInstanceOf(RuntimeMissingError)
  })

  it('starts the program from where it was found', async () => {
    const { runtime, state } = source()
    state.have = true
    let given: string | undefined
    const host = new CopilotHost((path) => {
      given = path
      return world({ begin: webStep, advances: [], signedIn: true }).host as never
    }, runtime)
    await host.status().catch(() => undefined)
    expect(given).toBe('C:/runtime/copilot-runtime.exe')
  })
})

describe('the vendor service', () => {
  const make = () => {
    const w = world({ begin: webStep, advances: [completed] })
    const pushes: unknown[] = []
    return { w, pushes, service: new VendorService(w.host, (p) => pushes.push(p)) }
  }

  it('answers for Copilot and says the others are not built yet', async () => {
    const { service } = make()
    expect(await service.api['vendor.status']('copilot')).toEqual({ state: 'signed-out' })
    for (const id of ['claude', 'openai', 'gemini'] as const) {
      expect(await service.api['vendor.status'](id)).toEqual({ state: 'unsupported' })
      expect(await service.api['vendor.models'](id)).toEqual([])
      await expect(service.api['vendor.signIn'](id, 'web')).rejects.toThrow(/cannot connect/)
    }
  })

  it('answers at once and reports the sign-in as it happens', async () => {
    const { service, pushes } = make()
    await service.api['vendor.signIn']('copilot', 'web')
    await sleep(30)
    expect(pushes).toEqual([
      { type: 'vendor', vendor: 'copilot', progress: { state: 'step', step: { kind: 'open-url', url: webStep.url } } },
      { type: 'vendor', vendor: 'copilot', progress: { state: 'done', account: 'octo' } }
    ])
  })

  it('refuses nonsense from the window', async () => {
    const { service } = make()
    await expect(service.api['vendor.status']('nope' as never)).rejects.toThrow(/Invalid vendor/)
    await expect(service.api['vendor.signIn']('copilot', 'carrier-pigeon' as never)).rejects.toThrow(/Invalid sign-in/)
  })

  it('lists no models rather than failing when Copilot is not ready', async () => {
    const { service } = make()
    expect(await service.api['vendor.models']('copilot')).toEqual([])
  })
})
