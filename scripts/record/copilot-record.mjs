// Records the events of one small real Copilot turn into a JSON file, for building the adapter's tests.
// usage: node copilot-record.mjs <out.json> <model> <cwd> "<prompt>" [mcpUrl mcpToken]
import { writeFileSync } from 'node:fs'
import { CopilotClient } from '@github/copilot-sdk'

const [out, model, cwd, prompt, mcpUrl, mcpToken] = process.argv.slice(2)
const events = []
const permissions = []
const inputs = []
const client = new CopilotClient({ logLevel: 'error' })
try {
  await client.start()
  const session = await client.createSession({
    model,
    workingDirectory: cwd,
    streaming: true,
    onPermissionRequest: async (request) => {
      permissions.push(request)
      return { kind: 'approve-once' }
    },
    onUserInputRequest: async (request) => {
      inputs.push(request)
      return { answer: request.choices?.[0] ?? 'yes', wasFreeform: !request.choices?.length }
    },
    ...(mcpUrl ? { mcpServers: { 'celeste-devices': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` }, tools: ['*'] } } } : {})
  })
  console.log('session id:', session.sessionId)
  session.on((e) => events.push(e))
  const done = new Promise((resolve) => session.on('session.idle', () => resolve()))
  await session.send({ prompt })
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 120s')), 120000))])
  await session.disconnect()
} catch (e) {
  console.log('failed:', e.message)
} finally {
  writeFileSync(out, JSON.stringify({ model, prompt, events, permissions, inputs }, null, 1))
  const kinds = {}
  for (const e of events) kinds[e.type] = (kinds[e.type] ?? 0) + 1
  console.log(JSON.stringify(kinds))
  console.log('permissions:', permissions.map((p) => p.kind + (p.toolName ? ':' + p.toolName : '')).join(', '))
  await client.stop().catch(() => undefined)
}
