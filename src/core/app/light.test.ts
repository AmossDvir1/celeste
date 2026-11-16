import { describe, expect, it } from 'vitest'
import type { ApprovalProposal } from '@shared/agent'
import type { AppSettings, McpServerView, SettingsPatch } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { WorkflowDefinition, WorkflowFull, WorkflowSummary } from '@shared/workflow'
import type { Drafted } from '../workflows/draft'
import { AppTools, CHANGEABLE_SETTINGS, type AppToolsDeps } from './tools'

/*
 * Steps 4 and 5 of docs/plans/INNER_TOOLS_PLAN.md: the two light tools (a change, one line in the chat, no card), and the two card tools
 * that change or remove something that exists (`workflow_edit`, `plugin_remove`).
 */

type Answer = { answer: 'accept' | 'deny' } | { answer: 'again'; text: string }
interface Card {
  title: string
  detail: string
  proposal: ApprovalProposal
}

const server = (over: Partial<McpServerView> = {}): McpServerView => ({ id: 'mcp-1', name: 'Playwright', type: 'stdio', command: 'npx', args: ['-y', 'pw'], envNames: ['API_KEY'], headerNames: [], enabled: false, status: { state: 'ok', tools: [{ name: 'a' }], at: 1 }, ...over })

const line = (steps: string[]): WorkflowDefinition => ({
  nodes: [{ id: 'start', type: 'start', name: 'Start', inputs: [] }, ...steps.map((id) => ({ id, type: 'tool' as const, name: id, tool: { kind: 'shell' as const, command: `echo ${id}` } })), { id: 'end', type: 'end', name: 'End' }],
  edges: [{ from: 'start', to: steps[0] as string }, ...steps.slice(1).map((id, i) => ({ from: steps[i] as string, to: id })), { from: steps[steps.length - 1] as string, to: 'end' }]
})

function world(opts: { servers?: McpServerView[]; settings?: Partial<AppSettings> } = {}) {
  const servers = opts.servers ?? [server()]
  let settings = { ...DEFAULT_SETTINGS, theme: 'dark', userName: 'Dana', sidebarCollapsed: false, ...opts.settings } as AppSettings
  const notes: [string, string][] = []
  const patches: SettingsPatch[] = []
  const cards: Card[] = []
  const answers: Answer[] = []
  const confirms: { title: string; detail: string }[] = []
  let confirmAnswer = true
  const removed: string[] = []
  const removedSecrets: string[] = []
  const edits: [string, string][] = []
  const saved: { id?: string; name: string; description: string; definition: WorkflowDefinition }[] = []
  let drafts: Drafted[] = []
  const calls: string[] = []

  const deps: AppToolsDeps = {
    where: { step: (id) => id.startsWith('wf-') },
    plugins: () => servers,
    settings: () => settings,
    workflows: () => [{ id: 'w1', name: 'Nightly backup', description: '', version: 1, allowAssistant: false, createdAt: 1, updatedAt: 1 } as WorkflowSummary],
    workflow: () => null,
    runs: () => [],
    run: () => null,
    propose: async (_s, request) => {
      cards.push(request)
      return answers.shift() ?? { answer: 'deny' }
    },
    draft: async () => {
      throw new Error('not used here')
    },
    draftEdit: async (id, text) => {
      edits.push([id, text])
      return drafts.shift() ?? { name: 'Nightly backup', description: 'Copies the notes', definition: line(['one', 'two']), notes: [] }
    },
    saveWorkflow: (input) => {
      saved.push(input)
      return { ...input, id: input.id ?? 'wf-new', version: 2, allowAssistant: false, createdAt: 1, updatedAt: 1 } as WorkflowFull
    },
    changeSettings: (patch) => {
      patches.push(patch)
      settings = { ...settings, ...patch } as AppSettings
      return settings
    },
    note: (sessionId, text) => void notes.push([sessionId, text]),
    confirm: async (_s, request) => {
      confirms.push(request)
      return confirmAnswer
    },
    mcp: {
      check: () => {
        throw new Error('not used here')
      },
      save: async () => server(),
      test: async () => ({ state: 'unchecked' }),
      setEnabled: (id, enabled) => {
        calls.push(`setEnabled ${id} ${enabled}`)
        const s = servers.find((x) => x.id === id) as McpServerView
        s.enabled = enabled
        return s
      },
      hasSecret: async () => true,
      remove: (id) => {
        removed.push(id)
        servers.splice(0, servers.length, ...servers.filter((s) => s.id !== id))
      },
      removeSecret: async (name) => void removedSecrets.push(name)
    }
  }
  return {
    tools: new AppTools(deps),
    servers,
    notes,
    patches,
    cards,
    answers,
    confirms,
    removed,
    removedSecrets,
    edits,
    saved,
    calls,
    settings: () => settings,
    setDrafts: (d: Drafted[]) => (drafts = d),
    say: (yes: boolean) => (confirmAnswer = yes)
  }
}

