// A small MCP server for the checks and tests: it stands in for an internal tool the person has added.
// Started by Celeste over stdio (node scripts/lib/mcp-fixture.mjs), or with `--http <port>` as a web address.
//   shout(text)  answers the text in capitals
//   whoami()     answers the value of the FIXTURE_TOKEN variable it was started with (how a check sees that a secret got through)
//   header()     answers the Authorization header of the request, when it is a web address
//   boom()       fails
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

let authorization = 'none'

function build() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' })
  server.registerTool('shout', { description: 'Answers the text in capital letters', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
    content: [{ type: 'text', text: text.toUpperCase() }]
  }))
  server.registerTool('whoami', { description: 'Says which token this server was started with', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: 'text', text: `token=${process.env['FIXTURE_TOKEN'] ?? 'none'}` }]
  }))
  server.registerTool('header', { description: 'Says which Authorization header the request carried', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: 'text', text: `authorization=${authorization}` }]
  }))
  server.registerTool('boom', { description: 'Always fails', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'It broke on purpose.' }], isError: true }))
  return server
}

const at = process.argv.indexOf('--http')
const gate = process.argv.indexOf('--require')
if (at > -1) {
  const port = Number(process.argv[at + 1])
  const required = gate > -1 ? process.argv[gate + 1] : undefined
  const http = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') return void res.writeHead(404).end()
    authorization = String(req.headers['authorization'] ?? 'none')
    if (required && authorization !== required) return void res.writeHead(401).end('no')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const server = build()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => void server.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')))
  })
  http.listen(port, '127.0.0.1', () => console.error(`fixture listening on ${port}`))
} else {
  await build().connect(new StdioServerTransport())
}
