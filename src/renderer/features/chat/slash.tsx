import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Settings, Workflow, X } from 'lucide-react'
import { checkInputs, slugify, type InputDef } from '@shared/workflow'
import { core } from '@/api'
import { cn } from '@/lib/cn'
import { TextInput } from '@/components/ui'
import { useRuns } from '@/stores/runs'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { useWorkflows } from '@/stores/workflows'

/*
 * The "/" menu of the message box. Typing "/" as the first character lists the person's workflows and Celeste's own commands, each
 * tagged with where it comes from. A workflow is chosen as a chip, not as text, so that "run my workflow" and "send this text" can
 * never be confused; its questions appear beside it, and sending runs it in this conversation.
 */

export interface SlashItem {
  id: string
  /** What follows the slash. */
  slug: string
  label: string
  description: string
  source: 'Workflow' | 'Celeste'
  icon: typeof Workflow
}

interface Command extends SlashItem {
  source: 'Celeste'
  run: () => void
}

/** Celeste's own commands. Their names are reserved: a workflow with the same short name still shows, tagged with where it is from. */
function commands(): Command[] {
  const ui = useUi.getState()
  return [
    { id: 'cmd-new', slug: 'new', label: 'New chat', description: 'Start a fresh conversation', source: 'Celeste', icon: Plus, run: () => {
      ui.setMode('chat')
      useSessions.getState().home('chat')
      ui.resetDraft()
    } },
    { id: 'cmd-workflows', slug: 'workflows', label: 'Workflows', description: 'Open your workflows', source: 'Celeste', icon: Workflow, run: () => ui.setMode('workflows') },
    { id: 'cmd-settings', slug: 'settings', label: 'Settings', description: 'Open Celeste’s settings', source: 'Celeste', icon: Settings, run: () => ui.openSettings() },
    { id: 'cmd-search', slug: 'search', label: 'Search', description: 'Search chats and sessions', source: 'Celeste', icon: Search, run: () => ui.setSearchOpen(true) }
  ]
}

/** "/test-app env=staging": the name of the workflow and the answers typed after it. */
export function parseSlash(text: string): { name: string; args: Record<string, string> } | undefined {
  if (!text.startsWith('/')) return undefined
  const [first = '', ...rest] = text.slice(1).trim().split(/\s+/)
  const args: Record<string, string> = {}
  for (const part of rest) {
    const at = part.indexOf('=')
    if (at > 0) args[part.slice(0, at)] = part.slice(at + 1)
  }
  return { name: first.toLowerCase(), args }
}

export interface Chip {
  workflowId: string
  name: string
  inputs: InputDef[]
  values: Record<string, string | boolean>
}

export function useSlash(text: string, sessionId: string | undefined) {
  const list = useWorkflows((s) => s.list)
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [chip, setChip] = useState<Chip | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  // Only while "/" is the first character and the name is still being typed.
  const query = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const items = useMemo<(SlashItem & { run?: () => void; workflowId?: string })[]>(() => {
    if (query === null || chip) return []
    const workflows = list.map((w) => ({ id: `wf-${w.id}`, slug: slugify(w.name), label: w.name, description: w.description || 'Workflow', source: 'Workflow' as const, icon: Workflow, workflowId: w.id }))
    return [...workflows, ...commands()].filter((i) => i.slug.includes(query) || i.label.toLowerCase().includes(query))
  }, [query, list, chip])
  const open = items.length > 0 && dismissed !== text

  useEffect(() => setIndex(0), [query])
  // Leaving it with Escape holds only for that text: anything typed afterwards, or the same thing typed again later, opens it afresh.
  useEffect(() => {
    if (dismissed !== null && dismissed !== text) setDismissed(null)
  }, [text, dismissed])

  /** Chooses a workflow: it becomes a chip, with its questions, once its steps have been read. */
  const choose = async (workflowId: string, args: Record<string, string> = {}) => {
    if (!sessionId) {
      // There is no conversation yet to run it in: open it where it can be run.
      useUi.getState().setMode('workflows')
      void useWorkflows.getState().open(workflowId)
      return
    }
    const w = await core.call('workflows.get', workflowId).catch(() => null)
    if (!w) return
    const start = w.definition.nodes.find((n) => n.type === 'start')
    const inputs = start?.type === 'start' ? start.inputs : []
    setProblem(null)
    setChip({
      workflowId,
      name: w.name,
      inputs,
      values: Object.fromEntries(inputs.map((i) => [i.name, i.name in args ? (i.type === 'boolean' ? args[i.name] === 'true' : (args[i.name] as string)) : i.type === 'boolean' ? i.default === true : i.default === undefined ? '' : String(i.default)]))
    })
  }

  const pick = (item: (typeof items)[number]) => {
    if ('workflowId' in item && item.workflowId) return void choose(item.workflowId)
    if ('run' in item && item.run) item.run()
    return 'command'
  }

  /** Runs the chip's workflow in this conversation. Returns false when it cannot yet, and says why. */
  const run = async (): Promise<boolean> => {
    if (!chip || !sessionId) return false
    try {
      checkInputs(chip.inputs, chip.values)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Check the answers.')
      return false
    }
    const started = await useRuns.getState().startInSession(chip.workflowId, chip.values, sessionId)
    if (started) setChip(null)
    return started
  }

  return { items, open, index, setIndex, query, dismiss: () => setDismissed(text), chip, setChip, problem, setProblem, choose, pick, run }
}