describe('plugin_set_enabled (light)', () => {
  it('turns a plugin whose test passed on, and says so in the chat without a card', async () => {
    const w = world()
    const out = await w.tools.call('chat-1', 'plugin_set_enabled', { name: 'playwright', enabled: true })
    expect(out.isError).toBe(false)
    expect(out.text).toContain('now on')
    expect(out.text).toContain('next chat')
    expect(w.calls).toEqual(['setEnabled mcp-1 true'])
    expect(w.notes).toEqual([['chat-1', '“Playwright” was turned on.']])
    expect(w.cards).toHaveLength(0)
    expect(w.confirms).toHaveLength(0)
  })

  it('turns one off, even one whose last test failed', async () => {
    const w = world({ servers: [server({ enabled: true, status: { state: 'failed', message: 'gone', at: 1 } })] })
    const out = await w.tools.call('chat-1', 'plugin_set_enabled', { name: 'Playwright', enabled: false })
    expect(out.isError).toBe(false)
    expect(w.notes[0]?.[1]).toBe('“Playwright” was turned off.')
  })

  it('refuses to turn on a plugin whose last test failed or that was never tested, and changes nothing', async () => {
    for (const status of [{ state: 'failed' as const, message: 'connection refused', at: 1 }, { state: 'unchecked' as const }]) {
      const w = world({ servers: [server({ status })] })
      const out = await w.tools.call('chat-1', 'plugin_set_enabled', { name: 'Playwright', enabled: true })
      expect(out.isError).toBe(true)
      expect(out.text).toContain('cannot be turned on')
      expect(w.calls).toHaveLength(0)
      expect(w.notes).toHaveLength(0)
    }
  })

  it('says nothing in the chat when it is already so, and refuses a name that is not there', async () => {
    const w = world({ servers: [server({ enabled: true })] })
    const same = await w.tools.call('chat-1', 'plugin_set_enabled', { name: 'Playwright', enabled: true })
    expect(same.text).toContain('already on')
    expect(w.notes).toHaveLength(0)
    expect(await w.tools.call('chat-1', 'plugin_set_enabled', { name: 'Nope', enabled: true })).toMatchObject({ isError: true })
    expect(await w.tools.call('chat-1', 'plugin_set_enabled', { name: 'Playwright' })).toMatchObject({ isError: true })
  })

  it('is refused in an agent step of a workflow, where nobody is there', async () => {
    const w = world()
    const out = await w.tools.call('wf-run-1', 'plugin_set_enabled', { name: 'Playwright', enabled: true })
    expect(out).toMatchObject({ isError: true, text: expect.stringContaining('person at the computer') })
    expect(w.calls).toHaveLength(0)
  })
})

