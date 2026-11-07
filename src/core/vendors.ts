import type { ModelInfo, VendorId } from '@shared/agent'
import type { CorePush, VendorConnection, VendorLinkApi } from '@shared/api'
import type { ClaudeHost } from './adapters/claude'
import type { CopilotHost } from './adapters/copilot'

const VENDORS: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']

/**
 * Connecting vendors and listing their models. Copilot and Claude are real so far; the others answer "unsupported"
 * and the window keeps playing its scripted connection for them until their adapters arrive.
 */
export class VendorService {
  constructor(
    private readonly hosts: { copilot: CopilotHost; claude: ClaudeHost },
    private readonly push: (p: CorePush) => void,
    /** Every vendor answers "unsupported", so the window plays its scripted connection. For app checks without accounts. */
    private readonly scripted = false
  ) {}

  private id(value: unknown): VendorId {
    if (typeof value !== 'string' || !VENDORS.includes(value as VendorId)) throw new Error('Invalid vendor')
    return value as VendorId
  }

  private real(id: VendorId): 'copilot' | 'claude' | undefined {
    return !this.scripted && (id === 'copilot' || id === 'claude') ? id : undefined
  }

  readonly api: VendorLinkApi = {
    'vendor.status': async (id): Promise<VendorConnection> => {
      const real = this.real(this.id(id))
      return real ? this.hosts[real].status() : { state: 'unsupported' }
    },

    'vendor.signIn': async (id, method) => {
      const real = this.real(this.id(id))
      if (!real) throw new Error('Celeste cannot connect that vendor yet.')
      if (method !== 'web' && method !== 'code') throw new Error('Invalid sign-in method')
      const report = (progress: Parameters<Parameters<CopilotHost['signIn']>[1]>[0]) => this.push({ type: 'vendor', vendor: real, progress })
      // It runs on its own and reports through pushes: signing in takes as long as the person does.
      if (real === 'copilot') void this.hosts.copilot.signIn(method, report)
      else {
        if (method !== 'web') throw new Error('Claude signs in through the browser.')
        await this.hosts.claude.signIn(report)
      }
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
