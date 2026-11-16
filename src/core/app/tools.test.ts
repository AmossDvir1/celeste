import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings, McpServerView } from '@shared/api'
import type { RunSummary, StoredRunEvent, WorkflowFull, WorkflowSummary } from '@shared/workflow'
import { DeviceToolServer } from '../devices/mcp-server'
import { DeviceTools } from '../devices/tools'
import type { DeviceService } from '../devices/device-service'
import { MemoryStore } from '../testing/memory-store'
import { CombinedTools, WorkflowTools } from '../workflows/tools'
import { WorkflowRunner } from '../workflows/runner'
import { AppTools, NOT_HERE, READABLE_SETTINGS, offeredHere, type AppToolsDeps } from './tools'

const NOW = 10_000_000_000
const AppTools_NAMES = ['plugin_list', 'settings_read', 'runs_list', 'run_get', 'plugin_set_enabled', 'settings_change', 'workflow_draft', 'workflow_edit', 'plugin_install', 'plugin_remove']

const plugin = (over: Partial<McpServerView> = {}): McpServerView => ({ id: 'mcp-1', name: 'Playwright', type: 'stdio', command: 'npx', args: ['-y', 'secret-looking-arg'], envNames: ['API_KEY'], headerNames: [], enabled: true, status: { state: 'ok', tools: [{ name: 'a' }, { name: 'b' }], at: 1 }, ...over })

const wf = (id: string, name: string): WorkflowSummary => ({ id, name, description: '', version: 1, allowAssistant: false, createdAt: 1, updatedAt: 1 })

const run = (over: Partial<RunSummary> = {}): RunSummary => ({ id: 'r1', workflowId: 'w1', workflowName: 'Backup', version: 1, status: 'completed', startedBy: 'you', inputs: {}, folder: '/x', startedAt: NOW - 3_600_000, ...over })

function world(over: Partial<AppToolsDeps> = {}) {
  const runs = [run({ id: 'r3', status: 'failed', error: 'disk full', startedAt: NOW - 60_000 }), run({ id: 'r2', workflowId: 'w2', workflowName: 'Deploy' }), run({ id: 'r1' })]
  const events: StoredRunEvent[] = [
    { seq: 1, at: 1, event: { type: 'node.started', nodeId: 'zip', attempt: 1 } },
    { seq: 2, at: 2, event: { type: 'node.failed', nodeId: 'zip', error: 'No space left on device' } },
    { seq: 3, at: 3, event: { type: 'run.failed', error: 'disk full' } }
  ]
  const settings = { ...DEFAULT_SETTINGS, userName: 'Dana', desktopNeverApps: ['KeePass'] } as AppSettings
  const tools = new AppTools({
    where: { step: (id) => id.startsWith('wf-') },
    plugins: () => [plugin(), plugin({ id: 'mcp-2', name: 'Notes', type: 'http', enabled: false, status: { state: 'failed', message: 'connection refused', at: 1 } }), plugin({ id: 'mcp-3', name: 'Fresh', status: { state: 'unchecked' } })],
    settings: () => settings,
    workflows: () => [wf('w1', 'Backup'), wf('w2', 'Deploy')],
    workflow: (id) => ({ ...wf(id, 'Backup'), definition: { nodes: [{ id: 'zip', type: 'tool', name: 'Zip the folder', tool: { kind: 'file', op: 'write', path: 'a', content: 'b' } }], edges: [] } }) as WorkflowFull,
    runs: (id) => runs.filter((r) => !id || r.workflowId === id),
    run: (id) => {
      const summary = runs.find((r) => r.id === id)
      return summary ? { summary, events } : null
    },
    now: () => NOW,
    // The card tools have their own tests (propose.test.ts); here they are never reached.
    propose: async () => ({ answer: 'deny' }),
    draft: async () => {
      throw new Error('not used here')
    },
    draftEdit: async () => {
      throw new Error('not used here')
    },
    saveWorkflow: () => {
      throw new Error('not used here')
    },
    // The light and card tools of steps 4 and 5 have their own tests (light.test.ts).
    changeSettings: () => settings,
    note: () => undefined,
    confirm: async () => false,
    mcp: {
      check: () => {
        throw new Error('not used here')
      },
      save: async () => plugin(),
      test: async () => ({ state: 'unchecked' }),
      setEnabled: () => plugin(),
      hasSecret: async () => false,
      remove: () => undefined,
      removeSecret: async () => undefined
    },
    ...over
  })
  return { tools }
}

