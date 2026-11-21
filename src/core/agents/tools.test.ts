import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NOT_HERE } from '../app/tools'
import { DeviceToolServer } from '../devices/mcp-server'
import { DeviceTools } from '../devices/tools'
import type { DeviceService } from '../devices/device-service'
import { MemoryStore } from '../testing/memory-store'
import { flush, settle, world } from '../testing/subagents-world'
import { CombinedTools } from '../workflows/tools'
import { HIDDEN_OWN_TOOLS, isOwnAgentTool } from './names'
import { AgentTools, TOOLS_SIZE_BUDGET } from './tools'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

/** The tools with a SubAgents that records what it was asked, for the checks that come before it. */
function fake() {
  const calls: [string, ...unknown[]][] = []
  const agents = {
    isHelper: (id: string) => id.startsWith('s-helper'),
    start: async (...a: unknown[]) => (calls.push(['start', ...a]), { text: 'started', isError: false }),
    send: async (...a: unknown[]) => (calls.push(['send', ...a]), { text: 'sent', isError: false }),
    wait: async (...a: unknown[]) => (calls.push(['wait', ...a]), { text: 'waited', isError: false }),
    stopHelper: (...a: unknown[]) => (calls.push(['stop', ...a]), { text: 'stopped', isError: false }),
    list: async (...a: unknown[]) => (calls.push(['list', ...a]), { text: 'listed', isError: false })
  }
  const tools = new AgentTools({ where: { step: (id) => id.startsWith('wf-') }, agents })
  return { tools, calls }
}

describe('where the helper tools are offered (cases 6, 36, 37, 48)', () => {
  const NAMES = ['agent_start', 'agent_send', 'agent_wait', 'agent_stop', 'agent_list']
  const ARGS: Record<string, unknown> = { agent_start: { task: 'x', title: 'y' }, agent_send: { id: 's-1', text: 'x' }, agent_wait: {}, agent_stop: { id: 's-1' }, agent_list: {} }

  it('are all five, all read only, so a chat in plan mode may use them', () => {
    const list = fake().tools.list()
    expect(list.map((t) => t.name)).toEqual(NAMES)
    expect(list.every((t) => t.readOnly)).toBe(true)
    expect(list.map((t) => t.title)).toEqual(['Start a helper', 'Give a helper more work', 'Wait for helpers', 'Stop a helper', 'List helpers'])
  })

  it('refuse a workflow step or a scheduled run, before anything else', async () => {
    const { tools, calls } = fake()
    for (const name of NAMES) expect(await tools.call('wf-step-1', name, ARGS[name])).toEqual({ text: NOT_HERE, isError: true })
    // Not even a badly formed call gets further than that sentence.
    expect(await tools.call('wf-step-1', 'agent_start', { nonsense: true })).toEqual({ text: NOT_HERE, isError: true })
    expect(calls).toEqual([])
  })

  it('refuse a helper, agent_list included: it does not see the others', async () => {
    const { tools, calls } = fake()
    for (const name of NAMES) expect(await tools.call('s-helper-1', name, ARGS[name])).toEqual({ text: 'Helpers cannot start helpers.', isError: true })
    expect(calls).toEqual([])
  })

  it('refuse a tool they do not have', async () => {
    expect(await fake().tools.call('s-1', 'agent_fire', {})).toEqual({ text: 'There is no tool called agent_fire.', isError: true })
  })
})

describe('what the tools pass on', () => {
  it('starts a helper that is waited for unless it is told not to, and names it from its task when no name came', async () => {
    const { tools, calls } = fake()
    await tools.call('s-1', 'agent_start', { task: '  Read the three newest logs and tell me what failed  ', title: '  ' })
    await tools.call('s-1', 'agent_start', { task: 'x', title: 'Named', wait: false, vendor: 'openai', model: 'openai:gpt', effort: 'high', approval: 'plan', folder: 'copy' })
    expect(calls[0]).toEqual(['start', 's-1', { task: '  Read the three newest logs and tell me what failed  ', title: 'Read the three newest logs and', wait: true }])
    expect(calls[1]).toEqual(['start', 's-1', { task: 'x', title: 'Named', vendor: 'openai', model: 'openai:gpt', effort: 'high', approval: 'plan', folder: 'copy', wait: false }])
  })

  it('passes agent_send, agent_wait and agent_stop their arguments, waiting by default', async () => {
    const { tools, calls } = fake()
    await tools.call('s-1', 'agent_send', { id: 's-2', text: 'More' })
    await tools.call('s-1', 'agent_send', { id: 's-2', text: 'More', wait: false })
    await tools.call('s-1', 'agent_wait', {})
    await tools.call('s-1', 'agent_wait', { ids: ['s-2', 's-3'], any: true })
    await tools.call('s-1', 'agent_stop', { id: 's-2' })
    await tools.call('s-1', 'agent_list', undefined)
    expect(calls).toEqual([
      ['send', 's-1', 's-2', 'More', true],
      ['send', 's-1', 's-2', 'More', false],
      ['wait', 's-1', undefined, false],
      ['wait', 's-1', ['s-2', 's-3'], true],
      ['stop', 's-1', 's-2'],
      ['list', 's-1']
    ])
  })

  it('says what is wrong with an argument, in a sentence', async () => {
    const { tools, calls } = fake()
    const empty = await tools.call('s-1', 'agent_start', { task: '', title: 'x' })
    expect(empty.isError).toBe(true)
    expect(empty.text).toMatch(/^Invalid arguments: task /)
    expect((await tools.call('s-1', 'agent_start', { task: 'x', title: 'x', approval: 'auto' })).text).toMatch(/^Invalid arguments: approval /)
    expect((await tools.call('s-1', 'agent_start', { task: 'x', title: 'y'.repeat(61) })).text).toMatch(/^Invalid arguments: title /)
    expect((await tools.call('s-1', 'agent_send', { id: 's-2' })).text).toMatch(/^Invalid arguments: text /)
    expect(calls).toEqual([])
  })
})

