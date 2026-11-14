import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, SIZE, VARIANT } from '@/components/ui'
import { Menu } from '@/components/menu'

export interface SplitOption {
  key: string
  label: string
  /** A line under the label, for example what the option is billed to. */
  description?: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
}

interface SplitButtonProps {
  /** The label of the main part, which does the primary action. */
  children: ReactNode
  onClick: () => void
  /** The other ways to do it. With none, this is a plain button. */
  options: SplitOption[]
  variant?: keyof typeof VARIANT
  size?: keyof typeof SIZE
  disabled?: boolean
  /** Accessible name of the chevron. */
  menuLabel?: string
}

/**
 * A button whose left part does the primary action and whose right part (a chevron that turns when the menu is open)
 * opens a menu of other ways to do it.
 */
export function SplitButton({ children, onClick, options, variant = 'soft', size = 'md', disabled, menuLabel = 'More ways to connect' }: SplitButtonProps) {
  if (options.length === 0) {
    return (
      <Button variant={variant} size={size} disabled={disabled} onClick={onClick}>
        {children}
      </Button>
    )
  }
  const part = cn('inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50', VARIANT[variant])
  return (
    <div className="inline-flex shrink-0">
      <button type="button" disabled={disabled} onClick={onClick} className={cn(part, SIZE[size], 'rounded-l-control pr-3.5')}>
        {children}
      </button>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={menuLabel}
            className={cn(part, 'group w-8 rounded-r-control border-l border-current/25 outline-offset-2', size === 'sm' ? 'h-8' : size === 'lg' ? 'h-11' : 'h-9')}
          >
            <ChevronDown
              aria-hidden
              className="h-4 w-4 transition-transform duration-200 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </button>
        </Menu.Trigger>
        <Menu.Content align="end" className="min-w-[240px]">
          {options.map((o) => (
            <Menu.Item key={o.key} disabled={o.disabled} onSelect={o.onSelect} className="items-start">
              {o.icon && <span className="mt-0.5 shrink-0 text-ink-muted">{o.icon}</span>}
              <span className="flex min-w-0 flex-col">
                <span>{o.label}</span>
                {o.description && <span className="text-[11.5px] leading-snug text-ink-faint">{o.description}</span>}
              </span>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Root>
    </div>
  )
}
