import { Eye, Monitor, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react'
import type { AccessLevel, DeviceKind } from '@shared/devices'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui'

export const LEVELS: { value: AccessLevel; label: string; description: string }[] = [
  { value: 'read', label: 'Read only', description: 'The assistant can look at files, and nothing else. No commands, no changes.' },
  { value: 'ask', label: 'Ask first', description: 'It can run commands and change files, and you approve each one first.' },
  { value: 'full', label: 'Full access', description: 'Commands and changes run without asking. Use this only for machines you can afford to break.' }
]

/** How much an assistant may do on a device. Full access is always flagged. */
export function AccessBadge({ level, className }: { level: AccessLevel; className?: string }) {
  if (level === 'full') {
    return (
      <Badge tone="warning" className={className}>
        <TriangleAlert className="h-3 w-3" /> Full access
      </Badge>
    )
  }
  return (
    <Badge tone={level === 'ask' ? 'accent' : 'neutral'} className={className}>
      {level === 'ask' ? <ShieldCheck className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      {level === 'ask' ? 'Ask first' : 'Read only'}
    </Badge>
  )
}

export function DeviceGlyph({ kind, className }: { kind: DeviceKind; className?: string }) {
  const Icon = kind === 'adb' ? Smartphone : Monitor
  return <Icon className={cn('h-5 w-5', className)} aria-hidden />
}

export const OS_LABEL: Record<string, string> = { linux: 'Linux', mac: 'macOS', windows: 'Windows', android: 'Android', unknown: 'Not tested yet' }

/** The sentence the plan promises wherever a device is added or attached. */
export const VENDOR_NOTICE = 'What the assistant reads on a device is sent to your AI vendor, like any file on this computer.'
