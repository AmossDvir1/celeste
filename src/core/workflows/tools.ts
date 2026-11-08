import { z } from 'zod'
import { checkInputs, slugify, type InputDef, type StartNode } from '@shared/workflow'
import type { Store, WorkflowRow } from '../store'
import type { WorkflowRunner } from './runner'

/*
 * The workflows an assistant may start, as tools on Celeste's own tool server, so any vendor's agent can say "run test-app, then
 * summarize the failures". Only a workflow the person switched "Allow the assistant to run this" on for is listed or started. A run the
 * assistant starts always shows the card that asks first, even when there is little on it, and ends with what it produced.
 */

export interface ExtraTool {
  name: string
  title: string
  description: string
  shape: z.ZodRawShape
  /** True for a tool that changes nothing, which an agent in plan mode may use. */
  readOnly: boolean
}

export interface ExtraTools {
  list(): ExtraTool[]
  call(sessionId: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }>
}

const MAX_WAIT_MS = 30 * 60_000

const inputsOf = (w: WorkflowRow): InputDef[] => {
  const start = w.definition.nodes.find((n): n is StartNode => n.type === 'start')
  return start?.inputs ?? []
}

const describeInput = (i: InputDef): string =>
  `${i.name} (${i.type === 'choice' ? `one of ${(i.options ?? []).join(', ')}` : i.type}${i.required ? ', required' : ''}${i.default !== undefined ? `, default ${String(i.default)}` : ''})`

export class WorkflowTools implements ExtraTools {
  constructor(
    private readonly store: Store,
    private readonly runner: WorkflowRunner,
    /** Where a conversation works. */
    private readonly folderOf: (sessionId: string) => string,
    private readonly maxWaitMs: number = MAX_WAIT_MS
  ) {}

  private allowed(): WorkflowRow[] {
    return this.store.listWorkflows().filter((w) => w.allowAssistant)
  }

  list(): ExtraTool[] {
    return [
      {
        name: 'workflows_list',
        title: 'List the workflows you may run',
        description: 'Lists the workflows the user has allowed you to run, with what each does and the inputs it takes. Use workflow_run to start one.',
        shape: {},
        readOnly: true
      },
      {
        name: 'workflow_run',
        title: 'Run a workflow',
        description:
          'Runs one of the user’s workflows (see workflows_list) in this conversation and waits for it to finish. The user is shown everything it will do and must allow it first, so it may take a while. Returns what the workflow produced.',
        shape: {
          name: z.string().min(1).describe('The workflow’s name, or its short name as in /short-name'),
          inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Answers to the workflow’s inputs, by name')
        },
        readOnly: false
      }
    ]
  }

  async call(sessionId: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    if (name === 'workflows_list') {
      const found = this.allowed()
      if (found.length === 0) return { text: 'There is no workflow you may run. The user can allow one in that workflow’s menu, with “Allow the assistant to run this”.', isError: false }
      return {
        text: found
          .map((w) => {
            const inputs = inputsOf(w)
            return `- ${w.name} (/${slugify(w.name)}): ${w.description || 'no description'}. ${inputs.length ? `Inputs: ${inputs.map(describeInput).join('; ')}.` : 'It takes no inputs.'}`
          })
          .join('\n'),
        isError: false
      }
    }
    if (name !== 'workflow_run') return { text: `There is no tool called ${name}.`, isError: true }

    const parsed = z.object({ name: z.string().min(1), inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }).safeParse(args ?? {})
    if (!parsed.success) return { text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`, isError: true }
    const wanted = parsed.data.name.trim().toLowerCase().replace(/^\//, '')
    const all = this.store.listWorkflows()
    const found = all.find((w) => w.name.toLowerCase() === wanted || slugify(w.name) === wanted)
    if (!found) return { text: `There is no workflow called “${parsed.data.name}”. Use workflows_list to see which you may run.`, isError: true }
    if (!found.allowAssistant) return { text: `“${found.name}” is not one you may run. The user can allow it in the workflow’s menu, with “Allow the assistant to run this”.`, isError: true }
    try {
      checkInputs(inputsOf(found), parsed.data.inputs ?? {})
    } catch (err) {
      return { text: err instanceof Error ? err.message : 'The inputs are not right.', isError: true }
    }

    let run
    try {
      run = await this.runner.start({ workflowId: found.id, inputs: parsed.data.inputs ?? {}, startedBy: 'assistant', folder: this.folderOf(sessionId), sessionId, forceApproval: true })
    } catch (err) {
      return { text: err instanceof Error ? err.message : 'It could not be started.', isError: true }
    }
    const ended = await this.runner.whenFinished(run.id, this.maxWaitMs)
    if (!ended) return { text: `“${found.name}” is still running after a long time. The user can see it in this conversation; ask them how it went.`, isError: false }
    if (ended.status === 'completed') return { text: ended.output?.trim() || '(The workflow finished and produced nothing.)', isError: false }
    if (ended.status === 'cancelled') return { text: 'The user did not allow the run, or stopped it, so nothing more happened. Do not try again unless they ask.', isError: true }
    return { text: `The workflow failed: ${ended.error ?? 'it did not say why'}`, isError: true }
  }
}
