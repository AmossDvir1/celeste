import { useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { checkInputs, type InputDef } from '@shared/workflow'
import { Modal } from '@/components/Dialog'
import { Button } from '@/components/ui'
import { useRuns } from '@/stores/runs'
import { useUi } from '@/stores/ui'
import { FolderField, InputFields, initialAnswers } from './RunFields'

/**
 * Asks what a run needs before it starts: the answers to the Start step's questions, and the folder it works in. Starting shows the
 * approval card, so nothing is done until the person has seen what the run will do.
 */
export function RunDialog({ workflowId, name, inputs, onClose }: { workflowId: string; name: string; inputs: InputDef[]; onClose: () => void }) {
  const start = useRuns((s) => s.start)
  const lastFolder = useRuns((s) => s.folders[workflowId])
  const pushToast = useUi((s) => s.pushToast)
  const [values, setValues] = useState(() => initialAnswers(inputs))
  const [folder, setFolder] = useState(lastFolder ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const first = useRef<HTMLButtonElement>(null)

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
        <InputFields inputs={inputs} values={values} onChange={setValues} />
        <FolderField ref={first} folder={folder} onChange={setFolder} />

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
