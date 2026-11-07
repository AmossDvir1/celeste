// Turns the raw recordings (copilot-record.mjs) into small, anonymous test fixtures.
// usage: node make-fixtures.mjs <scratchpad-dir> <real-cwd> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, cwd, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })

const KEEP = new Set([
  'session.start', 'session.title_changed', 'session.info', 'session.warning', 'session.error', 'session.idle', 'abort',
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.message_start', 'assistant.message_delta', 'assistant.message',
  'assistant.reasoning_delta', 'assistant.reasoning', 'assistant.usage',
  'tool.execution_start', 'tool.execution_partial_result', 'tool.shell_output', 'tool.execution_complete',
  'permission.requested', 'permission.completed', 'user_input.requested', 'user_input.completed'
])
// Events the adapter must ignore, kept in small numbers so the tests prove it.
const NOISE = { 'assistant.streaming_delta': 3, 'session.mcp_server_status_changed': 2, 'model.turn_started': 1, 'assistant.tool_call_delta': 2 }

const USAGE_FIELDS = ['model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost']
const windows = cwd.replace(/\//g, '\\')
const posix = cwd.replace(/\\/g, '/')
const swap = (text) => text.split(windows.replace(/\\/g, '\\\\')).join('C:\\\\work\\\\demo').split(posix).join('C:/work/demo').split(windows).join('C:\\work\\demo')

// The recorded shell output wraps long paths across lines, so the plain swap above misses them. This is JSON text: a backslash is two characters.
const tidy = (t) => t.replace(/Directory: C:\\\\Users.*?scratchpad\\\\play/g, 'Directory: C:\\\\work\\\\demo').replace(/Directory: C:\\\\Users[^"]*"/g, 'Directory: C:\\\\work\\\\demo"').replace('" C:/Users/"', '" C:/work/"')

for (const name of ['basic', 'edit', 'ask']) {
  const rec = JSON.parse(readFileSync(join(dir, `rec-${name}.json`), 'utf8'))
  const seen = {}
  const events = []
  for (const e of rec.events) {
    if (NOISE[e.type] !== undefined) {
      seen[e.type] = (seen[e.type] ?? 0) + 1
      if (seen[e.type] > NOISE[e.type]) continue
    } else if (!KEEP.has(e.type)) continue
    const data = { ...e.data }
    if (e.type === 'assistant.usage') for (const k of Object.keys(data)) if (!USAGE_FIELDS.includes(k)) delete data[k]
    if (e.type === 'tool.execution_complete') {
      delete data.toolTelemetry
      delete data.interactionId
      if (data.result) delete data.result.detailedContent
    }
    if (e.type === 'permission.requested') delete data.assistedApprovalAssessment
    events.push({ type: e.type, id: e.id, timestamp: e.timestamp, data })
  }
  const text = swap(JSON.stringify({ model: rec.model, prompt: rec.prompt, events, inputs: rec.inputs }, null, 1))
  writeFileSync(join(outDir, `${name}.json`), tidy(text))
  console.log(name, events.length, 'events', text.length, 'bytes')
}
