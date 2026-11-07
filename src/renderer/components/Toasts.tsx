import { X } from 'lucide-react'
import { useUi } from '@/stores/ui'

/** Short messages at the bottom of the window, for example "Deleted a chat" with Undo. */
export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[90] flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="animate-fade-up pointer-events-auto flex items-center gap-3 rounded-xl border border-edge-strong bg-raised-2 py-2 pr-2 pl-4 text-sm text-ink shadow-pop"
        >
          <span>{t.text}</span>
          {t.actionLabel && (
            <button
              type="button"
              onClick={() => {
                t.onAction?.()
                dismiss(t.id)
              }}
              className="rounded-md px-2.5 py-1 font-medium text-accent-text hover:bg-accent-soft"
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
