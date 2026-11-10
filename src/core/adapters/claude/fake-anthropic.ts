import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/*
 * A stand-in for Anthropic's API, for testing the adapter against the real SDK and the real Claude Code program with
 * no account: Claude Code is pointed at it with ANTHROPIC_BASE_URL. It answers every request in the shape the API
 * does, as a stream when asked for one, following a small script chosen from the last thing said to it.
 */

export type Block =
  /** chunk and delayMs make the text arrive in small pieces over time, as a model's tokens do (a test of how the window copes). */
  | { type: 'text'; text: string; chunk?: number; delayMs?: number }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  /** Starts an answer and never finishes it, so a test can stop it in the middle. */
  | { type: 'hold' }

export interface FakeRequest {
  model: string
  /** The text of the last user message, or the tool result that came back. */
  last: { kind: 'text'; text: string } | { kind: 'tool_result'; text: string; isError: boolean }
  /** Whether the last user message carried an image. */
  image: boolean
  /** The size, in bytes, of the pictures inside the tool result that came back (a screenshot a tool returned), or 0. */
  resultImageBytes: number
  body: Record<string, unknown>
}

export type Script = (request: FakeRequest) => Block[]

export class FakeAnthropic {
  /** Every request Claude Code made, including the small side requests it makes for itself (summaries, checks). */
  readonly requests: FakeRequest[] = []
  /** The requests of the conversation itself: the ones that carry the agent's tools. */
  get main(): FakeRequest[] {
    return this.requests.filter((r) => Array.isArray(r.body['tools']) && (r.body['tools'] as unknown[]).length > 0)
  }
  /**
   * What the stand-in says when Celeste asks for a title for a new session (recognised by its two-line instructions, not by the
   * script, so a script written for a conversation is not confused by it). By default the reply is too long to be a title, which
   * Celeste ignores, so a session keeps its first words; a test that wants a title sets this.
   */
  naming: (message: string) => string = () => 'This reply is far too long to be a title, so the app ignores it and keeps the first words.'
  private server: Server | undefined
  private counter = 0
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
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
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
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(path.endsWith('count_tokens') ? 200 : 404, { 'content-type': 'application/json' })
      res.end(path.endsWith('count_tokens') ? '{"input_tokens":10}' : '{"type":"error","error":{"type":"not_found_error","message":"no"}}')
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      /* answered below as an empty request */
    }
    const request = describe(body)
    this.requests.push(request)
    const naming = JSON.stringify(body['system'] ?? '').includes('You name conversations')
    const blocks: Block[] = naming ? [{ type: 'text', text: this.naming(request.last.kind === 'text' ? request.last.text : '') }] : this.script(request)
    const id = `msg_fake_${++this.counter}`
    const model = String(body['model'] ?? 'claude-fake')
    if (body['stream'] !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(message(id, model, blocks)))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', { type: 'message_start', message: { ...message(id, model, []), stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } })
    for (const [index, b] of blocks.entries()) {
      if (b.type === 'hold') {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Working on it' } })
        return
      }
      if (b.type === 'text') {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        // Two pieces, so the stream is seen to arrive in parts; or many small ones, when asked.
        const mid = Math.ceil(b.text.length / 2)
        const parts = b.chunk && b.chunk > 0 ? (b.text.match(new RegExp(`[\\s\\S]{1,${b.chunk}}`, 'g')) ?? []) : [b.text.slice(0, mid), b.text.slice(mid)].filter(Boolean)
        for (const text of parts) {
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
          if (b.delayMs) await new Promise((resolve) => setTimeout(resolve, b.delayMs))
        }
      } else {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fake_${this.counter}_${index}`, name: b.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
      }
      send('content_block_stop', { type: 'content_block_stop', index })
    }
    const usesTool = blocks.some((b) => b.type === 'tool_use')
    send('message_delta', { type: 'message_delta', delta: { stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
    send('message_stop', { type: 'message_stop' })
    res.end()
  }
}

function message(id: string, model: string, blocks: Block[]): Record<string, unknown> {
  const usesTool = blocks.some((b) => b.type === 'tool_use')
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks.flatMap((b, i): Record<string, unknown>[] => (b.type === 'text' ? [b] : b.type === 'tool_use' ? [{ type: 'tool_use', id: `toolu_fake_${id}_${i}`, name: b.name, input: b.input }] : [])),
    stop_reason: usesTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n')
}

/** What the person typed: Claude Code adds its own reminders as extra text blocks around it. */
function typed(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const own = content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter((t) => t && !t.trimStart().startsWith('<system-reminder>'))
  return own[own.length - 1] ?? ''
}

/** The bytes of the pictures in a tool result's content, from their base64 text. */
function pictureBytes(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let bytes = 0
  for (const b of content as Record<string, unknown>[]) {
    const source = b?.['type'] === 'image' ? (b['source'] as { data?: unknown } | undefined) : undefined
    if (typeof source?.data === 'string') bytes += Math.floor((source.data.length * 3) / 4)
  }
  return bytes
}

function describe(body: Record<string, unknown>): FakeRequest {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as { role?: string; content?: unknown }[]) : []
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const content = Array.isArray(last?.content) ? (last?.content as Record<string, unknown>[]) : []
  const result = content.find((b) => b['type'] === 'tool_result')
  return {
    model: String(body['model'] ?? ''),
    body,
    image: content.some((b) => b['type'] === 'image'),
    resultImageBytes: pictureBytes(result?.['content']),
    last: result
      ? { kind: 'tool_result', text: textOf(result['content']), isError: result['is_error'] === true }
      : { kind: 'text', text: typed(last?.content) }
  }
}
