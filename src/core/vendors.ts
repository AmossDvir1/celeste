import type { ModelInfo, VendorId } from '@shared/agent'
import type { CorePush, VendorConnection, VendorLinkApi, VendorProgram } from '@shared/api'
import type { OwnPrograms } from './adapters/own-copy'
import type { ClaudeHost } from './adapters/claude'
import type { CopilotHost } from './adapters/copilot'
import type { OpenAiHost } from './adapters/openai'

const VENDORS: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']

type Real = 'copilot' | 'claude' | 'openai'

/**
 * Connecting vendors and listing their models. Copilot, Claude and OpenAI are real so far; the others answer "unsupported"
 * and the window offers them as coming soon until their adapters arrive.
 */
export class VendorService {
  constructor(
    private readonly hosts: { copilot: CopilotHost; claude: ClaudeHost; openai: OpenAiHost },
    private readonly push: (p: CorePush) => void,
    /** The programs the person already has. Looked at again before a connection starts, since one may have been installed since. */
    private readonly own?: OwnPrograms
  ) {}

  private id(value: unknown): VendorId {
    if (typeof value !== 'string' || !VENDORS.includes(value as VendorId)) throw new Error('Invalid vendor')
    return value as VendorId
  }

  private real(id: VendorId): Real | undefined {
    return id === 'copilot' || id === 'claude' || id === 'openai' ? id : undefined
  }

  readonly api: VendorLinkApi = {
    'vendor.status': async (id): Promise<VendorConnection> => {
      const real = this.real(this.id(id))
      if (real && real !== 'openai') await this.own?.refresh()
      return real ? this.hosts[real].status() : { state: 'unsupported' }
    },

    'vendor.signIn': async (id, method) => {
      const real = this.real(this.id(id))
      if (!real) throw new Error('Celeste cannot connect that vendor yet.')
      if (method !== 'web' && method !== 'code') throw new Error('Invalid sign-in method')
      if (real !== 'openai') await this.own?.refresh()
      const report = (progress: Parameters<Parameters<CopilotHost['signIn']>[1]>[0]) => this.push({ type: 'vendor', vendor: real, progress })
      // It runs on its own and reports through pushes: signing in takes as long as the person does.
      if (real === 'copilot') void this.hosts.copilot.signIn(method, report)
      else if (real === 'claude') {
        if (method !== 'web') throw new Error('Claude signs in through the browser.')
        // Claude's program may have to be downloaded first, which takes a while, so this too reports through pushes.
        void this.hosts.claude.signIn(report).catch((err: unknown) => report({ state: 'failed', message: err instanceof Error ? err.message : String(err) }))
      } else {
        if (method !== 'web') throw new Error('ChatGPT signs in through the browser.')
        void this.hosts.openai.signIn(report).catch((err: unknown) => report({ state: 'failed', message: err instanceof Error ? err.message : String(err) }))
      }
    },

    'vendor.prepare': async (id) => {
      const real = this.real(this.id(id))
      if (!real) throw new Error('Celeste cannot connect that vendor yet.')
      if (real !== 'openai') await this.own?.refresh()
      // Copilot's program is fetched as part of its sign-in, and nothing else of it is needed first.
      if (real === 'copilot') return true
      return this.hosts[real].prepare((progress) => this.push({ type: 'vendor', vendor: real, progress }))
    },

    'vendor.program': async (id): Promise<VendorProgram> => {
      const real = this.real(this.id(id))
      if (!real) return { using: 'none', allowed: true }
      // OpenAI's program is always Celeste's own copy: there is no check for one the person already has.
      if (real === 'openai') return { using: this.hosts.openai.hasProgram() ? 'celeste' : 'none', allowed: true }
      if (!this.own) return { using: 'none', allowed: true }
      await this.own.refresh()
      const info = this.own.info(real)
      if (info.enabled && info.file) return { using: 'yours', version: info.version, allowed: true }
      // Whether Celeste has a copy of its own is told by the host: it is the one that looks in the data folder.
      const have = this.hosts[real].hasProgram()
      return { using: have ? 'celeste' : 'none', ...(info.why ? { why: info.why } : {}), allowed: info.enabled }
    },

    'vendor.cancelSignIn': async (id) => {
      const real = this.real(this.id(id))
      if (real) await this.hosts[real].cancelSignIn()
    },

    'vendor.signOut': async (id) => {
      const real = this.real(this.id(id))
      // Only a ChatGPT sign-in has anything to give back: Copilot's and Claude's are theirs, and a pasted key is removed by the window.
      if (real === 'openai') return this.hosts.openai.signOut()
      return { revoked: true }
    },

    'vendor.models': async (id): Promise<ModelInfo[]> => {
      const real = this.real(this.id(id))
      if (!real) return []
      // Not being ready is not an error here: the window shows the vendor's own state, and an empty list says "nothing to offer yet".
      return this.hosts[real].models().catch(() => [])
    }
  }
}