describe('settings_change (light): the allow-list', () => {
  it('changes the theme, the side panel and the name, each with one line in the chat', async () => {
    const w = world()
    expect((await w.tools.call('chat-1', 'settings_change', { key: 'theme', value: 'light' })).isError).toBe(false)
    expect((await w.tools.call('chat-1', 'settings_change', { key: 'sidebarCollapsed', value: true })).isError).toBe(false)
    expect((await w.tools.call('chat-1', 'settings_change', { key: 'userName', value: '  Sam  ' })).isError).toBe(false)
    expect(w.patches).toEqual([{ theme: 'light' }, { sidebarCollapsed: true }, { userName: 'Sam' }])
    expect(w.notes.map((n) => n[1])).toEqual(['The theme was changed to light.', 'The side panel was collapsed.', 'Your name was changed to “Sam”.'])
  })

  it('refuses every other key, and the ones that grant power say they are the person’s own', async () => {
    const w = world()
    for (const key of ['desktopControl', 'browserTools', 'browserAllowedSites', 'defaults', 'closeToTray', 'desktopNeverApps', 'wizardDone', 'sidebarWidth', 'pinnedModels']) {
      const out = await w.tools.call('chat-1', 'settings_change', { key, value: true })
      expect(out.isError, key).toBe(true)
      expect(out.text, key).toContain('own to change, in Settings')
    }
    const unknown = await w.tools.call('chat-1', 'settings_change', { key: 'vendors', value: 'x' })
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining('There is no setting called “vendors”') })
    // `__proto__` and friends are just unknown keys.
    expect((await w.tools.call('chat-1', 'settings_change', { key: '__proto__', value: 'x' })).isError).toBe(true)
    expect(w.patches).toHaveLength(0)
    expect(w.notes).toHaveLength(0)
    expect(w.settings().desktopControl).toBe(DEFAULT_SETTINGS.desktopControl)
  })

  it('has exactly three keys it may change', () => {
    expect([...CHANGEABLE_SETTINGS]).toEqual(['theme', 'sidebarCollapsed', 'userName'])
  })

  it('refuses a value of the wrong kind, an empty name and an unknown theme', async () => {
    const w = world()
    for (const args of [{ key: 'theme', value: 'purple' }, { key: 'theme', value: true }, { key: 'sidebarCollapsed', value: 'yes' }, { key: 'userName', value: '   ' }, { key: 'userName', value: true }, { key: 'theme' }]) {
      expect((await w.tools.call('chat-1', 'settings_change', args)).isError, JSON.stringify(args)).toBe(true)
    }
    expect(w.patches).toHaveLength(0)
  })

  it('says nothing and changes nothing when the setting is already so', async () => {
    const w = world()
    expect((await w.tools.call('chat-1', 'settings_change', { key: 'theme', value: 'dark' })).text).toContain('already dark')
    expect((await w.tools.call('chat-1', 'settings_change', { key: 'userName', value: 'Dana' })).text).toContain('already')
    expect(w.patches).toHaveLength(0)
    expect(w.notes).toHaveLength(0)
  })

  it('is refused in an agent step of a workflow', async () => {
    const w = world()
    expect(await w.tools.call('wf-run-1', 'settings_change', { key: 'theme', value: 'light' })).toMatchObject({ isError: true })
    expect(w.patches).toHaveLength(0)
  })
})

