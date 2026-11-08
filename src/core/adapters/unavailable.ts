import type { AgentEvent, AgentSession, VendorId } from '@shared/agent'
import { EventQueue } from './event-queue'

const NAMES: Record<VendorId, string> = { copilot: 'GitHub Copilot', claude: 'Claude', openai: 'OpenAI', gemini: 'Google Gemini' }

/**
 * The session of a vendor Celeste cannot talk to yet. Every message ends at once with a plain reason, so nothing waits
 * on an answer that will never come. The window does not offer these vendors, so this is for a session that somehow has one.
 */
export function createUnavailableSession(vendor: VendorId): AgentSession {
  const events = new EventQueue<AgentEvent>()
  let turn = 0
  return {
    vendorSessionId: '',
    events,
    send: () => {
      const turnId = `turn-unavailable-${++turn}`
      events.push({ type: 'turn.started', turnId })
      events.push({ type: 'turn.failed', turnId, error: { code: 'unknown', message: `Celeste cannot talk to ${NAMES[vendor]} yet.`, retryable: false } })
    },
    respond: () => undefined,
    setModel: async () => undefined,
    setApprovalMode: async () => undefined,
    interrupt: async () => undefined,
    close: async () => events.close()
  }
}
