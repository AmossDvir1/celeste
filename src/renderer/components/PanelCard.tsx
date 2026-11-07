import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from './ui'

/** A bordered card with a title bar and a close button. Used for the right-hand panels. */
export function PanelCard({
  title,
  onClose,
  actions,
  children,
  className,
  bodyClassName
}: {
  title: ReactNode
  onClose?: () => void
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('flex min-h-0 flex-col overflow-hidden rounded-2xl border border-edge bg-panel', className)}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge/70 pr-2 pl-5">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{title}</h2>
        {actions}
        {onClose && (
          <IconButton label="Close panel" onClick={onClose}>
            <X className="h-[18px] w-[18px]" />
          </IconButton>
        )}
      </header>
      <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
    </section>
  )
}
