import { forwardRef } from 'react'
import { FolderOpen } from 'lucide-react'
import type { InputDef } from '@shared/workflow'
import { Field, SelectField } from '@/components/form'
import { Button, Checkbox, TextInput } from '@/components/ui'

/** What a Start step asks and the folder a run works in: the same two parts in the dialog that runs a workflow and the one that schedules it. */

export type Answers = Record<string, string | boolean>

/** The answers a form starts with: each question's default. */
export const initialAnswers = (inputs: InputDef[]): Answers =>
  Object.fromEntries(inputs.map((i) => [i.name, i.type === 'boolean' ? i.default === true : i.default === undefined ? '' : String(i.default)]))

/** Answers that were saved as typed values, back as the strings a form holds. */
export const answersFrom = (inputs: InputDef[], saved: Record<string, unknown>): Answers => {
  const out = initialAnswers(inputs)
  for (const i of inputs) {
    const v = saved[i.name]
    if (v === undefined) continue
    out[i.name] = i.type === 'boolean' ? v === true : String(v)
  }
  return out
}

export function InputFields({ inputs, values, onChange }: { inputs: InputDef[]; values: Answers; onChange: (values: Answers) => void }) {
  return (
    <>
      {inputs.length === 0 && <p className="text-[13px] text-ink-muted">This workflow asks nothing before it starts.</p>}
      {inputs.map((i) => {
        const label = i.label || i.name
        return i.type === 'boolean' ? (
          <Checkbox key={i.name} label={label} checked={values[i.name] === true} onChange={(v) => onChange({ ...values, [i.name]: v })} />
        ) : (
          <Field key={i.name} label={`${label}${i.required ? ' (required)' : ''}`}>
            {(id) =>
              i.type === 'choice' ? (
                <SelectField id={id} value={String(values[i.name] ?? '')} onChange={(e) => onChange({ ...values, [i.name]: e.target.value })}>
                  <option value="">Choose…</option>
                  {(i.options ?? []).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </SelectField>
              ) : (
                <TextInput id={id} inputMode={i.type === 'number' ? 'decimal' : undefined} value={String(values[i.name] ?? '')} onChange={(e) => onChange({ ...values, [i.name]: e.target.value })} />
              )
            }
          </Field>
        )
      })}
    </>
  )
}

export const FolderField = forwardRef<HTMLButtonElement, { folder: string; onChange: (folder: string) => void }>(function FolderField({ folder, onChange }, ref) {
  const choose = async () => {
    const picked = await window.celeste?.chooseFolder()
    if (picked) onChange(picked)
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] text-ink-muted">Works in this folder</div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate rounded-control border border-edge bg-field px-3 py-2.5 text-[13px] text-ink" title={folder || undefined}>
          {folder || 'A private folder Celeste keeps for this workflow'}
        </div>
        <Button ref={ref} type="button" variant="secondary" onClick={() => void choose()}>
          <FolderOpen className="h-4 w-4" /> Choose…
        </Button>
        {folder && (
          <Button type="button" variant="ghost" onClick={() => onChange('')}>
            Use the private one
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-faint">Files and commands of the workflow stay inside it.</p>
    </div>
  )
})