describe('the open tools of the Celeste assistant', () => {
  it('are four that only read, then six that change something and so are not read only', () => {
    const { tools } = world()
    expect(tools.list().map((t) => [t.name, t.readOnly])).toEqual([['plugin_list', true], ['settings_read', true], ['runs_list', true], ['run_get', true], ['plugin_set_enabled', false], ['settings_change', false], ['workflow_draft', false], ['workflow_edit', false], ['plugin_install', false], ['plugin_remove', false]])
  })

  it('list the plugins with their state and give no argument, variable or secret', async () => {
    const { tools } = world()
    const out = await tools.call('s1', 'plugin_list', {})
    expect(out.isError).toBe(false)
    expect(out.text).toContain('- Playwright (program): on, last test passed (2 tools)')
    expect(out.text).toContain('- Notes (web address): off, last test failed: connection refused')
    expect(out.text).toContain('- Fresh (program): on, not tested yet')
    expect(out.text).not.toMatch(/secret-looking-arg|API_KEY|npx/)
  })

  it('say so when no plugin is added', async () => {
    const { tools } = world({ plugins: () => [] })
    expect((await tools.call('s1', 'plugin_list', {})).text).toContain('No plugins are added')
  })

  it('read only the settings on the fixed list', async () => {
    const { tools } = world()
    const out = JSON.parse((await tools.call('s1', 'settings_read', {})).text) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual([...READABLE_SETTINGS].sort())
    expect(out.userName).toBe('Dana')
    // Not on the list, so not shown, even though the settings hold them.
    expect(JSON.stringify(out)).not.toContain('KeePass')
    expect(out).not.toHaveProperty('wizardDone')
    expect(out).not.toHaveProperty('sidebarWidth')
  })

  it('never show a key the settings gained that is not on the list', async () => {
    const { tools } = world({ settings: () => ({ ...DEFAULT_SETTINGS, mcpServers: [{ secret: 'x' }], vendorKey: 'sk-123' }) as unknown as AppSettings })
    const text = (await tools.call('s1', 'settings_read', {})).text
    expect(text).not.toMatch(/sk-123|mcpServers|vendorKey/)
  })

  it('list the latest runs, newest first as given, with errors, and only one workflow’s on request', async () => {
    const { tools } = world()
    const all = (await tools.call('s1', 'runs_list', {})).text
    expect(all.split('\n')).toHaveLength(3)
    expect(all).toContain('- r3: Backup, failed, started 1 min ago by the user. Error: disk full')
    expect(all).toContain('- r2: Deploy, completed, started 1 h ago')
    const one = (await tools.call('s1', 'runs_list', { workflow: '/deploy' })).text
    expect(one).toContain('r2')
    expect(one).not.toContain('r3')
    expect((await tools.call('s1', 'runs_list', { limit: 1 })).text.split('\n')).toHaveLength(1)
  })

  it('refuse a limit over 20, an unknown workflow, and say when there are no runs', async () => {
    const { tools } = world()
    expect(await tools.call('s1', 'runs_list', { limit: 21 })).toMatchObject({ isError: true })
    expect((await tools.call('s1', 'runs_list', { workflow: 'nope' })).text).toContain('There is no workflow called “nope”')
    const empty = world({ runs: () => [] }).tools
    expect((await empty.call('s1', 'runs_list', {})).text).toBe('No workflow has run yet.')
  })

  it('show why a run failed, naming the step by its own name', async () => {
    const { tools } = world()
    const out = await tools.call('s1', 'run_get', { runId: 'r3' })
    expect(out.isError).toBe(false)
    expect(out.text).toContain('Backup, version 1: failed.')
    expect(out.text).toContain('Error: disk full')
    expect(out.text).toContain('- Zip the folder failed: No space left on device')
  })

  it('cut a very long error, and refuse an unknown run', async () => {
    const long = 'x'.repeat(5000)
    const { tools } = world({ run: () => ({ summary: run({ status: 'failed', error: long }), events: [] }) })
    const out = (await tools.call('s1', 'run_get', { runId: 'r3' })).text
    expect(out.length).toBeLessThan(2000)
    expect(out).toContain('cut:')
    expect(await world().tools.call('s1', 'run_get', { runId: 'nope' })).toMatchObject({ isError: true })
  })

  it('are offered in an agent step too, since they only read', async () => {
    const { tools } = world()
    expect(await tools.call('wf-step-1', 'plugin_list', {})).toMatchObject({ isError: false })
  })

  it('refuse a name they do not have', async () => {
    expect(await world().tools.call('s1', 'plugin_remove', {})).toMatchObject({ isError: true })
  })
})

