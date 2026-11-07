import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Working labels ("Thinking", "Reading auth.ts") sweep a light across the text.
 * When nothing is working (for example "Waiting for your answer") pass active={false}: no motion.
 */
export function ShimmerText({
  children,
  active = true,
  className
}: {
  children: ReactNode
  active?: boolean
  className?: string
}) {
  return <span className={cn(active ? 'shimmer' : 'text-ink-muted', className)}>{children}</span>
}
