import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskAnswers } from '@shared/agent'
import type { CorePush } from '@shared/api'
import type { DeviceRecord } from '@shared/devices'
import type { RunSummary, WorkflowDefinition, WorkflowNode, ToolSpec } from '@shared/workflow'
import { callTool, type ResolvedMcpServer } from '../mcp'
import type { ExecResult } from '../devices/exec'
import { MemoryStore } from '../testing/memory-store'
import { WorkflowRunner, type AgentStepRequest, type RunnerDeps } from './runner'

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'celeste-run-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const start = (inputs: { name: string; type?: 'text' | 'number' | 'boolean' | 'choice'; default?: string | number | boolean; required?: boolean; options?: string[] }[] = []): WorkflowNode => ({
  id: 'start',
  type: 'start',
  name: 'Start',
  inputs: inputs.map((i) => ({ type: 'text' as const, ...i }))
})
const end = (output?: string): WorkflowNode => ({ id: 'end', type: 'end', name: 'End', ...(output !== undefined ? { output } : {}) })
const tool = (id: string, spec: ToolSpec, more: Partial<Extract<WorkflowNode, { type: 'tool' }>> = {}): WorkflowNode => ({ id, type: 'tool', name: id, tool: spec, ...more })
const chain = (...nodes: WorkflowNode[]): WorkflowDefinition => ({
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id }))
})

const ok = (stdout = '', code = 0, stderr = ''): ExecResult => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), timedOut: false, cancelled: false, missing: false })

