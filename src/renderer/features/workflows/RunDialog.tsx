import { useRef, useState } from 'react'
import { FolderOpen, Play } from 'lucide-react'
import { checkInputs, type InputDef } from '@shared/workflow'
import { Field, SelectField } from '@/components/form'
import { Modal } from '@/components/Dialog'
import { Button, Checkbox, TextInput } from '@/components/ui'
import { useRuns } from '@/stores/runs'
import { useUi } from '@/stores/ui'

/**
 * Asks what a run needs before it starts: the answers to the Start step's questions, and the folder it works in. Starting shows the
 * approval card, so nothing is done until the person has seen what the run will do.
 */
export function RunDialog({ workflowId, name, inputs, onClose }: { workflowId: string; name: string; inputs: InputDef[]; onClose: () => void }) {
  const start = useRuns((s) => s.start)
  const lastFolder = useRuns((s) => s.folders[workflowId])
  const pushToast = useUi((s) => s.pushToast)
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(inputs.map((i) => [i.name, i.type === 'boolean' ? i.default === true : i.default === undefined ? '' : String(i.default)]))
  )
  const [folder, setFolder] = useState(lastFolder ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const first = useRef<HTMLButtonElement>(null)

  const choose = async () => {
    const picked = await window.celeste?.chooseFolder()
    if (picked) setFolder(picked)
  }

  const go = async () => {
    try {
      checkInputs(inputs, values)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Check the answers.')
      return
    }
    setProblem(null)
    setStarting(true)
    const run = await start(workflowId, values, folder)
    setStarting(false)
    if (run) onClose()
    else pushToast({ text: 'The workflow did not start.' })
  }

  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title={`Run “${name}”`} className="w-[min(500px,calc(100vw-48px))]">
      <form
        className="space-y-4 px-6 pt-2 pb-5"
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        {inputs.length === 0 && <p className="text-[13px] text-ink-muted">This workflow asks nothing before it starts.</p>}
        {inputs.map((i) => {
          const label = i.label || i.name
          return i.type === 'boolean' ? (
            <Checkbox key={i.name} label={label} checked={values[i.name] === true} onChange={(v) => setValues({ ...values, [i.name]: v })} />
          ) : (
            <Field key={i.name} label={`${label}${i.required ? ' (required)' : ''}`}>
              {(id) =>
                i.type === 'choice' ? (
                  <SelectField id={id} value={String(values[i.name] ?? '')} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
                    <option value="">Choose…</option>
                    {(i.options ?? []).map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </SelectField>
                ) : (
                  <TextInput id={id} inputMode={i.type === 'number' ? 'decimal' : undefined} value={String(values[i.name] ?? '')} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} />
                )
              }
            </Field>
          )
        })}

        <div className="space-y-1.5">
          <div className="text-[13px] text-ink-muted">Works in this folder</div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-control border border-edge bg-field px-3 py-2.5 text-[13px] text-ink" title={folder || undefined}>
              {folder || 'A private folder Celeste keeps for this workflow'}
            </div>
            <Button ref={first} type="button" variant="secondary" onClick={() => void choose()}>
              <FolderOpen className="h-4 w-4" /> Choose…
            </Button>
            {folder && (
              <Button type="button" variant="ghost" onClick={() => setFolder('')}>
                Use the private one
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-faint">Files and commands of the workflow stay inside it.</p>
        </div>

        {problem && (
          <p role="alert" className="text-[13px] text-danger">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={starting}>
            <Play className="h-4 w-4" /> Run
          </Button>
        </div>
        <p className="text-xs text-ink-faint">You will see everything it is going to do before anything happens.</p>
      </form>
    </Modal>
  )
}