describe('where the tools are offered (section 3a of the plan)', () => {
  const where = { step: (id: string) => id.startsWith('wf-') }
  it('lets open tools be used everywhere', () => {
    expect(offeredHere('open', 'wf-1', where)).toBeNull()
    expect(offeredHere('open', 'chat', where)).toBeNull()
  })
  it('refuses light and card tools in an agent step, and only there', () => {
    expect(offeredHere('light', 'wf-1', where)).toBe(NOT_HERE)
    expect(offeredHere('card', 'wf-1', where)).toBe(NOT_HERE)
    expect(offeredHere('light', 'chat', where)).toBeNull()
    expect(offeredHere('card', 'chat', where)).toBeNull()
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
    const runner = new WorkflowRunner({ store, push: () => undefined, agent: { run: async () => 'x' }, mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) } })
    const parts = [new WorkflowTools(store, runner, () => '/')]
    if (extra) parts.push(world().tools as never)
    server.setExtraTools(new CombinedTools(parts))
    await server.start()
    cleanup.push(() => server.stop())
    const client = new Client({ name: 'test-agent', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.info('s1').url), { requestInit: { headers: { Authorization: `Bearer ${server.info('s1').token}` } } }))
    cleanup.push(() => client.close())
    return client
  }

  it('lists them and answers each call', async () => {
    const client = await connect(true)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['plugin_list', 'settings_read', 'runs_list', 'run_get', 'plugin_set_enabled', 'settings_change', 'workflow_draft', 'workflow_edit', 'plugin_install', 'plugin_remove']))
    const text = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(r.content)
    expect(text(await client.callTool({ name: 'plugin_list', arguments: {} }))).toContain('Playwright')
    expect(text(await client.callTool({ name: 'settings_read', arguments: {} }))).toContain('Dana')
    expect(text(await client.callTool({ name: 'runs_list', arguments: { limit: 2 } }))).toContain('r3')
    expect(text(await client.callTool({ name: 'run_get', arguments: { runId: 'r3' } }))).toContain('No space left on device')
    // The tool server hands a plan-mode agent the read only hint.
    const tools = (await client.listTools()).tools
    expect(tools.find((t) => t.name === 'run_get')?.annotations?.readOnlyHint).toBe(true)
  })

  it('cost little in every message: the ten add under 5,500 characters (about 1,400 tokens) to the tool list', async () => {
    const before = JSON.stringify((await (await connect(false)).listTools()).tools).length
    const listed = (await (await connect(true)).listTools()).tools
    const after = JSON.stringify(listed).length
    console.info(`per tool: ${listed.filter((t) => AppTools_NAMES.includes(t.name)).map((t) => `${t.name}=${JSON.stringify(t).length}`).join(' ')}`)
    // Measured when written: see docs/plans/INNER_TOOLS_PLAN.md, step 1.
    console.info(`tool list: ${before} characters before, ${after} after (+${after - before}, about ${Math.round((after - before) / 4)} tokens)`)
    expect(after - before).toBeLessThan(5500)
  })
})