interface Setup {
  deps?: Partial<RunnerDeps>
  mcp?: ResolvedMcpServer[]
  agent?: (r: AgentStepRequest) => Promise<string>
}
function setup(def: WorkflowDefinition, options: Setup = {}) {
  const store = new MemoryStore()
  const pushed: CorePush[] = []
  let clock = 1000
  const asked: AgentStepRequest[] = []
  const runner = new WorkflowRunner({
    store,
    push: (p) => pushed.push(p),
    now: () => (clock += 1),
    pause: async () => undefined,
    agent: {
      run: async (r) => {
        asked.push(r)
        return options.agent ? options.agent(r) : 'an answer'
      }
    },
    mcp: {
      find: async (name) => options.mcp?.find((s) => s.key === name),
      call: (server, name, args, timeoutMs, signal) => callTool(server, name, args, timeoutMs, signal)
    },
    ...options.deps
  })
  store.saveWorkflow({ id: 'w1', name: 'Update KBs', description: '', version: 1, allowAssistant: false, definition: def, createdAt: 1, updatedAt: 1 })
  const begin = (inputs: Record<string, unknown> = {}) => runner.start({ workflowId: 'w1', inputs, startedBy: 'you', folder })
  const events = (id: string) => store.runEvents(id).map((e) => e.event)
  const types = (id: string) => events(id).map((e) => e.type)
  const until = async (id: string, status: RunSummary['status']) => {
    for (let i = 0; i < 400; i++) {
      if (store.getRun(id)?.status === status) return store.getRun(id) as RunSummary
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error(`The run never became ${status}; it is ${store.getRun(id)?.status}. Events: ${types(id).join(', ')}`)
  }
  const approve = (id: string, allow = true) => {
    const card = events(id).find((e) => e.type === 'approval.requested')
    if (card?.type !== 'approval.requested') throw new Error('No approval card')
    runner.respondApproval(id, card.requestId, allow)
  }
  const waitForCard = async (id: string, type: string) => {
    for (let i = 0; i < 400 && !types(id).includes(type as never); i++) await new Promise((r) => setTimeout(r, 15))
  }
  return { store, runner, pushed, begin, events, types, until, approve, waitForCard, asked }
}

describe('running a workflow', () => {
  it('runs the steps in order, each seeing the inputs and what came before, after the person allows it', async () => {
    const { begin, until, approve, events, types, waitForCard, store } = setup(
      chain(
        start([{ name: 'who', default: 'world' }]),
        tool('write', { kind: 'file', op: 'write', path: 'hello.txt', content: 'Hello {{inputs.who}}!' }),
        tool('read', { kind: 'file', op: 'read', path: 'hello.txt' }),
        end('Result: {{nodes.read.output}} in {{run.folder}}')
      )
    )
    const run = await begin({ who: 'Dana' })
    await waitForCard(run.id, 'approval.requested')
    expect(existsSync(join(folder, 'hello.txt'))).toBe(false)
    approve(run.id)
    const done = await until(run.id, 'completed')
    expect(done.output).toBe(`Result: Hello Dana! in ${folder}`)
    expect(readFileSync(join(folder, 'hello.txt'), 'utf8')).toBe('Hello Dana!')
    expect(types(run.id)).toEqual([
      'run.started',
      'approval.requested',
      'approval.resolved',
      'node.started', 'node.completed', // start
      'node.started', 'node.completed', // write
      'node.started', 'node.completed', // read
      'node.started', 'node.completed', // end
      'run.completed'
    ])
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', startedBy: 'you', inputs: { who: 'Dana' }, version: 1 })
    expect(store.getRun(run.id)?.finishedAt).toBeGreaterThan(done.startedAt)
    const card = events(run.id)[1]
    expect(card).toMatchObject({ type: 'approval.requested', actions: [{ nodeId: 'write', kind: 'file', text: 'Write hello.txt' }] })
  })

  it('shows every command with the inputs filled in, and leaves earlier results as they are written', async () => {
    const { begin, events, waitForCard, runner } = setup(
      chain(
        start([{ name: 'days', type: 'number', default: 30 }]),
        tool('find', { kind: 'shell', command: 'find-old --days {{inputs.days}}' }),
        tool('clean', { kind: 'shell', command: 'remove {{nodes.find.output}}' }),
        tool('call', { kind: 'http', method: 'POST', url: 'https://example.com/hook?d={{inputs.days}}' }),
        end()
      ),
      { deps: { exec: async () => ok('x') } }
    )
    const run = await begin()
    await waitForCard(run.id, 'approval.requested')
    const card = events(run.id).find((e) => e.type === 'approval.requested')
    expect(card?.type === 'approval.requested' && card.actions.map((a) => [a.kind, a.text])).toEqual([
      ['shell', 'find-old --days 30'],
      ['shell', 'remove {{nodes.find.output}}'],
      ['http', 'POST https://example.com/hook?d=30']
    ])
    await runner.cancel(run.id)
  })

  it('does not ask when the run only reads', async () => {
    writeFileSync(join(folder, 'a.txt'), 'abc')
    const { begin, until, types } = setup(chain(start(), tool('read', { kind: 'file', op: 'read', path: 'a.txt' }), end()))
    const run = await begin()
    expect((await until(run.id, 'completed')).output).toBe('abc')
    expect(types(run.id)).not.toContain('approval.requested')
  })

  it('does nothing at all when the person says no', async () => {
    const { begin, until, approve, types } = setup(chain(start(), tool('write', { kind: 'file', op: 'write', path: 'x.txt', content: 'x' }), end()))
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id, false)
    await until(run.id, 'cancelled')
    expect(existsSync(join(folder, 'x.txt'))).toBe(false)
    expect(types(run.id)).toEqual(['run.started', 'approval.requested', 'approval.resolved', 'run.cancelled'])
  })

  it('checks the answers to the start questions, with defaults and types', async () => {
    const def = chain(
      start([
        { name: 'env', type: 'choice', options: ['staging', 'prod'], required: true },
        { name: 'days', type: 'number', default: 7 },
        { name: 'dry', type: 'boolean' }
      ]),
      end('{{inputs.env}} {{inputs.days}} {{inputs.dry}}')
    )
    const { begin, until } = setup(def)
    await expect(begin({})).rejects.toThrow('“env” is needed')
    await expect(begin({ env: 'moon' })).rejects.toThrow('must be one of: staging, prod')
    await expect(begin({ env: 'prod', days: 'lots' })).rejects.toThrow('must be a number')
    const run = await begin({ env: 'prod', dry: 'yes' })
    expect((await until(run.id, 'completed')).output).toBe('prod 7 true')
  })

  it('refuses a workflow that is not valid, and one that is gone', async () => {
    const { begin, runner } = setup({ nodes: [start()], edges: [] })
    await expect(begin()).rejects.toThrow('cannot run')
    await expect(runner.start({ workflowId: 'nope', inputs: {}, startedBy: 'you', folder })).rejects.toThrow('no longer exists')
  })
})

