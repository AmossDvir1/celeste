import { z } from 'zod'
import type { ApprovalProposal } from '@shared/agent'
import type { AppSettings, McpServerInput, McpServerView, McpStatus, SettingsPatch } from '@shared/api'
import { commandLineOf, ENV_NAME, HEADER_NAME, MAX_ARGS, MAX_PAIRS, mcpSecretName, serverKey } from '@shared/mcp'
import type { InputDef, RunSummary, StartNode, StoredRunEvent, WorkflowDefinition, WorkflowFull, WorkflowNode, WorkflowSummary } from '@shared/workflow'
import { slugify, validateWorkflow } from '@shared/workflow'
import type { Drafted } from '../workflows/draft'
import type { ExtraTool, ExtraTools, ToolResult } from '../workflows/tools'

/*
 * Tools the assistant uses to operate Celeste itself (docs/plans/INNER_TOOLS_PLAN.md). Three levels:
 *   open  reads and changes nothing, so it needs no card and works in plan mode;
 *   light a small change that can be undone, no card, a notice in the chat;
 *   card  creates, installs or touches secrets, so a card asks first.
 * The open tools read. The light tools (`plugin_set_enabled`, `settings_change`) change one small thing that can be changed back, and leave one
 * line in the chat. The card tools (`workflow_draft`, `workflow_edit`, `plugin_install`, `plugin_remove`) raise a card and change nothing until
 * the person presses its button. `offeredHere` holds the rule of section 3a: where nobody can answer a card, they are refused.
 */

export type ToolLevel = 'open' | 'light' | 'card'

/** Where a session runs, as far as the rule for these tools goes. */
export interface Where {
  /** An agent step of a workflow or a scheduled run: nobody is there to answer a card. */
  step(sessionId: string): boolean
}

export const NOT_HERE = 'This needs the person at the computer, so it is not available here.'

/**
 * Null when the tool may be used in this session, else the sentence to give back. A chat driven from the phone is offered all three
 * levels: what a phone cannot answer (a plugin that needs secrets) is refused by that tool, not here.
 */
export function offeredHere(level: ToolLevel, sessionId: string, where: Where): string | null {
  if (level === 'open') return null
  return where.step(sessionId) ? NOT_HERE : null
}

/** The settings the assistant may read. A fixed list, so a key added to the settings later is not shown by accident. */
export const READABLE_SETTINGS = ['theme', 'userName', 'sidebarCollapsed', 'closeToTray', 'desktopControl', 'browserTools', 'browserAllowedSites', 'pinnedModels', 'defaults'] as const

/** What the open tools read. Each is a function of the service that owns the data. */
export interface AppToolsDeps {
  where: Where
  plugins: () => McpServerView[]
  settings: () => AppSettings
  workflows: () => WorkflowSummary[]
  workflow: (id: string) => WorkflowFull | null
  runs: (workflowId?: string) => RunSummary[]
  run: (id: string) => { summary: RunSummary; events: StoredRunEvent[] } | null
  now?: () => number
  /** Raises a proposal card in the chat and waits for the person (SessionService.requestProposal). */
  propose: (sessionId: string, request: { title: string; detail: string; proposal: ApprovalProposal }) => Promise<{ answer: 'accept' | 'deny' } | { answer: 'again'; text: string }>
  /** Has an assistant draft a workflow from words. Nothing is saved. Throws a sentence when no assistant is connected or the draft failed. */
  draft: (text: string) => Promise<Drafted>
  /** The same for a change to a workflow the person has: the draft is the whole changed workflow. */
  draftEdit: (workflowId: string, text: string) => Promise<Drafted>
  saveWorkflow: (input: { id?: string; name: string; description: string; definition: WorkflowDefinition }) => WorkflowFull
  /** Changes settings the way the window does (the caller has already checked the keys). */
  changeSettings: (patch: SettingsPatch) => AppSettings
  /** One line in the chat about what a light tool changed. */
  note: (sessionId: string, text: string) => void
  /** A plain yes or no card (SessionService.requestApproval). */
  confirm: (sessionId: string, request: { title: string; detail: string }) => Promise<boolean>
  mcp: {
    /** What saving would store: throws the sentence a save would (a name in use, an address that is not one). */
    check: (input: McpServerInput) => McpServerView
    save: (input: McpServerInput) => Promise<McpServerView>
    test: (id: string) => Promise<McpStatus>
    setEnabled: (id: string, enabled: boolean) => McpServerView
    /** Whether a secret has a value in the secret store. */
    hasSecret: (name: string) => Promise<boolean>
    remove: (id: string) => void
    /** Deletes a stored secret's value. */
    removeSecret: (name: string) => Promise<void>
  }
}

