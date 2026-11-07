import type { ApprovalMode, Question, ToolKind } from '@shared/agent'
import { TOOLS } from '../../devices/tools'
import { displayPath } from '../copilot/diff'

/** The name Celeste's own tool server goes by in Claude's MCP list. Its commands ask for approval themselves. */
export const DEVICE_SERVER = 'celeste-devices'
const DEVICE_PREFIX = `mcp__${DEVICE_SERVER}__`

export type Decision = 'allow' | 'ask' | 'deny'

const KIND: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  NotebookEdit: 'edit',
  Bash: 'shell',
  PowerShell: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  KillBash: 'shell',
  Monitor: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent'
}

/** Tools that are plumbing, or that Celeste shows another way (the question card for `AskUserQuestion`). */
export const HIDDEN_TOOLS = new Set(['AskUserQuestion', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode'])

export function toolKind(toolName: string): ToolKind {
  if (toolName.startsWith('mcp__')) return 'mcp'
  return KIND[toolName] ?? 'other'
}

const isDeviceTool = (toolName: string) => toolName.startsWith(DEVICE_PREFIX)

/** Whether a device tool only looks. Plan mode allows exactly these. */
function deviceToolReads(toolName: string): boolean {
  const def = (TOOLS as Record<string, { needs: string } | undefined>)[toolName.slice(DEVICE_PREFIX.length)]
  return def?.needs === 'any'
}

/**
 * What to do with a tool call, given the session's approval mode. The modes mean what the scripted assistant taught
 * the screens they mean: auto never asks, edits asks for commands and other tools, ask asks for everything but
 * looking, plan allows only what leaves things as they are.
 */
export function decide(toolName: string, mode: ApprovalMode): Decision {
  const kind = toolKind(toolName)
  const looks = kind === 'read' || kind === 'search'
  if (mode === 'plan') {
    if (looks) return 'allow'
    return isDeviceTool(toolName) && deviceToolReads(toolName) ? 'allow' : 'deny'
  }
  // A device command has its own card with the device's name on it. Asking here as well would be two questions for one command.
  if (isDeviceTool(toolName)) return 'allow'
  if (mode === 'auto' || looks) return 'allow'
  if (mode === 'edits' && (kind === 'edit' || kind === 'write')) return 'allow'
  return 'ask'
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** The question as the approval card shows it. */
export function describe(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
  said: { title?: string; description?: string } = {}
): { kind: ToolKind; title: string; detail?: string } {
  const kind = toolKind(toolName)
  const path = text(input['file_path']) ?? text(input['notebook_path'])
  switch (kind) {
    case 'shell':
      return { kind, title: text(input['description']) ?? 'Run a command', detail: text(input['command']) }
    case 'edit':
    case 'write':
      return { kind, title: said.title ?? (kind === 'write' ? 'Write a file' : 'Change a file'), detail: path ? displayPath(path, cwd) : undefined }
    case 'web':
      return { kind, title: said.title ?? (toolName === 'WebSearch' ? 'Search the web' : 'Open a web address'), detail: text(input['url']) ?? text(input['query']) }
    case 'mcp':
      return { kind, title: said.title ?? toolName.replace(/^mcp__/, '').replace('__', ': '), detail: JSON.stringify(input, null, 2) }
    default:
      return { kind, title: said.title ?? `Allow ${toolName}`, ...(said.description ? { detail: said.description } : {}) }
  }
}

/** The questions of an `AskUserQuestion` call, in the shape the question card shows. */
export function questionsFrom(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input['questions']) ? (input['questions'] as Record<string, unknown>[]) : []
  return raw.map((q, i) => ({
    header: text(q['header']) ?? `Question ${i + 1}`,
    question: text(q['question']) ?? '',
    multiSelect: q['multiSelect'] === true,
    options: (Array.isArray(q['options']) ? (q['options'] as Record<string, unknown>[]) : []).map((o) => ({
      label: text(o['label']) ?? '',
      ...(text(o['description']) ? { description: text(o['description']) } : {})
    }))
  }))
}
