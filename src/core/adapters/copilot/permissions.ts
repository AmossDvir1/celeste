import type { ApprovalMode, ToolKind } from '@shared/agent'
import { displayPath } from './diff'

/** The name Celeste's own tool server goes by in Copilot's MCP list. Its commands ask for approval themselves. */
export const DEVICE_SERVER = 'celeste-devices'

/** The parts of a Copilot permission request that matter here. Anything else is treated as "ask". */
export interface PermissionLike {
  kind: string
  intention?: string
  path?: string
  fileName?: string
  fullCommandText?: string
  url?: string
  serverName?: string
  toolName?: string
  toolTitle?: string
  args?: unknown
  readOnly?: boolean
}

export type Decision = 'allow' | 'ask' | 'deny'

const READ_KINDS = new Set(['read'])
const WRITE_KINDS = new Set(['write'])

/**
 * What to do with a request, given the session's approval mode. The modes mean what the approval picker
 * says they mean: auto never asks, edits asks for commands and other tools, ask asks for
 * everything but reading, plan allows only what leaves things as they are.
 */
export function decide(request: PermissionLike, mode: ApprovalMode): Decision {
  const reads = READ_KINDS.has(request.kind)
  const isDevice = request.kind === 'mcp' && request.serverName === DEVICE_SERVER
  if (mode === 'plan') {
    if (reads) return 'allow'
    if (request.kind === 'mcp' && request.readOnly === true) return 'allow'
    return 'deny'
  }
  // A device command has its own card with the device's name on it. Asking here as well would be two questions for one command.
  if (isDevice) return 'allow'
  if (mode === 'auto' || reads) return 'allow'
  if (mode === 'edits' && WRITE_KINDS.has(request.kind)) return 'allow'
  return 'ask'
}

const KIND: Record<string, ToolKind> = { read: 'read', write: 'edit', shell: 'shell', url: 'web', mcp: 'mcp' }

/** The question as the approval card shows it. */
export function describe(request: PermissionLike, cwd?: string): { kind: ToolKind; title: string; detail?: string } {
  const kind = KIND[request.kind] ?? 'other'
  switch (request.kind) {
    case 'shell':
      return { kind, title: request.intention || 'Run a command', detail: request.fullCommandText }
    case 'write': {
      const path = request.fileName ? displayPath(request.fileName, cwd) : undefined
      return { kind, title: request.intention || 'Change a file', detail: path }
    }
    case 'read':
      return { kind, title: request.intention || 'Read a file', detail: request.path ? displayPath(request.path, cwd) : undefined }
    case 'url':
      return { kind, title: request.intention || 'Open a web address', detail: request.url }
    case 'mcp':
      return {
        kind,
        title: request.toolTitle || `${request.serverName}: ${request.toolName}`,
        detail: request.args === undefined ? undefined : JSON.stringify(request.args, null, 2)
      }
    default:
      return { kind, title: request.intention || `Allow ${request.kind}` }
  }
}
