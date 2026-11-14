import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/*
 * A stand-in for the Gemini API, for testing the adapter against the real Gemini CLI with no account or key: the CLI is pointed at it
 * with GOOGLE_GEMINI_BASE_URL. It answers every request in the shape the API does (a stream of JSON chunks), following a small script
 * chosen from the last thing said to it. Plain Node-strippable TypeScript: no parameter properties.
 */

export type Block =
  /** chunk and delayMs make the text arrive in small pieces over time, as a model's tokens do. */
  | { type: 'text'; text: string; chunk?: number; delayMs?: number }
  /** A call to one of the agent's own tools (reading a file, running a command). */
  | { type: 'call'; name: string; args: Record<string, unknown> }
  /** Starts an answer and never finishes it, so a test can stop it in the middle. */
  | { type: 'hold' }
  /** Answers with an error, as the API does when a key is wrong or a limit is reached. */
  | { type: 'fail'; status: number; message: string }

export interface FakeRequest {
  model: string
  /** The text of the last user message, or the tool result that came back. */
  last: { kind: 'text'; text: string } | { kind: 'tool_result'; name: string; text: string }
  /** Whether the last user message carried an image. */
  image: boolean
  /** The key the request came with, from its header or its address. */
  key: string
  /** The names of the tools the agent offered. */
  tools: string[]
  body: Record<string, unknown>
}

export type Script = (request: FakeRequest) => Block[]

export class FakeGemini {
  /** Every request the CLI made to generate an answer, including the small ones it makes for itself (a check that the next speaker is the model). */
  readonly requests: FakeRequest[] = []
  /** What `GET /models` answers when a key is checked. A refused key answers 400, as Google does. */
  rejectKeys = false
  private server: Server | undefined
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const key = String(req.headers['x-goog-api-key'] ?? url.searchParams.get('key') ?? '')
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.method === 'GET' && /\/models(\/[^/:]+)?$/.test(path)) {
      if (this.rejectKeys || !key) return json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })
      return json(200, { models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }] })
    }
    if (req.method === 'POST' && path.endsWith(':countTokens')) return json(200, { totalTokens: 10 })
    const m = /\/models\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(path)
    if (req.method !== 'POST' || !m) return json(404, { error: { code: 404, message: `no ${path}`, status: 'NOT_FOUND' } })
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      /* answered below as an empty request */
    }
    const request = describe(body, m[1] as string, key)
    this.requests.push(request)
    if (this.rejectKeys) return json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })
    const blocks = this.script(request)
    const failure = blocks.find((b) => b.type === 'fail')
    if (failure && failure.type === 'fail') return json(failure.status, { error: { code: failure.status, message: failure.message, status: failure.status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL' } })
    const usage = { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 }
    const frame = (parts: unknown[], finish?: string) => ({
      candidates: [{ content: { role: 'model', parts }, ...(finish ? { finishReason: finish } : {}), index: 0 }],
      usageMetadata: usage,
      modelVersion: m[1]
    })
    if (m[2] === 'generateContent') {
      const parts = blocks.flatMap((b): Record<string, unknown>[] => (b.type === 'text' ? [{ text: b.text }] : b.type === 'call' ? [{ functionCall: { name: b.name, args: b.args } }] : []))
      return json(200, frame(parts, 'STOP'))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\r\n\r\n`)
    for (const b of blocks) {
      if (b.type === 'hold') {
        send(frame([{ text: 'Working on it' }]))
        return // never finished
      }
      if (b.type === 'text') {
        const mid = Math.ceil(b.text.length / 2)
        const parts = b.chunk && b.chunk > 0 ? (b.text.match(new RegExp(`[\\s\\S]{1,${b.chunk}}`, 'g')) ?? []) : [b.text.slice(0, mid), b.text.slice(mid)].filter(Boolean)
        for (const text of parts) {
          send(frame([{ text }]))
          if (b.delayMs) await new Promise((resolve) => setTimeout(resolve, b.delayMs))
        }
      } else if (b.type === 'call') send(frame([{ functionCall: { name: b.name, args: b.args } }]))
    }
    send(frame([{ text: '' }], 'STOP'))
    res.end()
  }
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n')
}

/** What the person typed: the CLI adds its own context (the date, the folder) as parts of its own, in angle brackets. */
function typed(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  const own = parts.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).filter((t) => t && !t.trimStart().startsWith('<') && !t.trimStart().startsWith('This is the Gemini CLI'))
  return own[own.length - 1] ?? ''
}

function describe(body: Record<string, unknown>, model: string, key: string): FakeRequest {
  const contents = Array.isArray(body['contents']) ? (body['contents'] as { role?: string; parts?: unknown }[]) : []
  const last = contents.at(-1)
  const response = Array.isArray(last?.parts) ? (last?.parts as Record<string, unknown>[]).find((p) => p['functionResponse']) : undefined
  const users = contents.filter((c) => c.role === 'user' && !(Array.isArray(c.parts) && (c.parts as Record<string, unknown>[]).some((p) => p['functionResponse'])))
  const withText = users.map((u) => ({ u, text: typed(u.parts) })).filter((x) => x.text)
  const lastUser = withText.at(-1)
  const tools = (Array.isArray(body['tools']) ? (body['tools'] as { functionDeclarations?: { name?: string }[] }[]) : []).flatMap((t) => (t.functionDeclarations ?? []).map((d) => String(d.name ?? '')))
  const fr = (response?.['functionResponse'] ?? {}) as { name?: string; response?: unknown }
  return {
    model,
    body,
    key,
    tools,
    image: users.some((u) => Array.isArray(u.parts) && (u.parts as Record<string, unknown>[]).some((p) => p['inlineData'])),
    last: response ? { kind: 'tool_result', name: String(fr.name ?? ''), text: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? '') } : { kind: 'text', text: lastUser?.text ?? textOf(users.at(-1)?.parts) }
  }
}
