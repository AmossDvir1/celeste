import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ExtraTools } from '../workflows/tools'
import { TOOLS, type DeviceTools, type ToolName } from './tools'

const MAX_BODY = 2 * 1024 * 1024
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Celeste's own MCP server for the device tools. Any vendor's agent can use it, because they all accept MCP
 * servers. It listens on this computer only, each session has its own secret token, and a request is refused
 * unless it carries that token and comes from this machine and not from a web page.
 */
export class DeviceToolServer {
  private http: Server | null = null
  private port = 0
  private readonly sessionByToken = new Map<string, string>()
  private readonly tokenBySession = new Map<string, string>()

  private extra: ExtraTools | undefined

  constructor(private readonly tools: DeviceTools) {}

  /** More tools for every session's agent, such as the workflows it may run. */
  setExtraTools(extra: ExtraTools): void {
    this.extra = extra
  }

  async start(): Promise<void> {
    if (this.http) return
    this.http = createServer((req, res) => void this.handle(req, res).catch(() => this.fail(res, 500, 'Something went wrong.')))
    await new Promise<void>((resolve, reject) => {
      this.http?.once('error', reject)
      this.http?.listen(0, '127.0.0.1', resolve)
    })
    this.port = (this.http.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = null
    if (http) await new Promise<void>((resolve) => (http.closeAllConnections(), http.close(() => resolve())))
  }

  /** Where an agent for this session connects, and the token that says it is that session. */
  info(sessionId: string): { url: string; token: string } {
    let token = this.tokenBySession.get(sessionId)
    if (!token) {
      token = randomBytes(32).toString('hex')
      this.tokenBySession.set(sessionId, token)
      this.sessionByToken.set(hash(token), sessionId)
    }
    return { url: `http://127.0.0.1:${this.port}/mcp`, token }
  }

  forget(sessionId: string): void {
    const token = this.tokenBySession.get(sessionId)
    if (token) this.sessionByToken.delete(hash(token))
    this.tokenBySession.delete(sessionId)
  }

  private fail(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw new Error('too large')
      chunks.push(chunk as Buffer)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  private serverFor(sessionId: string): McpServer {
    const server = new McpServer({ name: 'celeste-devices', version: '1.0.0' })
    // Every tool is always listed. An agent asks for the list once, when it connects, so a list that followed the attached devices
    // would show a device attached later as no tools at all. What a tool may do is decided when it is called (DeviceTools.call):
    // a read only device refuses commands and writes there, with a message that says why.
    for (const name of Object.keys(TOOLS) as ToolName[]) {
      const def = TOOLS[name]
      // `readOnlyHint` is what lets an agent in plan mode use the tools that change nothing on the device.
      server.registerTool(name, { title: def.title, description: def.description, inputSchema: def.shape, annotations: { readOnlyHint: def.needs === 'any' } }, async (args: unknown) => {
        const out = await this.tools.call(sessionId, name, args)
        return {
          content: [
            { type: 'text' as const, text: out.text },
            ...(out.image ? [{ type: 'image' as const, data: out.image.data, mimeType: out.image.mime }] : [])
          ],
          isError: out.isError
        }
      })
    }
    for (const tool of this.extra?.list() ?? []) {
      server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape, annotations: { readOnlyHint: tool.readOnly } }, async (args: unknown) => {
        const out = await (this.extra as ExtraTools).call(sessionId, tool.name, args)
        return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError }
      })
    }
    return server
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A web page can make a browser send requests to this computer. Refuse anything that looks like one.
    const host = req.headers.host
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.fail(res, 403, 'Forbidden')
    if (req.headers.origin) return this.fail(res, 403, 'Forbidden')
    if (req.url !== '/mcp') return this.fail(res, 404, 'Not found')
    if (req.method !== 'POST') return this.fail(res, 405, 'Method not allowed', { allow: 'POST' })

    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const sessionId = bearer ? this.sessionByToken.get(hash(bearer)) : undefined
    if (!sessionId) return this.fail(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' })

    let body: unknown
    try {
      body = await this.body(req)
    } catch {
      return this.fail(res, 400, 'The request was not valid JSON, or was too large.')
    }

    const server = this.serverFor(sessionId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}
