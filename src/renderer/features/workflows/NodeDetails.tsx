import { useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, Plus, Trash2 } from 'lucide-react'
import type { ApprovalMode, VendorId } from '@shared/agent'
import type { AgentNode, InputDef, InputType, OnError, StartNode, ToolNode, ToolSpec, WorkflowDefinition, WorkflowNode } from '@shared/workflow'
import { blankTool, moveStep, orderedNodes, referencesAvailable, removeStep, renameStep, updateStep } from '@shared/workflow-edit'
import { cn } from '@/lib/cn'
import { Field, SelectField, TextArea } from '@/components/form'
import { PanelCard } from '@/components/PanelCard'
import { Button, Checkbox, IconButton, Switch, TextInput } from '@/components/ui'
import { APPROVAL_OPTIONS, VENDORS } from '@/lib/vendors'
import { useDevices } from '@/stores/devices'
import { useMcp } from '@/stores/mcp'
import { useModels } from '@/stores/models'
import { useVendors } from '@/stores/vendors'
import { useWorkflows } from '@/stores/workflows'
import { metaOf } from './steps'

const small = 'h-9 text-[13px]'

/** A section that opens and closes, like "Advanced settings" in the design. */
function Fold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-xl border border-edge bg-field/50">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-11 w-full items-center justify-between px-3.5 text-[14px] text-ink">
        {title}
        <ChevronDown className={cn('h-4 w-4 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-3 border-t border-edge/70 p-3.5">{children}</div>}
    </section>
  )
}

/** A short hint under a text box that may use `{{ }}`: what can go between the braces. */
function Refs({ def, id }: { def: WorkflowDefinition; id: string }) {
  return <>You can use {referencesAvailable(def, id).join(' ')}.</>
}

/** Name and value pairs: the headers of a web request, the inputs of a tool. */
function Pairs({ label, value, onChange, namePlaceholder }: { label: string; value: Record<string, string | number | boolean>; onChange: (v: Record<string, string | number | boolean>) => void; namePlaceholder: string }) {
  const rows = Object.entries(value)
  // Text that is plainly a number or yes/no is passed on as one, which is what tools that take a number expect.
  const typed = (text: string): string | number | boolean => (text === 'true' ? true : text === 'false' ? false : /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) ? Number(text) : text)
  const set = (i: number, name: string, text: string) => onChange(Object.fromEntries(rows.map(([k, v], j) => (j === i ? [name, typed(text)] : [k, v]))))
  return (
    <div className="space-y-2">
      <div className="text-[13px] text-ink-muted">{label}</div>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <TextInput className={cn(small, 'w-2/5')} aria-label={`${label}, name ${i + 1}`} placeholder={namePlaceholder} value={k} onChange={(e) => set(i, e.target.value, String(v))} />
          <TextInput className={small} aria-label={`${label}, value ${i + 1}`} placeholder="Value" value={String(v)} onChange={(e) => set(i, k, e.target.value)} />
          <IconButton label={`Remove ${k || 'this'} from ${label.toLowerCase()}`} size="sm" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange({ ...value, [`${rows.length ? 'name' + (rows.length + 1) : 'name'}`]: '' })}>
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    </div>
  )
}

