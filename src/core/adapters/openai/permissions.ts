import type { ApprovalMode, Question } from '@shared/agent'
import type { ResolvedMcpServer } from '../../mcp'
import { toml } from './host'

/** The name Celeste's own tool server goes by in Codex's list. Its commands ask for approval themselves. */
export const DEVICE_SERVER = 'celeste-devices'

/**
 * What Codex is told for an approval mode. The modes mean what the approval picker says they mean, and Celeste answers the
 * questions Codex raises. Codex's own checks stay in force beneath that:
 *  - auto: never asks, nothing is sandboxed.
 *  - edits and ask: Codex asks about everything except commands it knows only look. Celeste answers: edits lets file changes
 *    through and asks about the rest, ask asks about everything.
 *  - plan: nothing may change and the sandbox is read-only, so what Codex asks about is declined.
 */
export function policyFor(mode: ApprovalMode): { approvalPolicy: 'never' | 'untrusted'; sandboxPolicy: { type: 'dangerFullAccess' } | { type: 'readOnly'; networkAccess: boolean } } {
  if (mode === 'auto') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
  if (mode === 'plan') return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'dangerFullAccess' } }
}

export type Decision = 'allow' | 'ask' | 'deny'

/** What to do when Codex asks to run a command, change files, or use a tool of an outside server. */
export function decide(what: 'command' | 'files' | 'tool' | 'permissions', mode: ApprovalMode): Decision {
  if (mode === 'plan') return 'deny'
  if (mode === 'auto') return 'allow'
  if (mode === 'edits' && what === 'files') return 'allow'
  return 'ask'
}

const bare = /^[A-Za-z0-9_-]+$/

/**
 * Codex's `-c` settings for the tools (MCP servers) the person added and for Celeste's own device server. The device server is
 * named first so a tool of the person's cannot take its name.
 */
export function mcpConfig(servers: ResolvedMcpServer[], device?: { url: string; token: string }): string[] {
  const out: string[] = []
  const table = (pairs: Record<string, string>) => `{${Object.entries(pairs).map(([k, v]) => `${toml(k)}=${toml(v)}`).join(', ')}}`
  const add = (key: string, s: Omit<ResolvedMcpServer, 'key'>) => {
    const at = `mcp_servers.${bare.test(key) ? key : toml(key)}`
    if (s.type === 'http' && s.url) {
      out.push(`${at}.url=${toml(s.url)}`)
      if (Object.keys(s.headers).length) out.push(`${at}.http_headers=${table(s.headers)}`)
    } else if (s.type === 'stdio' && s.command) {
      out.push(`${at}.command=${toml(s.command)}`)
      if (s.args.length) out.push(`${at}.args=[${s.args.map(toml).join(', ')}]`)
      if (Object.keys(s.env).length) out.push(`${at}.env=${table(s.env)}`)
    } else return
    // Celeste's tools can wait for the person (a card on the phone, a device command to approve), longer than the minute Codex gives one.
    out.push(`${at}.tool_timeout_sec=600`)
  }
  if (device) add(DEVICE_SERVER, { type: 'http', url: device.url, headers: { Authorization: `Bearer ${device.token}` }, args: [], env: {} })
  for (const s of servers) if (s.key !== DEVICE_SERVER) add(s.key, s)
  return out
}

/** The question card for a question Codex asks, and where its answers go. */
export function questionsFrom(params: Record<string, unknown>): { questions: Question[]; ids: string[] } {
  const raw = Array.isArray(params['questions']) ? (params['questions'] as Record<string, unknown>[]) : []
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    ids: raw.map((q, i) => text(q['id']) ?? `q${i}`),
    questions: raw.map((q, i) => ({
      header: text(q['header']) ?? `Question ${i + 1}`,
      question: text(q['question']) ?? '',
      multiSelect: false,
      options: (Array.isArray(q['options']) ? (q['options'] as Record<string, unknown>[]) : []).map((o) => ({
        label: text(o['label']) ?? '',
        ...(text(o['description']) ? { description: text(o['description']) } : {})
      }))
    }))
  }
}
