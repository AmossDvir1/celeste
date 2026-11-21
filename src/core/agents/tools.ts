import { z } from 'zod'
import { TASK_MAX_CHARS, TITLE_MAX_CHARS } from '@shared/subagents'
import { NOT_HERE, type Where } from '../app/tools'
import type { ExtraTool, ExtraTools, ToolResult } from '../workflows/tools'
import type { SubAgents } from './subagents'

/*
 * The assistant's tools for helpers (docs/plans/SUB_AGENTS_PLAN.md, section 6), on Celeste's own tool server, so all four vendors get them the
 * same way. Five tools, kept short: every message of every chat pays for their words. All five are `readOnly`: in plan mode a helper is
 * allowed and is itself in plan mode, so starting one changes nothing on disk.
 */

/** The words of all five tools together (names, descriptions, the arguments and what they say) stay under this many characters. */
export const TOOLS_SIZE_BUDGET = 2200

const VENDORS = ['copilot', 'claude', 'openai', 'gemini'] as const

const refuse = (text: string): ToolResult => ({ text, isError: true })

const START = {
  task: z.string().min(1).max(TASK_MAX_CHARS).describe('What to do and what to report. The helper sees only this.'),
  title: z.string().max(TITLE_MAX_CHARS).describe('Short name for the card'),
  vendor: z.enum(VENDORS).optional().describe('Default: yours'),
  model: z.string().optional().describe('From agent_list'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  approval: z.enum(['edits', 'ask', 'plan']).optional().describe('Not looser than this chat'),
  folder: z.enum(['same', 'copy']).optional().describe('copy: a separate copy of the project'),
  wait: z.boolean().optional().describe('Default true. false: runs in the background, you are told when it ends')
}
const SEND = { id: z.string(), text: z.string().min(1).max(TASK_MAX_CHARS), wait: z.boolean().optional() }
const WAIT = { ids: z.array(z.string()).optional().describe('Default: all that work'), any: z.boolean().optional().describe('true: return when the first ends') }
const STOP = { id: z.string() }

const TOOLS: ExtraTool[] = [
  {
    name: 'agent_start',
    title: 'Start a helper',
    description: 'Starts a helper: another assistant session that does a task and gives back its last message. For work apart from yours, not small jobs.',
    shape: START,
    readOnly: true
  },
  { name: 'agent_send', title: 'Give a helper more work', description: 'Gives an idle helper more work. Refused while it works.', shape: SEND, readOnly: true },
  { name: 'agent_wait', title: 'Wait for helpers', description: 'Waits for helpers to finish and returns their answers.', shape: WAIT, readOnly: true },
  { name: 'agent_stop', title: 'Stop a helper', description: 'Stops a helper, like Stop in its chat.', shape: STOP, readOnly: true },
  { name: 'agent_list', title: 'List helpers', description: 'Lists your helpers, the assistants and models a helper may use, and the limits left.', shape: {}, readOnly: true }
]

const problem = (error: z.ZodError): string => `Invalid arguments: ${error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`

/** The first words of a task, for a helper that came without a name. */
const nameFrom = (task: string): string => task.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, TITLE_MAX_CHARS)

export interface AgentToolsDeps {
  /** Nobody can answer a card in a workflow step, so helpers are not offered there. */
  where: Where
  agents: Pick<SubAgents, 'start' | 'send' | 'wait' | 'stopHelper' | 'list' | 'isHelper'>
}

export class AgentTools implements ExtraTools {
  constructor(private readonly deps: AgentToolsDeps) {}

  list(): ExtraTool[] {
    return TOOLS
  }

  async call(sessionId: string, name: string, args: unknown): Promise<ToolResult> {
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return refuse(`There is no tool called ${name}.`)
    // Before anything else: where nobody is at the computer, and in a helper itself (a helper cannot start helpers, and does not see the others).
    if (this.deps.where.step(sessionId)) return refuse(NOT_HERE)
    if (this.deps.agents.isHelper(sessionId)) return refuse('Helpers cannot start helpers.')
    const { agents } = this.deps
    switch (name) {
      case 'agent_start': {
        const parsed = z.object(START).safeParse(args ?? {})
        if (!parsed.success) return refuse(problem(parsed.error))
        const d = parsed.data
        const title = d.title.trim() || nameFrom(d.task)
        return agents.start(sessionId, {
          task: d.task,
          title,
          ...(d.vendor ? { vendor: d.vendor } : {}),
          ...(d.model ? { model: d.model } : {}),
          ...(d.effort ? { effort: d.effort } : {}),
          ...(d.approval ? { approval: d.approval } : {}),
          ...(d.folder ? { folder: d.folder } : {}),
          wait: d.wait !== false
        })
      }
      case 'agent_send': {
        const parsed = z.object(SEND).safeParse(args ?? {})
        if (!parsed.success) return refuse(problem(parsed.error))
        return agents.send(sessionId, parsed.data.id, parsed.data.text, parsed.data.wait !== false)
      }
      case 'agent_wait': {
        const parsed = z.object(WAIT).safeParse(args ?? {})
        if (!parsed.success) return refuse(problem(parsed.error))
        return agents.wait(sessionId, parsed.data.ids?.slice(0, 20), parsed.data.any === true)
      }
      case 'agent_stop': {
        const parsed = z.object(STOP).safeParse(args ?? {})
        if (!parsed.success) return refuse(problem(parsed.error))
        return agents.stopHelper(sessionId, parsed.data.id)
      }
      default:
        return agents.list(sessionId)
    }
  }
}