function StartForm({ node, patch }: { node: StartNode; patch: (change: Partial<StartNode>) => void }) {
  const setInput = (i: number, change: Partial<InputDef>) => patch({ inputs: node.inputs.map((x, j) => (j === i ? { ...x, ...change } : x)) })
  return (
    <section aria-label="Inputs" className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] text-ink">Inputs</h3>
        <Button variant="secondary" size="sm" onClick={() => patch({ inputs: [...node.inputs, { name: `input${node.inputs.length + 1}`, type: 'text' }] })}>
          <Plus className="h-3.5 w-3.5" /> Add input
        </Button>
      </div>
      {node.inputs.length === 0 && <p className="text-[13px] text-ink-muted">Questions asked when the workflow is started, which steps can use. None yet.</p>}
      {node.inputs.map((input, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-edge bg-field/50 p-3">
          <div className="flex items-center gap-1.5">
            <TextInput className={small} aria-label={`Input ${i + 1} name`} placeholder="name_used_in_steps" value={input.name} onChange={(e) => setInput(i, { name: e.target.value })} />
            <IconButton label={`Remove the input ${input.name}`} size="sm" onClick={() => patch({ inputs: node.inputs.filter((_, j) => j !== i) })}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          <div className="flex gap-1.5">
            <TextInput className={small} aria-label={`Input ${i + 1} label`} placeholder="Question shown to the person" value={input.label ?? ''} onChange={(e) => setInput(i, { label: e.target.value })} />
            <div className="w-32 shrink-0">
              <SelectField className={small} aria-label={`Input ${i + 1} type`} value={input.type} onChange={(e) => setInput(i, { type: e.target.value as InputType })}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Yes / no</option>
                <option value="choice">Choice</option>
              </SelectField>
            </div>
          </div>
          {input.type === 'choice' && (
            <TextInput className={small} aria-label={`Input ${i + 1} options`} placeholder="Options, separated by commas" value={(input.options ?? []).join(', ')} onChange={(e) => setInput(i, { options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })} />
          )}
          <div className="flex items-center gap-3">
            <TextInput className={small} aria-label={`Input ${i + 1} default`} placeholder="Default" value={input.default === undefined ? '' : String(input.default)} onChange={(e) => setInput(i, { default: e.target.value === '' ? undefined : input.type === 'number' && e.target.value.trim() !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} />
            <div className="shrink-0">
              <Checkbox label="Required" checked={input.required === true} onChange={(required) => setInput(i, { required })} />
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}

function ToolForm({ node, def, patch }: { node: ToolNode; def: WorkflowDefinition; patch: (change: Partial<ToolNode>) => void }) {
  const t = node.tool
  const set = (tool: ToolSpec) => patch({ tool })
  const devices = useDevices((s) => s.devices).filter((d) => d.accessLevel !== 'read')
  const servers = useMcp((s) => s.servers)
  return (
    <>
      <Field label="What it does">
        {(id) => (
          <SelectField id={id} value={t.kind} onChange={(e) => set(blankTool(e.target.value as ToolSpec['kind']))}>
            <option value="shell">Run a command</option>
            <option value="http">Call a web address</option>
            <option value="file">Read or write a file</option>
            <option value="mcp">Use a tool from your tools</option>
          </SelectField>
        )}
      </Field>

      {t.kind === 'shell' && (
        <>
          <Field label="Command" hint="Shown to you before the run, and run only if you allow it.">
            {(id) => <TextArea id={id} rows={4} className="font-mono text-[13px]" value={t.command} onChange={(e) => set({ ...t, command: e.target.value })} />}
          </Field>
          <p className="-mt-1 text-xs text-ink-faint">
            <Refs def={def} id={node.id} />
          </p>
          <Field label="Runs on">
            {(id) => (
              <SelectField id={id} value={t.deviceId ?? ''} onChange={(e) => set({ ...t, deviceId: e.target.value || undefined })}>
                <option value="">This computer</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                {t.deviceId && !devices.some((d) => d.id === t.deviceId) && <option value={t.deviceId}>A device that is read only or gone</option>}
              </SelectField>
            )}
          </Field>
          {!t.deviceId && (
            <Field label="Folder" hint="Inside the folder the run works in. Empty: that folder itself.">
              {(id) => <TextInput id={id} value={t.cwd ?? ''} onChange={(e) => set({ ...t, cwd: e.target.value || undefined })} />}
            </Field>
          )}
        </>
      )}

      {t.kind === 'http' && (
        <>
          <div className="flex gap-2">
            <Field label="Method" className="w-28 shrink-0">
              {(id) => (
                <SelectField id={id} value={t.method} onChange={(e) => set({ ...t, method: e.target.value as typeof t.method })}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </SelectField>
              )}
            </Field>
            <Field label="Web address" className="min-w-0 flex-1">
              {(id) => <TextInput id={id} placeholder="https://" value={t.url} onChange={(e) => set({ ...t, url: e.target.value })} />}
            </Field>
          </div>
          <Pairs
            label="Headers"
            namePlaceholder="Header"
            value={t.headers ?? {}}
            onChange={(v) => set({ ...t, headers: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) })}
          />
          <p className="-mt-1 text-xs text-ink-faint">A header is part of the workflow, and goes with it when it is shared. Do not put a password in it.</p>
          {t.method !== 'GET' && (
            <Field label="Body">{(id) => <TextArea id={id} rows={4} className="font-mono text-[13px]" value={t.body ?? ''} onChange={(e) => set({ ...t, body: e.target.value || undefined })} />}</Field>
          )}
        </>
      )}

      {t.kind === 'file' && (
        <>
          <Field label="Action">
            {(id) => (
              <SelectField id={id} value={t.op} onChange={(e) => set({ ...t, op: e.target.value as typeof t.op })}>
                <option value="read">Read it</option>
                <option value="write">Write it (replaces what is there)</option>
                <option value="append">Add to the end of it</option>
              </SelectField>
            )}
          </Field>
          <Field label="File" hint="Inside the folder the run works in.">
            {(id) => <TextInput id={id} value={t.path} onChange={(e) => set({ ...t, path: e.target.value })} />}
          </Field>
          {t.op !== 'read' && (
            <Field label="Content">{(id) => <TextArea id={id} rows={4} className="font-mono text-[13px]" value={t.content ?? ''} onChange={(e) => set({ ...t, content: e.target.value })} />}</Field>
          )}
        </>
      )}

      {t.kind === 'mcp' && (
        <>
          <Field label="Tools of" hint={servers.length ? undefined : 'You have not added any tools yet. Add them in Settings, Tools & Integrations.'}>
            {(id) => (
              <SelectField id={id} value={t.server} onChange={(e) => set({ ...t, server: e.target.value })}>
                <option value="">Choose…</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                    {s.enabled ? '' : ' (off)'}
                  </option>
                ))}
                {t.server && !servers.some((s) => s.name === t.server) && <option value={t.server}>{t.server} (not in your tools)</option>}
              </SelectField>
            )}
          </Field>
          <Field label="Tool name">{(id) => <TextInput id={id} value={t.tool} onChange={(e) => set({ ...t, tool: e.target.value })} />}</Field>
          <Pairs label="Inputs" namePlaceholder="Name" value={t.args} onChange={(args) => set({ ...t, args })} />
          <p className="-mt-1 text-xs text-ink-faint">
            <Refs def={def} id={node.id} />
          </p>
        </>
      )}
    </>
  )
}

/** Whether the step may use this computer's screen, mouse and keyboard, and how much of it. */
function ComputerSettings({ node, patch }: { node: AgentNode; patch: (change: Partial<AgentNode>) => void }) {
  const on = !!node.computer
  const kind = node.computer?.app !== undefined ? 'app' : node.computer?.window !== undefined ? 'window' : 'screen'
  const value = node.computer?.app ?? node.computer?.window ?? ''
  const set = (k: 'screen' | 'app' | 'window', v: string) => patch({ computer: k === 'screen' ? {} : k === 'app' ? { app: v } : { window: v } })
  return (
    <section className="space-y-3 rounded-xl border border-edge bg-field/50 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] text-ink">Use the computer</div>
          <p className="mt-0.5 text-xs text-ink-faint">The assistant may see the screen and use the mouse and keyboard in this step. You are asked when the step starts, and a bar with Stop stays on screen. Needs “Desktop control” switched on in Settings.</p>
        </div>
        <Switch label="Use the computer" checked={on} onCheckedChange={(v) => patch({ computer: v ? {} : undefined })} />
      </div>
      {on && (
        <>
          <Field label="It may use" hint="One program or window hides the rest of the screen from it, and is safer.">
            {(id) => (
              <SelectField id={id} value={kind} onChange={(e) => set(e.target.value as 'screen' | 'app' | 'window', '')}>
                <option value="screen">The whole screen</option>
                <option value="app">One program</option>
                <option value="window">One window</option>
              </SelectField>
            )}
          </Field>
          {kind !== 'screen' && (
            <Field label={kind === 'app' ? 'Program' : 'Part of the window’s title'} hint={kind === 'app' ? 'For example: chrome, notepad, excel. It must be open when the step starts.' : 'It must be open when the step starts.'}>
              {(id) => <TextInput id={id} value={value} placeholder={kind === 'app' ? 'chrome' : 'Inbox - Mail'} onChange={(e) => set(kind, e.target.value)} />}
            </Field>
          )}
        </>
      )}
    </section>
  )
}

function AgentForm({ node, def, patch }: { node: AgentNode; def: WorkflowDefinition; patch: (change: Partial<AgentNode>) => void }) {
  const vendors = useVendors((s) => s.vendors)
  const models = useModels((s) => s.list)
  const connected = (['copilot', 'claude'] as VendorId[]).filter((v) => vendors[v].status === 'connected')
  const value = node.model ?? ''
  return (
    <>
      <Field label="Prompt" hint="What the assistant is asked.">
        {(id) => <TextArea id={id} rows={5} value={node.prompt} onChange={(e) => patch({ prompt: e.target.value })} />}
      </Field>
      <p className="-mt-1 text-xs text-ink-faint">
        <Refs def={def} id={node.id} />
      </p>
      <ComputerSettings node={node} patch={patch} />
      <Field label="Model" hint="Automatic uses the first assistant that is connected.">
        {(id) => (
          <SelectField
            id={id}
            value={value}
            onChange={(e) => {
              const model = models.find((m) => m.id === e.target.value)
              patch({ model: e.target.value || undefined, vendor: model?.vendor, effort: undefined })
            }}
          >
            <option value="">Automatic</option>
            {connected.map((v) => (
              <optgroup key={v} label={VENDORS[v].menuLabel}>
                {models.filter((m) => m.vendor === v).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
            {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
          </SelectField>
        )}
      </Field>
      <Field label="Its own tools" hint="How the assistant’s commands and edits are approved while it works. Any request it makes is shown to you in the run.">
        {(id) => (
          <SelectField id={id} value={node.approval ?? 'ask'} onChange={(e) => patch({ approval: e.target.value as ApprovalMode })}>
            {APPROVAL_OPTIONS.filter((o) => !o.developOnly).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        )}
      </Field>
      <Field label="Answer">
        {(id) => (
          <SelectField id={id} value={node.outputFormat ?? 'text'} onChange={(e) => patch({ outputFormat: e.target.value as 'text' | 'json' })}>
            <option value="text">Text</option>
            <option value="json">JSON, so later steps can use its fields</option>
          </SelectField>
        )}
      </Field>
    </>
  )
}

/** The panel at the right of the canvas: everything about the selected step. */
export function NodeDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const def = useWorkflows((s) => s.draft?.definition)
  const edit = useWorkflows((s) => s.edit)
  const select = useWorkflows((s) => s.selectNode)
  if (!def) return null
  const node = def.nodes.find((n) => n.id === id)
  if (!node) return null
  const meta = metaOf(node)
  const Icon = meta.icon
  const order = orderedNodes(def)
  const index = order.findIndex((n) => n.id === id)
  const fixed = node.type === 'start' || node.type === 'end'
  const patch = <T extends WorkflowNode>(change: Partial<T>) => edit((d) => updateStep(d, id, (n) => ({ ...n, ...change }) as WorkflowNode))
  const stepOptions = node.type === 'tool' || node.type === 'agent' ? node : undefined
  const onError: OnError = stepOptions?.onError ?? 'stop'

  return (
    <PanelCard title="Step details" onClose={onClose} className="h-full w-[400px] shrink-0" bodyClassName="space-y-4 p-4">
      <div className="flex items-start gap-3 rounded-xl border border-edge bg-field/50 p-3">
        <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-lg', meta.tile)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <TextInput
            className="h-9 text-[14px] font-medium"
            aria-label="Step name"
            value={node.name}
            onChange={(e) => patch({ name: e.target.value })}
            // The id other steps use follows the name once the person has finished typing it, so typing is never interrupted.
            onBlur={() => {
              const next = renameStep(def, id, node.name)
              if (next === def) return
              const renamed = next.nodes.find((n) => !def.nodes.some((o) => o.id === n.id))
              edit(() => next)
              if (renamed) select(renamed.id)
            }}
          />
          <p className="text-xs text-ink-faint">{meta.label}</p>
        </div>
      </div>

      <Field label="Description" hint="Shown on the canvas under the name.">
        {(fid) => <TextArea id={fid} rows={2} value={node.description ?? ''} onChange={(e) => patch({ description: e.target.value || undefined })} />}
      </Field>

      {node.type === 'start' && <StartForm node={node} patch={patch} />}
      {node.type === 'tool' && <ToolForm node={node} def={def} patch={patch} />}
      {node.type === 'agent' && <AgentForm node={node} def={def} patch={patch} />}
      {node.type === 'end' && (
        <>
          <Field label="Result" hint="What the run gives back. Empty: what the step before it produced.">
            {(fid) => <TextArea id={fid} rows={4} value={node.output ?? ''} onChange={(e) => patch({ output: e.target.value || undefined })} />}
          </Field>
          <p className="-mt-1 text-xs text-ink-faint">
            <Refs def={def} id={node.id} />
          </p>
        </>
      )}

      {stepOptions && (
        <>
          <Fold title="Advanced settings">
            <Field label="Time limit (seconds)" hint="The step is stopped after this long. Empty: 5 minutes.">
              {(fid) => (
                <TextInput
                  id={fid}
                  inputMode="numeric"
                  value={stepOptions.timeoutSec === undefined ? '' : String(stepOptions.timeoutSec)}
                  onChange={(e) => patch({ timeoutSec: e.target.value.trim() === '' || Number.isNaN(Number(e.target.value)) ? undefined : Number(e.target.value) })}
                />
              )}
            </Field>
          </Fold>
          <Fold title="Error handling">
            <Field label="If this step fails">
              {(fid) => (
                <SelectField id={fid} value={onError} onChange={(e) => patch({ onError: e.target.value as OnError, ...(e.target.value === 'retry' && !stepOptions.retries ? { retries: 2 } : {}) })}>
                  <option value="stop">Stop the run</option>
                  <option value="retry">Try again</option>
                  <option value="continue">Carry on without it</option>
                </SelectField>
              )}
            </Field>
            {onError === 'retry' && (
              <Field label="Tries after the first (1 to 5)">
                {(fid) => <TextInput id={fid} inputMode="numeric" value={String(stepOptions.retries ?? 2)} onChange={(e) => patch({ retries: Number(e.target.value) || 1 })} />}
              </Field>
            )}
          </Fold>
        </>
      )}

      {!fixed && (
        <div className="flex flex-wrap items-center gap-2 border-t border-edge/70 pt-4">
          <Button variant="secondary" size="sm" disabled={index <= 1} onClick={() => edit((d) => moveStep(d, id, -1))}>
            <ArrowLeft className="h-3.5 w-3.5" /> Earlier
          </Button>
          <Button variant="secondary" size="sm" disabled={index >= order.length - 2} onClick={() => edit((d) => moveStep(d, id, 1))}>
            Later <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="ml-auto"
            onClick={() => {
              select(null)
              edit((d) => removeStep(d, id))
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete step
          </Button>
        </div>
      )}
    </PanelCard>
  )
}