describe('plugin_remove (card)', () => {
  it('asks first with the command and the secrets that go too, and removes nothing until yes', async () => {
    const w = world()
    w.say(false)
    const out = await w.tools.call('chat-1', 'plugin_remove', { name: 'Playwright' })
    expect(out).toMatchObject({ isError: false, text: expect.stringContaining('Nothing was removed') })
    expect(w.removed).toHaveLength(0)
    expect(w.removedSecrets).toHaveLength(0)
    // No question mark: the card adds its own.
    expect(w.confirms[0]?.title).toBe('Remove the plugin “Playwright”')
    expect(w.confirms[0]?.detail).toContain('npx -y pw')
    expect(w.confirms[0]?.detail).toContain('API_KEY')
  })

  it('on yes removes the plugin and each of its stored secrets', async () => {
    const w = world({ servers: [server({ envNames: ['API_KEY'], headerNames: ['X-Token'] })] })
    const out = await w.tools.call('chat-1', 'plugin_remove', { name: 'Playwright' })
    expect(out).toMatchObject({ isError: false, text: expect.stringContaining('Removed “Playwright”') })
    expect(w.removed).toEqual(['mcp-1'])
    expect(w.removedSecrets).toEqual(['mcp.mcp-1.env.API_KEY', 'mcp.mcp-1.header.X-Token'])
  })

  it('refuses a name that is not there, and is refused in an agent step', async () => {
    const w = world()
    expect(await w.tools.call('chat-1', 'plugin_remove', { name: 'Nope' })).toMatchObject({ isError: true })
    expect(await w.tools.call('wf-run-1', 'plugin_remove', { name: 'Playwright' })).toMatchObject({ isError: true, text: expect.stringContaining('person at the computer') })
    expect(w.confirms).toHaveLength(0)
    expect(w.removed).toHaveLength(0)
  })
})

describe('workflow_edit (card)', () => {
  it('drafts the change, shows it on a card marked as a change, and saves a new version of that workflow only on Save', async () => {
    const w = world()
    w.answers.push({ answer: 'accept' })
    const out = await w.tools.call('chat-1', 'workflow_edit', { name: 'nightly backup', change: 'Add a step that zips the folder' })
    expect(out).toMatchObject({ isError: false, text: expect.stringContaining('new version') })
    expect(w.edits).toEqual([['w1', 'Add a step that zips the folder']])
    expect(w.cards[0]?.title).toBe('Save the changes to “Nightly backup”?')
    expect(w.cards[0]?.detail).toContain('A change to “Nightly backup”')
    expect(w.cards[0]?.proposal).toMatchObject({ kind: 'workflow', accept: 'Save changes', retry: 'Try again', edit: true })
    // Saved over the same workflow (its id), from the definition Core kept.
    expect(w.saved).toHaveLength(1)
    expect(w.saved[0]).toMatchObject({ id: 'w1', name: 'Nightly backup' })
    expect(w.saved[0]?.definition).toEqual(line(['one', 'two']))
  })

  it('saves nothing on no, and a Try again drafts again with what the person typed', async () => {
    const w = world()
    w.answers.push({ answer: 'again', text: 'also email me' }, { answer: 'deny' })
    const out = await w.tools.call('chat-1', 'workflow_edit', { name: 'Nightly backup', change: 'Add a zip step' })
    expect(out.text).toContain('did not save it')
    expect(w.saved).toHaveLength(0)
    expect(w.edits).toHaveLength(2)
    expect(w.edits[1]?.[1]).toContain('also email me')
    expect(w.edits[1]?.[1]).toContain('Add a zip step')
  })

  it('refuses an unknown workflow before any draft, and a draft that is not a workflow before any card', async () => {
    const w = world()
    expect(await w.tools.call('chat-1', 'workflow_edit', { name: 'Nope', change: 'Add a zip step' })).toMatchObject({ isError: true, text: expect.stringContaining('There is no workflow called “Nope”') })
    expect(w.edits).toHaveLength(0)
    w.setDrafts([{ name: 'Broken', description: '', definition: { nodes: [], edges: [] }, notes: [] }])
    expect((await w.tools.call('chat-1', 'workflow_edit', { name: 'Nightly backup', change: 'Add a zip step' })).isError).toBe(true)
    expect(w.cards).toHaveLength(0)
  })

  it('is refused in an agent step of a workflow', async () => {
    const w = world()
    expect(await w.tools.call('wf-run-1', 'workflow_edit', { name: 'Nightly backup', change: 'Add a zip step' })).toMatchObject({ isError: true })
    expect(w.edits).toHaveLength(0)
  })
})
