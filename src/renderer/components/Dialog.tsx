import { useRef, type ReactNode } from 'react'
import { Dialog as RDialog } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

/** A centered dialog. Escape and the close button dismiss it, and focus stays inside while it is open. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideTitle
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  className?: string
  hideTitle?: boolean
}) {
  const content = useRef<HTMLDivElement>(null)
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade-up fixed inset-0 z-[70] bg-black/55 backdrop-blur-[2px]" />
        <RDialog.Content
          ref={content}
          tabIndex={-1}
          // Focus the dialog itself instead of its first control, unless something inside asked for focus (autoFocus).
          onOpenAutoFocus={(e) => {
            if (!content.current?.contains(document.activeElement)) {
              e.preventDefault()
              content.current?.focus()
            }
          }}
          className={cn(
            'pop-in fixed top-1/2 left-1/2 z-[71] max-h-[88vh] w-[min(560px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2',
            'overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-pop focus:outline-none',
            className
          )}
        >
          <RDialog.Title className={cn('px-6 pt-5 text-lg font-semibold text-ink', hideTitle && 'sr-only')}>{title}</RDialog.Title>
          {description ? (
            <RDialog.Description className={cn('px-6 pt-1 text-sm text-ink-muted', hideTitle && 'sr-only')}>{description}</RDialog.Description>
          ) : (
            <RDialog.Description className="sr-only">{title}</RDialog.Description>
          )}
          {children}
          {!hideTitle && (
            <RDialog.Close
              aria-label="Close"
              className="absolute top-3.5 right-3.5 flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-hover hover:text-ink"
            >
              <X className="h-[18px] w-[18px]" />
            </RDialog.Close>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
