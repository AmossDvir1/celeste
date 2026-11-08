import type { AgentEvent, VendorId } from '@shared/agent'
import type { AdapterContext, AdapterFactory } from '../adapters/types'
import type { AgentStepRunner } from './runner'

/**
 * An agent step is one question to a vendor's agent, asked the way a chat asks it, with the same adapters, so it has the same tools
 * (including the ones the person added) and the same approvals. It runs in a session of its own that is not shown in the list. What
 * the agent says during the one turn is the step's result. When it wants to use a tool or asks the person something, the run asks,
 * and waits.
 */
export function createAgentStepRunner(deps: {
  adapter: AdapterFactory
  /** Used when a step names neither vendor nor model: the first vendor that is ready, and a model of its own choosing. */
  defaults: () => Promise<{ vendor: VendorId; model: string }>
}): AgentStepRunner {
  return {
    async run(req) {
      const fallback = !req.vendor || !req.model ? await deps.defaults() : undefined
      const vendor: VendorId = req.vendor ?? (req.model ? (req.model.startsWith('claude:') ? 'claude' : 'copilot') : (fallback as { vendor: VendorId }).vendor)
      const model = req.model ?? (fallback?.vendor === vendor ? fallback.model : (await deps.defaults()).model)
      const ctx: AdapterContext = {
        sessionId: `wf-${crypto.randomUUID()}`,
        vendor,
        mode: 'chat',
        options: () => ({ model, effort: req.effort ?? null, approval: req.approval, cwd: req.cwd }),
        getApproval: () => req.approval,
        remember: () => undefined,
        transcript: () => '',
        attachmentPath: () => undefined
      }
      const session = deps.adapter(ctx)
      const stop = () => void session.interrupt().catch(() => undefined)
      req.signal.addEventListener('abort', stop, { once: true })
      try {
        session.send({ text: req.prompt, attachments: [] })
        let text = ''
        for await (const event of session.events as AsyncIterable<AgentEvent>) {
          if (req.signal.aborted) throw new Error('Stopped.')
          switch (event.type) {
            case 'message.delta':
              text += event.text
              break
            case 'approval.requested': {
              const allow = await req.askApproval(event.title, event.detail)
              session.respond(event.requestId, { allow })
              break
            }
            case 'ask_user.requested':
              session.respond(event.requestId, await req.askQuestions(event.questions))
              break
            case 'turn.completed':
              return text
            case 'turn.interrupted':
              throw new Error('Stopped.')
            case 'turn.failed':
              throw new Error(event.error.message)
          }
        }
        throw new Error('The assistant stopped without answering.')
      } finally {
        req.signal.removeEventListener('abort', stop)
        await session.close().catch(() => undefined)
      }
    }
  }
}
