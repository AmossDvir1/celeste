import type { ModelInfo, VendorId } from '@shared/agent'
import type { CorePush, VendorConnection, VendorLinkApi } from '@shared/api'
import type { CopilotHost } from './adapters/copilot'

const VENDORS: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']

/**
 * Connecting vendors and listing their models. Copilot is the only real one so far; the others answer
 * "unsupported" and the window keeps playing its scripted connection for them until Phase 5.
 */
export class VendorService {
  constructor(
    private readonly copilot: CopilotHost,
    private readonly push: (p: CorePush) => void,
    /** Every vendor answers "unsupported", so the window plays its scripted connection. For app checks without accounts. */
    private readonly scripted = false
  ) {}

  private id(value: unknown): VendorId {
    if (typeof value !== 'string' || !VENDORS.includes(value as VendorId)) throw new Error('Invalid vendor')
    return value as VendorId
  }

  readonly api: VendorLinkApi = {
    'vendor.status': async (id): Promise<VendorConnection> => (this.id(id) === 'copilot' && !this.scripted ? this.copilot.status() : { state: 'unsupported' }),

    'vendor.signIn': async (id, method) => {
      if (this.id(id) !== 'copilot' || this.scripted) throw new Error('Celeste cannot connect that vendor yet.')
      if (method !== 'web' && method !== 'code') throw new Error('Invalid sign-in method')
      // It runs on its own and reports through pushes: signing in takes as long as the person does.
      void this.copilot.signIn(method, (progress) => this.push({ type: 'vendor', vendor: 'copilot', progress }))
    },

    'vendor.cancelSignIn': async (id) => {
      if (this.id(id) === 'copilot') await this.copilot.cancelSignIn()
    },

    'vendor.models': async (id): Promise<ModelInfo[]> => {
      if (this.id(id) !== 'copilot' || this.scripted) return []
      // Not being ready is not an error here: the window shows the vendor's own state, and an empty list says "nothing to offer yet".
      return this.copilot.models().catch(() => [])
    }
  }
}
