import { useState, type ReactNode } from 'react'
import { ChevronDown, MousePointerClick, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Field, SelectField, TextArea } from '@/components/form'
import { PanelCard } from '@/components/PanelCard'
import { Button, Checkbox, IconButton, TextInput } from '@/components/ui'
import { MODEL_CHOICES, TOOL_CHOICES, newId, type InputDef, type StepData, type StepNode } from './graph'
import { STEP_ICONS } from './nodes'

function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-edge">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full items-center justify-between px-4 text-[14px] text-ink hover:bg-hover"
      >
        {title}
        <ChevronDown className={cn('h-4 w-4 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-3 border-t border-edge/70 p-4">{children}</div>}
    </div>
  )
}

const KIND_LABEL = { start: 'Start', end: 'End', tool: 'Tool', agent: 'Agent' } as const

export function NodeDetails({
  node,
  readOnly,
  onChange,
  onClose
}: {
  node: StepNode | null
  readOnly?: boolean
  onChange: (patch: Partial<StepData>) => void
  onClose: () => void
}) {
  if (!node) {
    return (
      <PanelCard title="Node details" className="h-full">
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <MousePointerClick className="h-8 w-8 text-ink-faint" />
          <div className="text-[14px] text-ink">Select a step</div>
          <div className="text-[13px] text-ink-muted">Click a step on the canvas to see and edit its details.</div>
        </div>
      </PanelCard>
    )
  }

  const d = node.data
  const Icon = STEP_ICONS[d.icon]
  const editable = d.kind === 'tool' || d.kind === 'agent'
  const patchInput = (id: string, patch: Partial<InputDef>) => onChange({ inputs: d.inputs.map((i) => (i.id === id ? { ...i, ...patch } : i)) })

  return (
    <PanelCard title="Node details" onClose={onClose} className="h-full" bodyClassName="p-4">
      <fieldset disabled={readOnly} className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border border-edge bg-field p-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
            <Icon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-ink">{d.title}</div>
            <div className="text-[12.5px] leading-snug text-ink-muted">{d.description}</div>
          </div>
        </div>

        {editable && (
          <Field label="Name">
            {(id) => <TextInput id={id} value={d.title} onChange={(e) => onChange({ title: e.target.value })} />}
          </Field>
        )}

        {editable && (
          <Field label="Type">
            {(id) => (
              <SelectField
                id={id}
                value={d.kind}
                onChange={(e) => {
                  const kind = e.target.value as 'tool' | 'agent'
                  onChange(
                    kind === 'agent'
                      ? { kind, icon: 'bot', model: d.model ?? MODEL_CHOICES[0], approval: d.approval ?? 'auto', prompt: d.prompt ?? '' }
                      : { kind, tool: d.tool ?? TOOL_CHOICES[0] }
                  )
                }}
              >
                <option value="tool">Tool</option>
                <option value="agent">Agent</option>
              </SelectField>
            )}
          </Field>
        )}
        {!editable && (
          <div className="text-[13px] text-ink-muted">
            Type: <span className="text-ink">{KIND_LABEL[d.kind]}</span>
          </div>
        )}

        {d.kind === 'tool' && (
          <Field label="Tool" hint="Calls the tool directly. No model is involved.">
            {(id) => (
              <SelectField id={id} value={d.tool} onChange={(e) => onChange({ tool: e.target.value })}>
                {TOOL_CHOICES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </SelectField>
            )}
          </Field>
        )}

        {d.kind === 'agent' && (
          <>
            <Field label="Prompt" hint="The agent runs this with the results of earlier steps.">
              {(id) => <TextArea id={id} rows={4} value={d.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model">
                {(id) => (
                  <SelectField id={id} value={d.model} onChange={(e) => onChange({ model: e.target.value })}>
                    {MODEL_CHOICES.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </SelectField>
                )}
              </Field>
              <Field label="Approval">
                {(id) => (
                  <SelectField id={id} value={d.approval} onChange={(e) => onChange({ approval: e.target.value as StepData['approval'] })}>
                    <option value="auto">Auto-approve</option>
                    <option value="edits">Approve edits</option>
                    <option value="ask">Ask first</option>
                  </SelectField>
                )}
              </Field>
            </div>
          </>
        )}

        {editable && (
          <Field label="Description">
            {(id) => <TextArea id={id} rows={3} value={d.description} onChange={(e) => onChange({ description: e.target.value })} />}
          </Field>
        )}

        {(editable || d.kind === 'start') && (
          <section aria-label="Inputs" className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] text-ink-muted">Inputs</h3>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onChange({ inputs: [...d.inputs, { id: newId('in'), name: `input_${d.inputs.length + 1}`, label: 'New input', value: '', required: false }] })}
              >
                <Plus className="h-4 w-4" /> Add input
              </Button>
            </div>
            {d.inputs.length === 0 && <p className="text-[13px] text-ink-faint">No inputs yet.</p>}
            {d.inputs.map((inp) => (
              <div key={inp.id} className="space-y-2 rounded-xl border border-edge bg-field/50 p-3">
                <div className="flex items-center gap-2">
                  <TextInput
                    aria-label="Input name"
                    value={inp.name}
                    onChange={(e) => patchInput(inp.id, { name: e.target.value.replace(/\s+/g, '_') })}
                    className="h-9 font-mono text-[13px]"
                  />
                  <IconButton label={`Remove ${inp.name}`} onClick={() => onChange({ inputs: d.inputs.filter((i) => i.id !== inp.id) })}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
                <div className="grid grid-cols-[1fr_96px] gap-2">
                  <TextInput aria-label="Input label" value={inp.label} onChange={(e) => patchInput(inp.id, { label: e.target.value })} className="h-9" />
                  <TextInput aria-label="Input value" value={inp.value} onChange={(e) => patchInput(inp.id, { value: e.target.value })} className="h-9" />
                </div>
                <Checkbox label="Required" checked={inp.required} onChange={(required) => patchInput(inp.id, { required })} />
              </div>
            ))}
          </section>
        )}

        {editable && (
          <>
            <Collapsible title="Advanced settings">
              <Field label="Timeout (seconds)">
                {(id) => (
                  <TextInput
                    id={id}
                    type="number"
                    min={1}
                    value={d.timeoutSeconds}
                    onChange={(e) => onChange({ timeoutSeconds: Math.max(1, Number(e.target.value) || 1) })}
                  />
                )}
              </Field>
            </Collapsible>
            <Collapsible title="Error handling">
              <Field label="If this step fails">
                {(id) => (
                  <SelectField id={id} value={d.onError} onChange={(e) => onChange({ onError: e.target.value as StepData['onError'] })}>
                    <option value="stop">Stop the workflow</option>
                    <option value="retry">Retry up to 3 times</option>
                    <option value="continue">Continue with the next step</option>
                  </SelectField>
                )}
              </Field>
            </Collapsible>
          </>
        )}
      </fieldset>
    </PanelCard>
  )
}