describe('when a step goes wrong', () => {
  const failing = (more: Partial<Extract<WorkflowNode, { type: 'tool' }>> = {}) => tool('boom', { kind: 'shell', command: 'x' }, more)

  it('stops the run by default, and says which step and why', async () => {
    const { begin, until, approve, events, store } = setup(chain(start(), failing(), tool('after', { kind: 'file', op: 'write', path: 'after.txt', content: 'x' }), end()), {
      deps: { exec: async () => ok('', 3, 'it broke badly') }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    const done = await until(run.id, 'failed')
    expect(done.error).toBe('“boom” failed: Exit code 3. it broke badly')
    expect(existsSync(join(folder, 'after.txt'))).toBe(false)
    expect(events(run.id).at(-2)).toMatchObject({ type: 'node.failed', nodeId: 'boom' })
    expect(store.getRun(run.id)?.status).toBe('failed')
  })

  it('goes on after a failure when told to continue, with nothing as that step’s result', async () => {
    const { begin, until, approve, types } = setup(chain(start(), failing({ onError: 'continue' }), end('[{{nodes.boom.output}}]')), { deps: { exec: async () => ok('', 1, 'no') } })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    const done = await until(run.id, 'completed')
    expect(done.output).toBe('[]')
    expect(types(run.id)).toContain('node.skipped')
  })

  it('tries again the number of times asked, and succeeds on a later try', async () => {
    let calls = 0
    const { begin, until, approve, types, events } = setup(chain(start(), failing({ onError: 'retry', retries: 2 }), end()), {
      deps: { exec: async () => (++calls < 3 ? ok('', 1, `try ${calls} failed`) : ok('finally')) }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    expect((await until(run.id, 'completed')).output).toBe('finally')
    expect(calls).toBe(3)
    expect(types(run.id).filter((t) => t === 'node.retrying')).toHaveLength(2)
    expect(events(run.id).filter((e) => e.type === 'node.started').map((e) => (e.type === 'node.started' ? e.attempt : 0))).toEqual([1, 1, 2, 3, 1])
  })

  it('fails after the last try when every try fails', async () => {
    let calls = 0
    const { begin, until, approve } = setup(chain(start(), failing({ onError: 'retry', retries: 1 }), end()), { deps: { exec: async () => (calls++, ok('', 2, 'nope')) } })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    expect((await until(run.id, 'failed')).error).toContain('nope')
    expect(calls).toBe(2)
  })

  it('stops a step that takes longer than its time limit', async () => {
    const { begin, until, approve } = setup(chain(start(), failing({ timeoutSec: 1 }), end()), {
      deps: {
        exec: (_f, _a, o) =>
          new Promise((resolve) => o?.signal?.addEventListener('abort', () => resolve({ ...ok(), code: null, cancelled: true }), { once: true }))
      }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    expect((await until(run.id, 'failed')).error).toBe('“boom” failed: It took longer than 1 seconds.')
  }, 15_000)

  it('stops when the person cancels, even in the middle of a step', async () => {
    let started = false
    const { begin, until, approve, runner, types } = setup(chain(start(), failing(), end()), {
      deps: {
        exec: (_f, _a, o) =>
          new Promise((resolve) => {
            started = true
            o?.signal?.addEventListener('abort', () => resolve({ ...ok(), code: null, cancelled: true }), { once: true })
          })
      }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 15))
    await runner.cancel(run.id)
    await until(run.id, 'cancelled')
    expect(types(run.id).at(-1)).toBe('run.cancelled')
  })

  it('refuses a file outside the folder the run works in', async () => {
    const { begin, until } = setup(chain(start(), tool('read', { kind: 'file', op: 'read', path: '../secret.txt' }), end()))
    const run = await begin()
    expect((await until(run.id, 'failed')).error).toContain('outside the folder')
  })

  it('marks a run that was going when Celeste closed', async () => {
    const { begin, until, runner, store } = setup(chain(start(), tool('write', { kind: 'file', op: 'write', path: 'x', content: 'x' }), end()))
    const run = await begin()
    await until(run.id, 'waiting')
    // A new Celeste starts with the old record still saying "waiting".
    const fresh = new WorkflowRunner({ store, push: () => undefined, agent: { run: async () => '' }, mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) } })
    fresh.markAbandoned()
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: 'Celeste was closed while this was running.' })
    await runner.cancel(run.id)
  })
})

describe('the kinds of tool step', () => {
  it('runs a real command in the run’s folder', async () => {
    writeFileSync(join(folder, 'here.txt'), 'x')
    const command = process.platform === 'win32' ? 'Get-ChildItem -Name' : 'ls'
    const { begin, until, approve } = setup(chain(start(), tool('list', { kind: 'shell', command }), end()))
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    expect((await until(run.id, 'completed')).output).toContain('here.txt')
  })

  it('calls a web address with the inputs in it, and fails on a bad answer', async () => {
    const seen: string[] = []
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      seen.push(`${init.method} ${url.href} ${init.body ?? ''} ${(init.headers as Record<string, string>)['X-Token']}`)
      return String(url).includes('bad') ? new Response('no such thing', { status: 404, statusText: 'Not Found' }) : new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    const def = (host: string) => chain(start([{ name: 'id', default: '7' }]), tool('call', { kind: 'http', method: 'POST', url: `https://${host}/items/{{inputs.id}}`, headers: { 'X-Token': 't-{{inputs.id}}' }, body: '{"id":"{{inputs.id}}"}' }), end())
    const good = setup(def('api.test'), { deps: { fetch: fakeFetch } })
    const r1 = await good.begin()
    await good.until(r1.id, 'waiting')
    good.approve(r1.id)
    expect((await good.until(r1.id, 'completed')).output).toBe('{"ok":true}')
    expect(seen[0]).toBe('POST https://api.test/items/7 {"id":"7"} t-7')

    const bad = setup(def('bad.test'), { deps: { fetch: fakeFetch } })
    const r2 = await bad.begin()
    await bad.until(r2.id, 'waiting')
    bad.approve(r2.id)
    expect((await bad.until(r2.id, 'failed')).error).toBe('“call” failed: The server answered 404 Not Found. no such thing')
  })

  it('refuses an address that is not http or https', async () => {
    const { begin, until, approve } = setup(chain(start(), tool('call', { kind: 'http', method: 'GET', url: 'file:///etc/passwd' }), end()))
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    expect((await until(run.id, 'failed')).error).toContain('Only http and https')
  })

  describe('an MCP tool', () => {
    const fixture: ResolvedMcpServer = {
      key: 'fixture-tools',
      type: 'stdio',
      command: process.execPath,
      args: [join(process.cwd(), 'scripts', 'lib', 'mcp-fixture.mjs')],
      env: { FIXTURE_TOKEN: 'abc123' },
      headers: {}
    }

    it('is called with the inputs in its arguments, and its answer is the step’s result', async () => {
      const { begin, until, approve } = setup(
        chain(start([{ name: 'word', default: 'quiet' }]), tool('shout', { kind: 'mcp', server: 'fixture-tools', tool: 'shout', args: { text: '{{inputs.word}} please' } }), tool('who', { kind: 'mcp', server: 'fixture-tools', tool: 'whoami', args: {} }), end('{{nodes.shout.output}} / {{nodes.who.output}}')),
        { mcp: [fixture] }
      )
      const run = await begin()
      await until(run.id, 'waiting')
      approve(run.id)
      expect((await until(run.id, 'completed')).output).toBe('QUIET PLEASE / token=abc123')
    }, 30_000)

    it('fails the step when the tool reports an error', async () => {
      const { begin, until, approve } = setup(chain(start(), tool('boom', { kind: 'mcp', server: 'fixture-tools', tool: 'boom', args: {} }), end()), { mcp: [fixture] })
      const run = await begin()
      await until(run.id, 'waiting')
      approve(run.id)
      expect((await until(run.id, 'failed')).error).toBe('“boom” failed: It broke on purpose.')
    }, 30_000)

    it('does not start when the server is not among the person’s tools', async () => {
      const { begin } = setup(chain(start(), tool('x', { kind: 'mcp', server: 'missing', tool: 't', args: {} }), end()))
      await expect(begin()).rejects.toThrow('“missing”, which is not in your tools')
    })
  })

  describe('a command on a device', () => {
    const device = (accessLevel: DeviceRecord['accessLevel']): DeviceRecord => ({ id: 'd1', name: 'build-vm', accessLevel }) as DeviceRecord
    const def = chain(start(), tool('remote', { kind: 'shell', command: 'uptime', deviceId: 'd1' }), end())

    it('is refused before anything runs when the device is read only', async () => {
      const { begin } = setup(def, { deps: { devices: { get: () => device('read'), run: async () => ({ output: '', exitCode: 0, timedOut: false, cancelled: false }) } } })
      await expect(begin()).rejects.toThrow('build-vm, which is read only')
    })

    it('runs on the device when it allows commands, and the card says where', async () => {
      const ran: string[] = []
      const { begin, until, approve, events } = setup(def, {
        deps: { devices: { get: () => device('ask'), run: async (_d, command) => (ran.push(command), { output: 'up 3 days\n', exitCode: 0, timedOut: false, cancelled: false }) } }
      })
      const run = await begin()
      await until(run.id, 'waiting')
      expect(events(run.id)[1]).toMatchObject({ type: 'approval.requested', actions: [{ kind: 'shell', where: 'build-vm', text: 'uptime' }] })
      approve(run.id)
      expect((await until(run.id, 'completed')).output).toBe('up 3 days')
      expect(ran).toEqual(['uptime'])
    })
  })
})

describe('an agent step', () => {
  const agent = (more: Partial<Extract<WorkflowNode, { type: 'agent' }>> = {}): WorkflowNode => ({ id: 'summarize', type: 'agent', name: 'Summarize', prompt: 'Summarize this', ...more })

  it('is asked with the earlier results filled in, and its answer is the step’s result', async () => {
    const { begin, until, approve, asked } = setup(chain(start(), tool('find', { kind: 'shell', command: 'x' }), agent({ prompt: 'Summarize: {{nodes.find.output}}', model: 'm1', approval: 'edits' }), end()), {
      deps: { exec: async () => ok('three old files') },
      agent: async () => '  They are old.  '
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    expect((await until(run.id, 'completed')).output).toBe('They are old.')
    expect(asked[0]).toMatchObject({ prompt: 'Summarize: three old files', model: 'm1', approval: 'edits', cwd: folder })
  })

  it('shows the assistant’s own prompt on the card, with the approval mode it will use', async () => {
    const { begin, until, events } = setup(chain(start(), agent({ prompt: 'Do the thing', approval: 'auto' }), end()))
    const run = await begin()
    await until(run.id, 'waiting')
    expect(events(run.id)[1]).toMatchObject({ type: 'approval.requested', actions: [{ kind: 'agent', text: 'Ask the assistant (tools: auto): Do the thing' }] })
  })

  it('can answer in JSON that later steps read field by field, and fails when it does not', async () => {
    const def = (format: 'json' | 'text') => chain(start(), agent({ prompt: 'List', outputFormat: format }), end('count={{nodes.summarize.output.count}}'))
    const good = setup(def('json'), { agent: async () => '```json\n{"count": 4}\n```' })
    const r1 = await good.begin()
    await good.until(r1.id, 'waiting')
    good.approve(r1.id)
    expect((await good.until(r1.id, 'completed')).output).toBe('count=4')

    const bad = setup(def('json'), { agent: async () => 'There are four.' })
    const r2 = await bad.begin()
    await bad.until(r2.id, 'waiting')
    bad.approve(r2.id)
    expect((await bad.until(r2.id, 'failed')).error).toContain('did not answer with JSON')
  })

  it('pauses the run for a question and carries on with the answer', async () => {
    const { begin, until, approve, runner, events, waitForCard, store } = setup(chain(start(), agent({ prompt: 'Which?' }), end()), {
      agent: async (r) => {
        const answers: AskAnswers = await r.askQuestions([{ question: 'Red or blue?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }])
        return `You said ${answers['Red or blue?']?.[0]}`
      }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    await waitForCard(run.id, 'agent.ask')
    expect(store.getRun(run.id)?.status).toBe('waiting')
    const ask = events(run.id).find((e) => e.type === 'agent.ask')
    expect(ask).toMatchObject({ type: 'agent.ask', nodeId: 'summarize' })
    runner.respondAsk(run.id, (ask as { requestId: string }).requestId, { 'Red or blue?': ['Blue'] })
    expect((await until(run.id, 'completed')).output).toBe('You said Blue')
    expect(store.getRun(run.id)?.status).toBe('completed')
  })

  it('pauses for the assistant’s own tool requests, and can be refused', async () => {
    let allowed: boolean | undefined
    const { begin, until, approve, runner, events, waitForCard } = setup(chain(start(), agent(), end()), {
      agent: async (r) => {
        allowed = await r.askApproval('Run a command', 'rm -rf x')
        return allowed ? 'did it' : 'did not'
      }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    await waitForCard(run.id, 'agent.approval')
    const card = events(run.id).find((e) => e.type === 'agent.approval')
    expect(card).toMatchObject({ title: 'Run a command', detail: 'rm -rf x' })
    runner.respondApproval(run.id, (card as { requestId: string }).requestId, false)
    expect((await until(run.id, 'completed')).output).toBe('did not')
    expect(allowed).toBe(false)
  })

  it('stops waiting for a question when the run is cancelled', async () => {
    const { begin, until, approve, runner, waitForCard } = setup(chain(start(), agent(), end()), {
      agent: async (r) => {
        await r.askQuestions([{ question: 'Q?', header: 'Q', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }])
        return 'x'
      }
    })
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    await waitForCard(run.id, 'agent.ask')
    await runner.cancel(run.id)
    await until(run.id, 'cancelled')
  })
})

describe('what the window is told', () => {
  it('gets the run and every event as it happens, in the order they are saved', async () => {
    const { begin, until, approve, pushed, store } = setup(chain(start(), tool('w', { kind: 'file', op: 'write', path: 'a', content: 'x' }), end()))
    const run = await begin()
    await until(run.id, 'waiting')
    approve(run.id)
    await until(run.id, 'completed')
    const eventPushes = pushed.flatMap((p) => (p.type === 'runEvent' ? [p.stored] : []))
    expect(eventPushes).toEqual(store.runEvents(run.id))
    const statuses = pushed.flatMap((p) => (p.type === 'run' ? [p.run.status] : []))
    expect(statuses).toEqual(['running', 'waiting', 'running', 'completed'])
  })
})