/** A workflow's draft is refused, before any card, when its definition is larger than this. */
const MAX_DEFINITION_BYTES = 1_000_000
/** How many times a person can say "try again" to one draft. */
const MAX_ROUNDS = 3

const MAX_RUNS = 20
const SHOWN = 1500

const cut = (text: string, max = SHOWN): string => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}… (cut: ${t.length - max} more characters)` : t
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

const refuse = (text: string): ToolResult => ({ text, isError: true })

/** The level of each tool, in one place: what a tool may do where is decided by this and nothing else. */
const LEVELS: Record<string, ToolLevel> = {
  plugin_list: 'open',
  settings_read: 'open',
  runs_list: 'open',
  run_get: 'open',
  plugin_set_enabled: 'light',
  settings_change: 'light',
  workflow_draft: 'card',
  workflow_edit: 'card',
  plugin_install: 'card',
  plugin_remove: 'card'
}

/** The settings the assistant may change on its own: how Celeste looks and what it calls the person. Nothing here grants power. */
export const CHANGEABLE_SETTINGS = ['theme', 'sidebarCollapsed', 'userName'] as const
const THEME_WORDS = ['dark', 'light', 'system']
/** Every other key of the settings, so the refusal can say "yours to change" rather than "no such thing". */
const OTHER_SETTINGS = ['wizardDone', 'sidebarWidth', 'closeToTray', 'desktopControl', 'desktopNeverApps', 'browserTools', 'browserAllowedSites', 'pinnedModels', 'defaults']

/** One line about what a step does, for a card. */
export function stepSummary(n: WorkflowNode): string {
  if (n.type === 'agent') return `asks the assistant: ${cut(n.prompt.replace(/\s+/g, ' '), 100)}`
  if (n.type !== 'tool') return ''
  const t = n.tool
  switch (t.kind) {
    case 'shell':
      return `${t.deviceId ? 'on a device: ' : ''}${cut(t.command.replace(/\s+/g, ' '), 120)}`
    case 'http':
      return `${t.method} ${cut(t.url, 120)}`
    case 'file':
      return `${t.op} ${cut(t.path, 120)}`
    case 'mcp':
      return `${t.server}: ${t.tool}`
  }
}

export class AppTools implements ExtraTools {
  constructor(private readonly deps: AppToolsDeps) {}

  list(): ExtraTool[] {
    return [
      {
        name: 'plugin_list',
        title: 'List the plugins',
        description: 'Lists the plugins (outside tools, MCP servers) the user added to Celeste: each one’s name, kind, whether it is on, and how its last test went.',
        shape: {},
        readOnly: true
      },
      {
        name: 'settings_read',
        title: 'Read Celeste’s settings',
        description: 'Reads the settings of the Celeste app: theme, name, tray, desktop and browser switches, allowed sites, pinned models, defaults.',
        shape: {},
        readOnly: true
      },
      {
        name: 'runs_list',
        title: 'List workflow runs',
        description: 'Lists the latest runs of workflows, newest first, with how each ended. Name a workflow to see only its runs. Use run_get for one run’s details.',
        shape: {
          workflow: z.string().min(1).max(200).optional().describe('A workflow’s name, or its short name as in /short-name'),
          limit: z.number().int().min(1).max(MAX_RUNS).optional().describe(`How many, at most ${MAX_RUNS}. Default 10`)
        },
        readOnly: true
      },
      {
        name: 'run_get',
        title: 'Look at one workflow run',
        description: 'Shows one run (an id from runs_list): inputs, result, and the steps that failed with their errors. Use it to say why a run failed.',
        shape: { runId: z.string().min(1).max(100).describe('The run’s id, from runs_list') },
        readOnly: true
      },
      {
        name: 'plugin_set_enabled',
        title: 'Turn a plugin on or off',
        description: 'Turns one of the user’s plugins on or off (not on, if its last test failed). Applies from the next chat.',
        shape: { name: z.string().min(1).max(40), enabled: z.boolean() },
        readOnly: false
      },
      {
        name: 'settings_change',
        title: 'Change a Celeste setting',
        description: 'Changes theme (dark, light, system), sidebarCollapsed (true, false) or userName. Any other setting is the user’s own to change.',
        shape: { key: z.string().min(1).max(40), value: z.union([z.string().max(100), z.boolean()]) },
        readOnly: false
      },
      {
        name: 'workflow_draft',
        title: 'Draft a workflow',
        description: 'Drafts a workflow from a description and shows it to the user, who saves it, asks for changes or declines. Nothing is saved until they press Save.',
        shape: { description: z.string().min(8).max(8000).describe('What the workflow should do, in words') },
        readOnly: false
      },
      {
        name: 'workflow_edit',
        title: 'Change a workflow',
        description: 'Changes one of the user’s workflows as asked. The user sees the result and saves it as a new version, or declines.',
        shape: { name: z.string().min(1).max(200), change: z.string().min(4).max(8000).describe('What to change, in words') },
        readOnly: false
      },
      {
        name: 'plugin_install',
        title: 'Install a plugin',
        description: 'Proposes a plugin (MCP server). The user sees the whole command and presses Install; it starts off and is switched on only if its test passes. Name secrets in envNames or headerNames: the user types the values, never you.',
        shape: {
          name: z.string().min(1).max(40),
          type: z.enum(['stdio', 'http']).describe('stdio: a program. http: a web address'),
          command: z.string().max(500).optional(),
          args: z.array(z.string().max(2000)).max(MAX_ARGS).optional(),
          url: z.string().max(2000).optional(),
          envNames: z.array(z.string()).max(MAX_PAIRS).optional(),
          headerNames: z.array(z.string()).max(MAX_PAIRS).optional(),
          source: z.string().max(500).optional().describe('Where you found it')
        },
        readOnly: false
      },
      {
        name: 'plugin_remove',
        title: 'Remove a plugin',
        description: 'Asks the user to confirm removing one of their plugins and its stored secrets.',
        shape: { name: z.string().min(1).max(40) },
        readOnly: false
      }
    ]
  }

  async call(sessionId: string, name: string, args: unknown): Promise<ToolResult> {
    const level = LEVELS[name]
    if (!level) return refuse(`There is no tool called ${name}.`)
    const no = offeredHere(level, sessionId, this.deps.where)
    if (no) return refuse(no)
    switch (name) {
      case 'workflow_draft':
        return this.workflowDraft(sessionId, args)
      case 'workflow_edit':
        return this.workflowEdit(sessionId, args)
      case 'plugin_install':
        return this.pluginInstall(sessionId, args)
      case 'plugin_remove':
        return this.pluginRemove(sessionId, args)
      case 'plugin_set_enabled':
        return this.pluginSetEnabled(sessionId, args)
      case 'settings_change':
        return this.settingsChange(sessionId, args)
      case 'plugin_list':
        return this.plugins()
      case 'settings_read':
        return this.settings()
      case 'runs_list':
        return this.runsList(args)
      case 'run_get':
        return this.runGet(args)
      default:
        return refuse(`There is no tool called ${name}.`)
    }
  }

  /** A workflow drafted from words, shown on a card, saved only when the person presses Save. Up to three rounds of "try again". */
  private async workflowDraft(sessionId: string, args: unknown): Promise<ToolResult> {
    const parsed = z.object({ description: z.string().min(8).max(8000) }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    return this.proposeWorkflow(sessionId, parsed.data.description, (wanted) => this.deps.draft(wanted))
  }

  /** A change to a workflow the person has, shown on the same card; Save keeps it as a new version of that workflow. */
  private async workflowEdit(sessionId: string, args: unknown): Promise<ToolResult> {
    const parsed = z.object({ name: z.string().min(1).max(200), change: z.string().min(4).max(8000) }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    const found = this.findWorkflow(parsed.data.name)
    if (!found) return refuse(`There is no workflow called “${parsed.data.name}”. Use workflows_list to see them.`)
    return this.proposeWorkflow(sessionId, parsed.data.change, (wanted) => this.deps.draftEdit(found.id, wanted), { id: found.id, name: found.name })
  }

  private findWorkflow(wanted: string): WorkflowSummary | undefined {
    const w = wanted.trim().toLowerCase().replace(/^\//, '')
    return this.deps.workflows().find((x) => x.name.toLowerCase() === w || slugify(x.name) === w)
  }

  /**
   * The loop both workflow tools share: draft, check, show on a card, and on Save write what Core kept (never the assistant's words). `edit`
   * is set when a workflow the person has is being changed: the card says so, and Save keeps a new version of it.
   */
  private async proposeWorkflow(sessionId: string, first: string, draft: (wanted: string) => Promise<Drafted>, edit?: { id: string; name: string }): Promise<ToolResult> {
    const changes: string[] = []
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const wanted = changes.length ? `${first}\n\nThe person looked at a draft and asked for these changes:\n${changes.map((c) => `- ${c}`).join('\n')}` : first
      let drafted: Drafted
      try {
        drafted = await draft(wanted)
      } catch (err) {
        return refuse(err instanceof Error ? err.message : 'The workflow could not be drafted.')
      }
      // Checked again here, so what the card shows is what would be saved, and a draft that is not usable never reaches a card.
      const problems = validateWorkflow(drafted.definition)
      if (problems.length) return refuse(`The draft is not a workflow that works: ${problems[0]}`)
      if (JSON.stringify(drafted.definition).length > MAX_DEFINITION_BYTES) return refuse('The draft is too large to show. Ask for something smaller.')
      const nodes = drafted.definition.nodes
      const steps = nodes.filter((n) => n.type === 'tool' || n.type === 'agent').map((n) => ({ name: n.name, summary: stepSummary(n) }))
      const inputs = (nodes.find((n): n is StartNode => n.type === 'start')?.inputs ?? []).map((i: InputDef) => ({ name: i.name, type: i.type, ...(i.required ? { required: true } : {}) }))
      const proposal: ApprovalProposal = { kind: 'workflow', payload: { name: drafted.name, description: drafted.description, steps, inputs, notes: drafted.notes }, accept: edit ? 'Save changes' : 'Save', ...(round < MAX_ROUNDS ? { retry: 'Try again' } : {}), ...(edit ? { edit: true as const } : {}) }
      const detail = [
        edit ? `A change to “${edit.name}”. Saving keeps the old version too.` : '',
        `${drafted.name}${drafted.description ? `: ${drafted.description}` : ''}`,
        ...steps.map((s, i) => `${i + 1}. ${s.name}${s.summary ? `: ${s.summary}` : ''}`),
        inputs.length ? `Asks for: ${inputs.map((i) => `${i.name} (${i.type}${i.required ? ', required' : ''})`).join(', ')}` : '',
        ...drafted.notes
      ]
        .filter(Boolean)
        .join('\n')
      const answer = await this.deps.propose(sessionId, { title: edit ? `Save the changes to “${edit.name}”?` : `Save the workflow “${drafted.name}”?`, detail, proposal })
      if (answer.answer === 'deny') return { text: 'The user did not save it (or stopped). Nothing was saved. Do not try again unless they ask.', isError: false }
      if (answer.answer === 'again') {
        changes.push(answer.text)
        continue
      }
      try {
        const saved = this.deps.saveWorkflow({ ...(edit ? { id: edit.id } : {}), name: drafted.name, description: drafted.description, definition: drafted.definition })
        return { text: edit ? `Saved the changes to “${saved.name}” as a new version. The user can go back to the old one under Workflows.` : `Saved as “${saved.name}”. The user finds it under Workflows, and can allow you to run it there.`, isError: false }
      } catch (err) {
        return refuse(`It could not be saved: ${err instanceof Error ? err.message : 'unknown reason'}`)
      }
    }
    return { text: 'The user asked for changes three times and did not save a draft. Stop here and ask them what they want.', isError: false }
  }

  /** The server with this name, or the sentence to give back. */
  private pluginNamed(name: string): McpServerView | string {
    const key = serverKey(name)
    return this.deps.plugins().find((p) => serverKey(p.name) === key) ?? `There is no plugin called “${name}”. Use plugin_list to see them.`
  }

  /** Light: on or off, one line in the chat. A plugin is switched on only when its last test passed. */
  private async pluginSetEnabled(sessionId: string, args: unknown): Promise<ToolResult> {
    const parsed = z.object({ name: z.string().min(1).max(40), enabled: z.boolean() }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    const found = this.pluginNamed(parsed.data.name)
    if (typeof found === 'string') return refuse(found)
    if (found.enabled === parsed.data.enabled) return { text: `“${found.name}” is already ${found.enabled ? 'on' : 'off'}. Nothing changed.`, isError: false }
    if (parsed.data.enabled && found.status.state !== 'ok') {
      return refuse(`“${found.name}” cannot be turned on: ${found.status.state === 'failed' ? `its last test failed (${cut(found.status.message, 200)})` : 'it has not passed a test'}. The user can test it in Tools & Integrations.`)
    }
    this.deps.mcp.setEnabled(found.id, parsed.data.enabled)
    this.deps.note(sessionId, `“${found.name}” was turned ${parsed.data.enabled ? 'on' : 'off'}.`)
    return { text: `“${found.name}” is now ${parsed.data.enabled ? 'on' : 'off'}. This applies from the next chat on, not this one. The user can change it back in Tools & Integrations.`, isError: false }
  }

  /** Light: only the three settings that change how Celeste looks, checked here against a fixed list. */
  private settingsChange(sessionId: string, args: unknown): ToolResult {
    const parsed = z.object({ key: z.string().min(1).max(40), value: z.union([z.string().max(100), z.boolean()]) }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    const { key, value } = parsed.data
    if (!(CHANGEABLE_SETTINGS as readonly string[]).includes(key)) {
      return refuse(OTHER_SETTINGS.includes(key) ? `“${key}” is the user’s own to change, in Settings. Tell them where, and do not try to change it.` : `There is no setting called “${key}”. You can change ${CHANGEABLE_SETTINGS.join(', ')}.`)
    }
    const now = this.deps.settings()
    let patch: SettingsPatch
    let said: string
    if (key === 'theme') {
      if (typeof value !== 'string' || !THEME_WORDS.includes(value)) return refuse('The theme must be dark, light or system.')
      if (now.theme === value) return { text: `The theme is already ${value}. Nothing changed.`, isError: false }
      patch = { theme: value as AppSettings['theme'] }
      said = `The theme was changed to ${value}.`
    } else if (key === 'sidebarCollapsed') {
      if (typeof value !== 'boolean') return refuse('sidebarCollapsed must be true or false.')
      if (now.sidebarCollapsed === value) return { text: `The side panel is already ${value ? 'collapsed' : 'open'}. Nothing changed.`, isError: false }
      patch = { sidebarCollapsed: value }
      said = `The side panel was ${value ? 'collapsed' : 'opened'}.`
    } else {
      const name = typeof value === 'string' ? value.trim() : ''
      if (!name) return refuse('The name must be some text.')
      if (now.userName === name) return { text: `The name is already “${name}”. Nothing changed.`, isError: false }
      patch = { userName: name }
      said = `Your name was changed to “${name}”.`
    }
    this.deps.changeSettings(patch)
    this.deps.note(sessionId, said)
    return { text: `${said} The user can change it back in Settings.`, isError: false }
  }

  /** Card: a plain yes or no, with what is removed said on it. */
  private async pluginRemove(sessionId: string, args: unknown): Promise<ToolResult> {
    const parsed = z.object({ name: z.string().min(1).max(40) }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    const found = this.pluginNamed(parsed.data.name)
    if (typeof found === 'string') return refuse(found)
    const secrets = [...found.envNames, ...found.headerNames]
    const detail = [
      commandLineOf(found),
      secrets.length ? `This also deletes the secrets stored for it: ${secrets.join(', ')}.` : 'It has no stored secrets.',
      'It cannot be undone; the user would add it again.'
    ].join('\n')
    const yes = await this.deps.confirm(sessionId, { title: `Remove the plugin “${found.name}”`, detail })
    if (!yes) return { text: 'The user did not remove it (or stopped). Nothing was removed. Do not try again unless they ask.', isError: false }
    // It may have gone, or changed, while the card waited.
    const again = this.deps.plugins().find((p) => p.id === found.id)
    if (!again) return { text: `“${found.name}” is already gone.`, isError: false }
    this.deps.mcp.remove(again.id)
    for (const [kind, names] of [['env', again.envNames], ['header', again.headerNames]] as const) {
      for (const n of names) await this.deps.mcp.removeSecret(mcpSecretName(again.id, kind, n)).catch(() => undefined)
    }
    return { text: `Removed “${again.name}” and its stored secrets. Chats already open keep their tools until they end.`, isError: false }
  }

  /** A plugin proposed on a card. Saved switched off, tested, and switched on only when the test passes. */
  private async pluginInstall(sessionId: string, args: unknown): Promise<ToolResult> {
    const parsed = z
      .object({
        name: z.string().min(1).max(40),
        type: z.enum(['stdio', 'http']),
        command: z.string().max(500).optional(),
        args: z.array(z.string().max(2000)).max(MAX_ARGS).optional(),
        url: z.string().max(2000).optional(),
        envNames: z.array(z.string().regex(ENV_NAME)).max(MAX_PAIRS).optional(),
        headerNames: z.array(z.string().regex(HEADER_NAME)).max(MAX_PAIRS).optional(),
        source: z.string().max(500).optional()
      })
      .safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    // What the person sees is what is checked and saved. Always off at first, whatever was asked.
    const asked: McpServerInput = { name: parsed.data.name, type: parsed.data.type, ...(parsed.data.command ? { command: parsed.data.command } : {}), ...(parsed.data.args ? { args: parsed.data.args } : {}), ...(parsed.data.url ? { url: parsed.data.url } : {}), envNames: parsed.data.envNames ?? [], headerNames: parsed.data.headerNames ?? [], enabled: false }
    let checked: McpServerView
    try {
      checked = this.deps.mcp.check(asked)
    } catch (err) {
      return refuse(err instanceof Error ? err.message : 'That plugin is not valid.')
    }
    const server = { name: checked.name, type: checked.type, ...(checked.command ? { command: checked.command } : {}), ...(checked.args ? { args: checked.args } : {}), ...(checked.url ? { url: checked.url } : {}), envNames: checked.envNames, headerNames: checked.headerNames }
    const secrets = [...server.envNames, ...server.headerNames]
    const source = parsed.data.source?.trim()
    const proposal: ApprovalProposal = { kind: 'plugin', payload: { server, ...(source ? { source } : {}) }, accept: 'Install', ...(secrets.length ? { secrets } : {}) }
    const detail = [
      `${server.name}: ${server.type === 'stdio' ? 'runs this program on this computer, with the user’s rights' : 'connects to this address'}`,
      commandLineOf(server),
      source ? `The assistant says it came from: ${source}` : '',
      secrets.length ? `It needs these secrets, typed on the computer: ${secrets.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    const answer = await this.deps.propose(sessionId, { title: `Install the plugin “${server.name}”?`, detail, proposal })
    if (answer.answer !== 'accept') return { text: 'The user did not install it (or stopped). Nothing was installed. Do not try again unless they ask.', isError: false }

    // The card saved the server switched off when it had secrets to store (it needs the id). Find it by its name, and trust only what matches.
    const key = serverKey(server.name)
    const saved = this.deps.plugins().find((p) => serverKey(p.name) === key)
    let id: string
    if (saved) {
      const same = saved.type === server.type && (saved.command ?? '') === (server.command ?? '') && JSON.stringify(saved.args ?? []) === JSON.stringify(server.args ?? []) && (saved.url ?? '') === (server.url ?? '') && JSON.stringify(saved.envNames) === JSON.stringify(server.envNames) && JSON.stringify(saved.headerNames) === JSON.stringify(server.headerNames)
      if (!same || saved.enabled) return refuse('A plugin with that name is there, but it is not the one that was shown, so nothing was changed.')
      id = saved.id
    } else {
      // No saved server: an answer that did not come from the card on the computer (a phone's Allow). Without secrets, that is fine.
      if (secrets.length) return refuse('This plugin needs secrets, which are typed on the card at the computer. Nothing was installed. Ask the user to answer the card on the computer.')
      try {
        id = (await this.deps.mcp.save({ ...server, enabled: false })).id
      } catch (err) {
        return refuse(`It could not be saved: ${err instanceof Error ? err.message : 'unknown reason'}`)
      }
    }
    for (const [kind, names] of [['env', server.envNames], ['header', server.headerNames]] as const) {
      for (const n of names) {
        if (!(await this.deps.mcp.hasSecret(mcpSecretName(id, kind, n)))) return { text: `“${server.name}” is saved but switched off, because no value was stored for ${n}. The user can add it in Tools & Integrations.`, isError: true }
      }
    }
    const result = await this.deps.mcp.test(id).catch((err: unknown): McpStatus => ({ state: 'failed', message: err instanceof Error ? err.message : String(err), at: 0 }))
    if (result.state !== 'ok') {
      return { text: `“${server.name}” is saved but switched off, because its test did not pass${result.state === 'failed' ? `: ${cut(result.message, 300)}` : ''}. The user can look at it in Tools & Integrations.`, isError: true }
    }
    this.deps.mcp.setEnabled(id, true)
    const tools = result.tools.map((t) => t.name).slice(0, 20)
    return { text: `Installed and switched on. “${server.name}” offers ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}${tools.length ? `: ${tools.join(', ')}` : ''}. They are there from the next chat on, not in this one.`, isError: false }
  }

  private plugins(): ToolResult {
    const found = this.deps.plugins()
    if (found.length === 0) return { text: 'No plugins are added. The user adds them in Tools & Integrations.', isError: false }
    const lines = found.map((p) => {
      const s = p.status
      const test = s.state === 'ok' ? `last test passed (${s.tools.length} tool${s.tools.length === 1 ? '' : 's'})` : s.state === 'failed' ? `last test failed: ${cut(s.message, 200)}` : 'not tested yet'
      return `- ${p.name} (${p.type === 'stdio' ? 'program' : 'web address'}): ${p.enabled ? 'on' : 'off'}, ${test}`
    })
    return { text: lines.join('\n'), isError: false }
  }

  private settings(): ToolResult {
    const all = this.deps.settings() as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of READABLE_SETTINGS) if (key in all) out[key] = all[key]
    return { text: JSON.stringify(out, null, 2), isError: false }
  }

  private runsList(args: unknown): ToolResult {
    const parsed = z.object({ workflow: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(MAX_RUNS).optional() }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    let id: string | undefined
    if (parsed.data.workflow) {
      const found = this.findWorkflow(parsed.data.workflow)
      if (!found) return refuse(`There is no workflow called “${parsed.data.workflow}”.`)
      id = found.id
    }
    const now = (this.deps.now ?? Date.now)()
    const runs = this.deps.runs(id).slice(0, parsed.data.limit ?? 10)
    if (runs.length === 0) return { text: id ? 'That workflow has not run yet.' : 'No workflow has run yet.', isError: false }
    const lines = runs.map((r) => `- ${r.id}: ${r.workflowName}, ${r.status}, started ${ago(now - r.startedAt)} by ${r.startedBy === 'assistant' ? 'the assistant' : 'the user'}${r.error ? `. Error: ${cut(r.error, 200)}` : ''}`)
    return { text: lines.join('\n'), isError: false }
  }

  private runGet(args: unknown): ToolResult {
    const parsed = z.object({ runId: z.string().min(1).max(100) }).safeParse(args ?? {})
    if (!parsed.success) return refuse(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    const run = this.deps.run(parsed.data.runId)
    if (!run) return refuse('There is no run with that id. Use runs_list to see them.')
    const r = run.summary
    const names = new Map((this.deps.workflow(r.workflowId)?.definition.nodes ?? []).map((n) => [n.id, n.name]))
    const label = (nodeId: string) => names.get(nodeId) ?? nodeId
    const steps = run.events.flatMap((e) =>
      e.event.type === 'node.failed' ? [`- ${label(e.event.nodeId)} failed: ${cut(e.event.error, 600)}`] : e.event.type === 'node.skipped' ? [`- ${label(e.event.nodeId)} failed, and the run went on: ${cut(e.event.error, 600)}`] : []
    )
    const inputs = Object.entries(r.inputs)
    const text = [
      `${r.workflowName}, version ${r.version}: ${r.status}. Started by ${r.startedBy === 'assistant' ? 'the assistant' : 'the user'}.`,
      inputs.length ? `Inputs: ${inputs.map(([k, v]) => `${k} = ${cut(String(v), 100)}`).join('; ')}.` : 'It had no inputs.',
      r.error ? `Error: ${cut(r.error)}` : '',
      steps.length ? `Steps that failed:\n${steps.join('\n')}` : '',
      r.output ? `Result:\n${cut(r.output)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    return { text, isError: false }
  }
}