describe('with the real bookkeeping behind them', () => {
  it('a helper that calls agent_start or agent_list is refused, and a chat of the person’s is not (cases 6, 48)', async () => {
    const w = world()
    const tools = new AgentTools({ where: { step: () => false }, agents: w.sub })
    const parent = w.make({ approval: 'plan' })
    const started = await tools.call(parent.id, 'agent_start', { task: 'Look', title: 'Looker', wait: false })
    expect(started.isError).toBe(false)
    const id = w.idOf(started.text)
    expect(await tools.call(id, 'agent_start', { task: 'More', title: 'Deeper' })).toEqual({ text: 'Helpers cannot start helpers.', isError: true })
    expect(await tools.call(id, 'agent_list', {})).toEqual({ text: 'Helpers cannot start helpers.', isError: true })
    expect(w.store.listChildren(id)).toEqual([])
    expect(w.store.listChildren(parent.id)).toHaveLength(1)
    const listed = await tools.call(parent.id, 'agent_list', {})
    expect(listed.text).toContain('“Looker”')
  })

  it('a waited start returns the helper’s answer as the tool result', async () => {
    const w = world()
    const tools = new AgentTools({ where: { step: () => false }, agents: w.sub })
    const parent = w.make()
    const call = tools.call(parent.id, 'agent_start', { task: 'Count the files', title: 'Counter' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    await w.run(id, 'There are 12 files.')
    const r = await call
    expect(r.isError).toBe(false)
    expect(r.text).toContain('There are 12 files.')
    expect(r.text.startsWith('[Answer from the helper “Counter”')).toBe(true)
    await settle()
  })
})

describe('the names of the tools, as the four programs call them (6.1)', () => {
  it('are recognised from what each vendor gives, and a tool of the person’s own is not', () => {
    expect([...HIDDEN_OWN_TOOLS].sort()).toEqual(['agent_list', 'agent_send', 'agent_start', 'agent_stop', 'agent_wait'])
    expect(isOwnAgentTool('mcp__celeste-devices__agent_start')).toBe(true)
    expect(isOwnAgentTool('celeste_devices', 'agent_wait')).toBe(true)
    expect(isOwnAgentTool('mcp_celeste-devices_agent_list-1700000000-0', 'agent_list (celeste-devices MCP Server)')).toBe(true)
    expect(isOwnAgentTool('agent_start', 'celeste-devices')).toBe(true)
    expect(isOwnAgentTool('mcp__notes__agent_start')).toBe(false)
    expect(isOwnAgentTool('mcp__celeste-devices__device_run')).toBe(false)
    expect(isOwnAgentTool('mcp__celeste-devices__agent_starter')).toBe(false)
    expect(isOwnAgentTool(undefined, null)).toBe(false)
  })
})

describe('an agent reaching the tools over the tool server', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c()
  })

  async function connect(extra: boolean) {
    const store = new MemoryStore()
    const server = new DeviceToolServer(new DeviceTools(store, {} as DeviceService, { requestApproval: async () => true }, { join: (...p) => p.join('/'), mkdirp: async () => undefined }, '/data'))
    server.setExtraTools(new CombinedTools(extra ? [fake().tools] : []))
    await server.start()
    cleanup.push(() => server.stop())
    const client = new Client({ name: 'test-agent', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.info('s-1').url), { requestInit: { headers: { Authorization: `Bearer ${server.info('s-1').token}` } } }))
    cleanup.push(() => client.close())
    return client
  }

  it('lists the five, with the read only hint, and answers a call', async () => {
    vi.useRealTimers()
    const client = await connect(true)
    const tools = (await client.listTools()).tools
    expect(tools.filter((t) => t.name.startsWith('agent_')).map((t) => t.name)).toEqual(['agent_start', 'agent_send', 'agent_wait', 'agent_stop', 'agent_list'])
    expect(tools.find((t) => t.name === 'agent_start')?.annotations?.readOnlyHint).toBe(true)
    const r = await client.callTool({ name: 'agent_start', arguments: { task: 'Look', title: 'Looker' } })
    expect(JSON.stringify(r.content)).toContain('started')
  })

  it(`cost little in every message: the descriptions and shapes of all five stay under ${TOOLS_SIZE_BUDGET} characters`, async () => {
    vi.useRealTimers()
    const listed = (await (await connect(true)).listTools()).tools.filter((t) => t.name.startsWith('agent_'))
    expect(listed).toHaveLength(5)
    // What the model reads of a tool: its description, and the arguments with what each says. (The wire adds about 250 characters of
    // fixed framing to every tool of every server, which no wording of ours changes.)
    const words = listed.map((t) => (t.description ?? '').length + JSON.stringify(t.inputSchema.properties ?? {}).length)
    const total = words.reduce((a, b) => a + b, 0)
    console.info(`helper tools: ${total} characters of words and arguments, about ${Math.round(total / 4)} tokens (${listed.map((t, i) => `${t.name}=${words[i]}`).join(' ')}); ${JSON.stringify(listed).length} on the wire`)
    expect(total).toBeLessThan(TOOLS_SIZE_BUDGET)
  })
})
