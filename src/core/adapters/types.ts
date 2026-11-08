import type { AgentSession, ApprovalMode, Effort, SessionMode, VendorId } from '@shared/agent'

/** What Core hands an adapter when it starts the agent for a session. */
export interface AdapterContext {
  sessionId: string
  vendor: VendorId
  mode: SessionMode
  /** What the session is set to right now. Read at each message, so a change in the window applies to the next one. */
  options: () => { model: string; effort: Effort | null; approval: ApprovalMode; cwd?: string }
  getApproval: () => ApprovalMode
  /** The vendor's id from the last time this session ran, when it has run before. */
  vendorSessionId?: string
  /** Called with the vendor's id once there is one, so the next message can resume it. */
  remember: (vendorSessionId: string) => void
  /** The conversation so far as plain text. Used to seed a new vendor session when the old one is gone. */
  transcript: () => string
  /** Where an attachment's file is on disk, when the app keeps them on disk. */
  attachmentPath: (id: string) => string | undefined
}

export type AdapterFactory = (ctx: AdapterContext) => AgentSession
