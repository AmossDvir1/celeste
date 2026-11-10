import { useState } from 'react'
import { Button } from '@/components/ui'
import { Modal } from '@/components/Dialog'
import { openInMyBrowser, openInPane } from '@/lib/links'
import { browserCall } from '@/stores/browser'
import { useUi } from '@/stores/ui'

/** The first time a web link in a chat is clicked: Celeste's browser, or the person's own? */
export function LinkChoiceDialog() {
  const url = useUi((s) => s.pendingLink)
  const setUrl = useUi((s) => s.setPendingLink)
  const [remember, setRemember] = useState(false)
  const choose = (where: 'celeste' | 'system') => {
    const link = url
    setUrl(null)
    if (!link) return
    if (remember) void browserCall('setPrefs', { linksIn: where }).catch(() => undefined)
    if (where === 'celeste') void openInPane(link).then((ok) => (ok ? undefined : openInMyBrowser(link)))
    else void openInMyBrowser(link)
  }
  return (
    <Modal open={!!url} onOpenChange={(open) => !open && setUrl(null)} title="Open this link where?" description={url ?? undefined}>
      <div className="px-6 pt-3 pb-5">
        <p className="mb-4 text-sm break-all text-ink-muted">{url}</p>
        <label className="mb-5 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          Remember my choice
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={() => choose('system')}>My browser</Button>
          <Button variant="primary" onClick={() => choose('celeste')}>
            Celeste’s browser
          </Button>
        </div>
      </div>
    </Modal>
  )
}
