import type { ModelInfo, VendorId } from '@shared/agent'
import type { CorePush, VendorConnection, VendorLinkApi, VendorProgram } from '@shared/api'
import type { OwnPrograms } from './adapters/own-copy'
import type { ClaudeHost } from './adapters/claude'
import type { CopilotHost } from './adapters/copilot'

const VENDORS: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']

/**
 * Connecting vendors and listing their models. Copilot and Claude are real so far; the others answer "unsupported"
 * and the window offers them as coming soon until their adapters arrive.
 */
export class VendorService {
  constructor(
    private readonly hosts: { copilot: CopilotHost; claude: ClaudeHost },
    private readonly push: (p: CorePush) => void,
    /** The programs the person already has. Looked at again before a connection starts, since one may have been installed since. */
    private readonly own?: OwnPrograms
  ) {}

  private id(value: unknown): VendorId {
    if (typeof value !== 'string' || !VENDORS.includes(value as VendorId)) throw new Error('Invalid vendor')
    return value as VendorId
  }

  private real(id: VendorId): 'copilot' | 'claude' | undefined {
    return id === 'copilot' || id === 'claude' ? id : undefined
  }

  readonly api: VendorLinkApi = {
    'vendor.status': async (id): Promise<VendorConnection> => {
      const real = this.real(this.id(id))
      if (real) await this.own?.refresh()
      return real ? this.hosts[real].status() : { state: 'unsupported' }
    },

    'vendor.signIn': async (id, method) => {
      const real = this.real(this.id(id))
      if (!real) throw new Error('Celeste cannot connect that vendor yet.')
      if (method !== 'web' && method !== 'code') throw new Error('Invalid sign-in method')
      await this.own?.refresh()
      const report = (progress: Parameters<Parameters<CopilotHost['signIn']>[1]>[0]) => this.push({ type: 'vendor', vendor: real, progress })
      // It runs on its own and reports through pushes: signing in takes as long as the person does.
      if (real === 'copilot') void this.hosts.copilot.signIn(method, report)
      else {
        if (method !== 'web') throw new Error('Claude signs in through the browser.')
        // Claude's program may have to be downloaded first, which takes a while, so this too reports through pushes.
        void this.hosts.claude.signIn(report).catch((err: unknown) => report({ state: 'failed', message: err instanceof Error ? err.message : String(err) }))
      }
    },

    'vendor.prepare': async (id) => {
      const real = this.real(this.id(id))
      if (!real) throw new Error('Celeste cannot connect that vendor yet.')
      await this.own?.refresh()
      // Copilot's program is fetched as part of its sign-in, and nothing else of it is needed first.
      if (real === 'copilot') return true
      return this.hosts.claude.prepare((progress) => this.push({ type: 'vendor', vendor: real, progress }))
    },

    'vendor.program': async (id): Promise<VendorProgram> => {
      const real = this.real(this.id(id))
      if (!real || !this.own) return { using: 'none', allowed: true }
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

    'vendor.models': async (id): Promise<ModelInfo[]> => {
      const real = this.real(this.id(id))
      if (!real) return []
      // Not being ready is not an error here: the window shows the vendor's own state, and an empty list says "nothing to offer yet".
      return this.hosts[real].models().catch(() => [])
    }
  }
}