/** The list above the message box. Keyboard: arrows, Enter or Tab to choose, Escape to leave it. */
export function SlashList({ id, items, index, onPick, onHover }: { id: string; items: SlashItem[]; index: number; onPick: (i: number) => void; onHover: (i: number) => void }) {
  return (
    <div role="listbox" id={id} aria-label="Workflows and commands" className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-edge-strong bg-raised-2 p-1.5 shadow-pop">
      {items.map((item, i) => {
        const Icon = item.icon
        return (
          <div
            key={item.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // The message box keeps its focus.
              e.preventDefault()
              onPick(i)
            }}
            className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2', i === index ? 'bg-hover' : '')}
          >
            <Icon className="h-4 w-4 shrink-0 text-ink-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">
                <span className="font-mono text-[13px] text-accent-text">/{item.slug}</span> <span className="text-ink-muted">· {item.label}</span>
              </span>
              <span className="block truncate text-[12.5px] text-ink-muted">{item.description}</span>
            </span>
            <span className="shrink-0 rounded-full border border-edge-strong px-2 py-0.5 text-[11px] text-ink-muted">{item.source}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The chosen workflow above the text box, with its questions. */
export function WorkflowChip({ chip, problem, onChange, onRemove }: { chip: Chip; problem: string | null; onChange: (values: Chip['values']) => void; onRemove: () => void }) {
  return (
    <div role="group" aria-label={`Workflow ${chip.name}`} className="mb-2.5 rounded-lg border border-accent-edge bg-accent-soft/40 p-2.5">
      <div className="flex items-center gap-2">
        <Workflow className="h-4 w-4 text-accent-text" />
        <span className="text-[13.5px] font-medium text-ink">{chip.name}</span>
        <span className="text-xs text-ink-muted">will run in this conversation. Press Enter.</span>
        <button type="button" aria-label={`Remove the workflow ${chip.name}`} onClick={onRemove} className="ml-auto flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {chip.inputs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {chip.inputs.map((i) => {
            const label = i.label || i.name
            return i.type === 'boolean' ? (
              <label key={i.name} className="flex items-center gap-2 text-[13px] text-ink-muted">
                <input type="checkbox" checked={chip.values[i.name] === true} onChange={(e) => onChange({ ...chip.values, [i.name]: e.target.checked })} /> {label}
              </label>
            ) : i.type === 'choice' ? (
              <select key={i.name} aria-label={label} value={String(chip.values[i.name] ?? '')} onChange={(e) => onChange({ ...chip.values, [i.name]: e.target.value })} className="h-8 rounded-md border border-edge bg-field px-2 text-[13px] text-ink">
                <option value="">{label}…</option>
                {(i.options ?? []).map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <TextInput key={i.name} aria-label={label} placeholder={`${label}${i.required ? ' (required)' : ''}`} className="h-8 w-44 text-[13px]" value={String(chip.values[i.name] ?? '')} onChange={(e) => onChange({ ...chip.values, [i.name]: e.target.value })} />
            )
          })}
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-1.5 text-[12.5px] text-danger">
          {problem}
        </p>
      )}
    </div>
  )
}
