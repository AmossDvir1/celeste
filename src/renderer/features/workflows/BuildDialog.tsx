import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Modal } from '@/components/Dialog'
import { TextArea } from '@/components/form'
import { Button, Spinner } from '@/components/ui'
import { connectedVendors, useVendors } from '@/stores/vendors'
import { useWorkflows } from '@/stores/workflows'

/** Asks what the workflow should do, has an assistant draft it, and opens the draft for the person to look over. */
export function BuildDialog({ onClose }: { onClose: () => void }) {
  const build = useWorkflows((s) => s.build)
  const building = useWorkflows((s) => s.building)
  const noVendor = useVendors((s) => connectedVendors(s.vendors).length === 0)
  const [text, setText] = useState('')

  const go = async () => {
    if (building || noVendor || text.trim().length < 8) return
    if (await build({ kind: 'text', text })) onClose()
  }

  return (
    <Modal open onOpenChange={(next) => !next && !building && onClose()} title="Build with AI" className="w-[min(540px,calc(100vw-48px))]">
      <div className="space-y-3 px-6 pt-2 pb-5">
        <p className="text-[13px] text-ink-muted">Describe what the workflow should do. An assistant drafts the steps; you look them over and change what you like before anything is saved or run.</p>
        <TextArea
          autoFocus
          rows={6}
          aria-label="What should the workflow do?"
          placeholder="For example: every time I run it, find the log files in a folder older than a number of days I choose, list them, and ask the assistant to summarize what they contain."
          value={text}
          disabled={building}
          onChange={(e) => setText(e.target.value)}
        />
        {noVendor && (
          <p role="alert" className="text-[13px] text-warning">
            Connect an AI vendor first, in Settings.
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {building && (
            <span role="status" className="mr-auto flex items-center gap-2 text-[13px] text-ink-muted">
              <Spinner className="h-3.5 w-3.5" /> Drafting… this can take a minute.
            </span>
          )}
          <Button variant="ghost" onClick={onClose} disabled={building}>
            Cancel
          </Button>
          <Button variant="primary" disabled={building || noVendor || text.trim().length < 8} onClick={() => void go()}>
            <Sparkles className="h-4 w-4" /> Draft it
          </Button>
        </div>
      </div>
    </Modal>
  )
}
