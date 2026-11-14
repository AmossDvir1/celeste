import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/*
 * A stand-in for OpenAI's Responses API, for testing the adapter against the real Codex program with no account: Codex is told to
 * send its requests here (its provider's base_url). It answers every request as a stream, in the shape the API does, following a
 * small script chosen from the last thing said to it. Plain Node-strippable TypeScript: no parameter properties.
 */

export type Block =
  /** chunk and delayMs make the text arrive in small pieces over time, as a model's tokens do. */
  | { type: 'text'; text: string; chunk?: number; delayMs?: number }
  /** A call to one of the agent's own tools (running a command, editing files). `arguments` is what the model passes. */
  | { type: 'call'; name: string; arguments: Record<string, unknown> | string }
  /** Starts an answer and never finishes it, so a test can stop it in the middle. */
  | { type: 'hold' }
  /** Ends the answer with an error, as the API does when a limit is reached. */
  | { type: 'fail'; code: string; message: string }

export interface FakeRequest {
  model: string
  /** The text of the last user message, or the tool result that came back. */
  last: { kind: 'text'; text: string } | { kind: 'tool_result'; text: string }
  /** Whether the last user message carried an image. */
  image: boolean
  /** The `authorization` header the request came with. */
  authorization: string
  body: Record<string, unknown>
}

export type Script = (request: FakeRequest) => Block[]

export class FakeOpenAi {
  /** Every request Codex made to the Responses API. */
  readonly requests: FakeRequest[] = []
  /** The names of the tools the agent offered in its last request. */
  get toolNames(): string[] {
    const tools = this.requests.at(-1)?.body['tools']
    return Array.isArray(tools) ? tools.map((t) => String((t as { name?: unknown }).name ?? (t as { type?: unknown }).type ?? '')) : []
  }
  /** What `GET /v1/models` answers (a key is checked with it). 401 makes the stand-in refuse every key. */
  rejectKeys = false
  private server: Server | undefined
  private counter = 0
  /** The base address Codex is pointed at, ending in /v1. */
  url = ''
  private script: Script

  constructor(script: Script) {
    this.script = script
  }

  setScript(script: Script): void {
    this.script = script
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      if (this.rejectKeys) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"Incorrect API key provided."}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-model' }], models: [{ slug: 'fake-model', display_name: 'Fake model', visibility: 'list' }] }))
      return
    }
    if (req.method !== 'POST' || !path.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"no"}}')
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      /* answered below as an empty request */
    }
    const request = describe(body, String(req.headers['authorization'] ?? ''))
    this.requests.push(request)
    const blocks = this.script(request)
    const id = `resp_fake_${++this.counter}`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('response.created', { response: { id, object: 'response', status: 'in_progress' } })
    let index = 0
    for (const b of blocks) {
      if (b.type === 'hold') {
        const item = { id: `msg_${id}_${index}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
        send('response.output_item.added', { output_index: index, item })
        send('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '' } })
        send('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: 'Working on it' })
        return // never finished
      }
      if (b.type === 'fail') {
        send('response.failed', { response: { id, status: 'failed', error: { code: b.code, message: b.message } } })
        res.end()
        return
      }
      if (b.type === 'text') {
        const item = { id: `msg_${id}_${index}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
        send('response.output_item.added', { output_index: index, item })
        send('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '' } })
        const mid = Math.ceil(b.text.length / 2)
        const parts = b.chunk && b.chunk > 0 ? (b.text.match(new RegExp(`[\\s\\S]{1,${b.chunk}}`, 'g')) ?? []) : [b.text.slice(0, mid), b.text.slice(mid)].filter(Boolean)
        for (const delta of parts) {
          send('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta })
          if (b.delayMs) await new Promise((resolve) => setTimeout(resolve, b.delayMs))
        }
        const part = { type: 'output_text', text: b.text, annotations: [] }
        send('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: b.text })
        send('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part })
        send('response.output_item.done', { output_index: index, item: { ...item, status: 'completed', content: [part] } })
      } else {
        const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments)
        const item = { id: `fc_${id}_${index}`, type: 'function_call', call_id: `call_${id}_${index}`, name: b.name, arguments: '', status: 'in_progress' }
        send('response.output_item.added', { output_index: index, item })
        send('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: args })
        send('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: args })
        send('response.output_item.done', { output_index: index, item: { ...item, arguments: args, status: 'completed' } })
      }
      index++
    }
    send('response.completed', {
      response: {
        id,
        object: 'response',
        status: 'completed',
        usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 19 }
      }
    })
    res.end()
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && ['input_text', 'output_text', 'text'].includes(String((b as { type?: unknown }).type)) ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

/** What the person typed: Codex adds its own context (the environment, the project's instructions) as messages of its own, in angle brackets. */
function typed(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const own = content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'input_text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter((t) => t && !t.trimStart().startsWith('<'))
  return own[own.length - 1] ?? ''
}

function describe(body: Record<string, unknown>, authorization: string): FakeRequest {
  const input = Array.isArray(body['input']) ? (body['input'] as Record<string, unknown>[]) : []
  const results = input.filter((i) => i['type'] === 'function_call_output' || i['type'] === 'custom_tool_call_output')
  const lastResult = results.at(-1)
  const lastItem = input.at(-1)
  const users = input.filter((i) => i['type'] === 'message' && i['role'] === 'user')
  const withText = users.map((u) => ({ u, text: typed(u['content']) })).filter((x) => x.text)
  const lastUser = withText.at(-1) ?? (users.length ? { u: users[users.length - 1] as Record<string, unknown>, text: '' } : undefined)
  const content = Array.isArray(lastUser?.u['content']) ? (lastUser?.u['content'] as Record<string, unknown>[]) : []
  const resultIsLast = lastResult !== undefined && lastItem === lastResult
  return {
    model: String(body['model'] ?? ''),
    body,
    authorization,
    image: content.some((b) => b['type'] === 'input_image'),
    last: resultIsLast ? { kind: 'tool_result', text: textOf(lastResult['output']) || String(lastResult['output'] ?? '') } : { kind: 'text', text: lastUser?.text ?? '' }
  }
}
