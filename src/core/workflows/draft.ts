import { nodeIdFrom, validateWorkflow, type InputDef, type WorkflowDefinition, type WorkflowNode } from '@shared/workflow'
import { fromFile, toFile } from '@shared/workflow-file'

/*
 * "Build with AI" and "Make this a workflow": an assistant is asked to describe a workflow as JSON, which is checked as strictly as one
 * made by hand and, when it is not valid, sent back once with what is wrong. The person always gets a draft to look over; it is not saved
 * and nothing in it runs until they say so.
 */

export type DraftSource = { kind: 'text'; text: string } | { kind: 'conversation'; transcript: string }

export interface Drafted {
  name: string
  description: string
  definition: WorkflowDefinition
  notes: string[]
}

const GUIDE = `A workflow is a list of steps that run one after another. Describe it as ONE JSON object and nothing else (no explanation, no code fence):

{
  "name": "Short name",
  "description": "One sentence about what it does",
  "inputs": [ { "name": "older_than_days", "label": "Older than (days)", "type": "number", "default": 365, "required": false } ],
  "steps": [
    { "id": "find_old", "name": "Find old files", "do": "command", "command": "..." }
  ],
  "result": "{{nodes.last_step_id.output}}"
}

Input types: text, number, boolean, choice (a choice also has "options": ["a","b"]).

Each step has a unique "id" (lowercase letters, digits and underscores, starting with a letter), a "name", and "do", which is one of:
- "command": runs a shell command on this computer. Fields: "command", optional "cwd".
- "web": a web request. Fields: "method" (GET, POST, PUT, PATCH, DELETE), "url", optional "headers" (an object) and "body".
- "file": "op" is "read", "write" or "append"; "path" is inside the folder the workflow works in; "content" for write and append.
- "tool": a tool the user has added. Fields: "server", "tool", "args" (an object).
- "assistant": asks an AI assistant. Fields: "prompt", and "json": true when the answer must be JSON.
A step may also have "description" and "onError": "stop" (the default), "retry" or "continue".

In any text, {{inputs.name}} is an answer to an input, {{nodes.step_id.output}} is what an EARLIER step produced (add .field to read a field of JSON), and {{run.folder}} is the folder the workflow works in.
Turn anything specific that would differ next time (a number, a name, a path) into an input. Never put a password, token or key in a step: make it an input, or leave it out. Keep it as short as it can be.`

