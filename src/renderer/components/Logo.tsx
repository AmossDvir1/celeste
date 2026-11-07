import markUrl from '@/assets/logo/celeste-mark.svg'
import { cn } from '@/lib/cn'

/** The one place the mark is used. To swap the final logo, replace assets/logo/celeste-mark.svg and run `npm run icons`. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={markUrl}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={cn('shrink-0 select-none', className)}
    />
  )
}
