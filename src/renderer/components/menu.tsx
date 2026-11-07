import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { DropdownMenu, Popover as RPopover } from 'radix-ui'
import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'

const itemBase =
  'relative flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px] text-ink outline-none select-none ' +
  'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45'

const Content = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenu.Content>>(function Content(
  { className, children, ...props },
  ref
) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        ref={ref}
        sideOffset={6}
        align="start"
        collisionPadding={12}
        className={cn(
          'pop-in z-[60] max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-[200px] overflow-y-auto',
          'rounded-xl border border-edge-strong bg-raised-2 p-1 shadow-pop',
          className
        )}
        {...props}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
})

function Item({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cn(itemBase, className)} {...props} />
}

function RadioItem({
  className,
  children,
  description,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem> & { description?: ReactNode }) {
  return (
    <DropdownMenu.RadioItem className={cn(itemBase, 'items-start pr-8', className)} {...props}>
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {description && <span className="text-[11.5px] leading-snug text-ink-faint">{description}</span>}
      </span>
      <DropdownMenu.ItemIndicator className="absolute top-2 right-2.5 text-accent-text">
        <Check className="h-3.5 w-3.5" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )
}

function Label({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn('px-2.5 pt-1.5 pb-1 text-[10.5px] font-medium tracking-wider text-ink-faint uppercase', className)}
      {...props}
    />
  )
}

function Separator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-edge" />
}

export const Menu = {
  Root: DropdownMenu.Root,
  Trigger: DropdownMenu.Trigger,
  Content,
  Item,
  RadioGroup: DropdownMenu.RadioGroup,
  RadioItem,
  Label,
  Separator
}

const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RPopover.Content>>(
  function PopoverContent({ className, children, ...props }, ref) {
    return (
      <RPopover.Portal>
        <RPopover.Content
          ref={ref}
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className={cn(
            'pop-in z-[60] rounded-xl border border-edge-strong bg-raised-2 p-4 shadow-pop',
            className
          )}
          {...props}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    )
  }
)

export const Popover = { Root: RPopover.Root, Trigger: RPopover.Trigger, Content: PopoverContent, Close: RPopover.Close }