/** Turns what the assistant answered into a workflow's steps. Throws a sentence when it is not usable JSON. */
export function definitionFromSpec(spec: unknown): { name: string; description: string; definition: WorkflowDefinition } {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  if (!isObject(spec)) throw new Error('The answer was not a JSON object.')
  const steps = spec['steps']
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('The answer has no steps.')
  const inputs: InputDef[] = []
  for (const raw of Array.isArray(spec['inputs']) ? (spec['inputs'] as unknown[]) : []) {
    if (!isObject(raw) || !text(raw['name'])) continue
    const type = ['text', 'number', 'boolean', 'choice'].includes(raw['type'] as string) ? (raw['type'] as InputDef['type']) : 'text'
    inputs.push({
      name: raw['name'] as string,
      type,
      ...(text(raw['label']) ? { label: raw['label'] as string } : {}),
      ...(['string', 'number', 'boolean'].includes(typeof raw['default']) ? { default: raw['default'] as string | number | boolean } : {}),
      ...(raw['required'] === true ? { required: true } : {}),
      ...(type === 'choice' && Array.isArray(raw['options']) ? { options: (raw['options'] as unknown[]).filter((o): o is string => typeof o === 'string') } : {})
    })
  }
  const nodes: WorkflowNode[] = [{ id: 'start', type: 'start', name: 'Start', inputs }]
  const taken = new Set(['start', 'end'])
  for (const raw of steps as unknown[]) {
    if (!isObject(raw)) throw new Error('A step is not an object.')
    const name = text(raw['name']) ?? 'Step'
    const given = text(raw['id'])
    const id = given && /^[a-z][a-z0-9_]{0,39}$/.test(given) && !taken.has(given) ? given : nodeIdFrom(name, taken)
    taken.add(id)
    const base = { id, name: name.slice(0, 100), ...(text(raw['description']) ? { description: (raw['description'] as string).slice(0, 300) } : {}) }
    const onError = ['stop', 'retry', 'continue'].includes(raw['onError'] as string) ? { onError: raw['onError'] as 'stop' | 'retry' | 'continue', ...(raw['onError'] === 'retry' ? { retries: 2 } : {}) } : {}
    const kind = raw['do']
    if (kind === 'command') nodes.push({ ...base, ...onError, type: 'tool', tool: { kind: 'shell', command: text(raw['command']) ?? '', ...(text(raw['cwd']) ? { cwd: raw['cwd'] as string } : {}) } })
    else if (kind === 'web') {
      const headers = isObject(raw['headers']) ? Object.fromEntries(Object.entries(raw['headers']).map(([k, v]) => [k, String(v)])) : undefined
      nodes.push({ ...base, ...onError, type: 'tool', tool: { kind: 'http', method: (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(raw['method']).toUpperCase()) ? String(raw['method']).toUpperCase() : 'GET') as 'GET', url: text(raw['url']) ?? '', ...(headers ? { headers } : {}), ...(text(raw['body']) ? { body: raw['body'] as string } : {}) } })
    } else if (kind === 'file') {
      const op = ['read', 'write', 'append'].includes(raw['op'] as string) ? (raw['op'] as 'read' | 'write' | 'append') : 'read'
      nodes.push({ ...base, ...onError, type: 'tool', tool: { kind: 'file', op, path: text(raw['path']) ?? '', ...(typeof raw['content'] === 'string' && op !== 'read' ? { content: raw['content'] } : {}) } })
    } else if (kind === 'tool') {
      const args = isObject(raw['args']) ? Object.fromEntries(Object.entries(raw['args']).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))) : {}
      nodes.push({ ...base, ...onError, type: 'tool', tool: { kind: 'mcp', server: text(raw['server']) ?? '', tool: text(raw['tool']) ?? '', args: args as Record<string, string | number | boolean> } })
    } else if (kind === 'assistant') {
      nodes.push({ ...base, ...onError, type: 'agent', prompt: text(raw['prompt']) ?? '', ...(raw['json'] === true ? { outputFormat: 'json' as const } : {}) })
    } else throw new Error(`The step “${name}” says to do “${String(kind)}”, which is not command, web, file, tool or assistant.`)
  }
  nodes.push({ id: 'end', type: 'end', name: 'End', ...(text(spec['result']) ? { output: spec['result'] as string } : {}) })
  const definition: WorkflowDefinition = { nodes, edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id })) }
  return { name: (text(spec['name']) ?? 'New workflow').slice(0, 100), description: (text(spec['description']) ?? '').slice(0, 1000), definition }
}

/** The JSON in an answer, even when the assistant wrapped it in a code fence or a sentence. */
export function jsonIn(answer: string): unknown {
  const cleaned = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last < first) throw new Error('The answer had no JSON in it.')
  try {
    return JSON.parse(cleaned.slice(first, last + 1))
  } catch {
    throw new Error('The answer was not valid JSON.')
  }
}

export async function draftWorkflow(source: DraftSource, deps: { ask: (prompt: string) => Promise<string>; tools: () => Promise<string[]> }): Promise<Drafted> {
  const tools = await deps.tools().catch(() => [])
  const wanted =
    source.kind === 'text'
      ? `Make a workflow for this:\n\n${source.text.trim()}`
      : `Below is a conversation in which an assistant did some work for the user. Make a workflow that does the same work again, so the user can start it in one click next time.\n\n--- conversation ---\n${source.transcript}\n--- end ---`
  const context = tools.length ? `\n\nThe user has these tool servers, usable in "tool" steps: ${tools.join(', ')}.` : '\n\nThe user has no tool servers, so do not use "tool" steps.'
  let prompt = `${GUIDE}${context}\n\n${wanted}`
  let problem = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const made = definitionFromSpec(jsonIn(await deps.ask(prompt)))
      const problems = validateWorkflow(made.definition)
      if (problems.length === 0) {
        // Through the file reader, so that what is said about missing tools and the like is the same as for an imported file.
        const read = fromFile(toFile(made.name, made.description, made.definition).text, { mcpServers: tools })
        return { name: read.name, description: read.description, definition: read.definition, notes: read.notes }
      }
      problem = problems.slice(0, 4).join(' ')
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
    prompt = `${prompt}\n\nYour last answer could not be used: ${problem}\nAnswer again with the corrected JSON object only.`
  }
  throw new Error(`The assistant could not make a workflow that works. ${problem}`)
}
