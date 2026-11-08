import { useRef, type ReactNode } from 'react'
import { Modal } from './Dialog'
import { Button } from './ui'

/**
 * Asks before something that cannot simply be taken back. Focus starts on Cancel, so pressing Enter by habit does not do it.
 * Escape and the backdrop cancel.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = true,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Modal open={open} onOpenChange={(next) => !next && onCancel()} title={title} initialFocus={cancel} className="w-[min(440px,calc(100vw-48px))]">
      <div className="px-6 pt-2 pb-5">
        <div className="text-[14px] leading-relaxed text-ink-muted">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancel} variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
