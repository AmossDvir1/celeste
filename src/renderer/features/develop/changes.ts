import type { CheckpointFile } from '@shared/api'
import type { TimelineItem } from '@/stores/types'

export type ChangeKind = CheckpointFile['status']

/**
 * The files the agent has changed in a session, from what each finished turn logged (what the saved copies of the folder
 * show). A file made and then deleted is not a change at all; one deleted and made again is a change to it.
 */
export function changedFiles(items: TimelineItem[]): Map<string, ChangeKind> {
  const changed = new Map<string, ChangeKind>()
  for (const item of items) {
    if (item.kind !== 'user' || !item.checkpoint?.files) continue
    for (const file of item.checkpoint.files) {
      const before = changed.get(file.path)
      if (before === 'added' && file.status === 'deleted') changed.delete(file.path)
      else if (before === 'added' && file.status === 'modified') changed.set(file.path, 'added')
      else if (before === 'deleted' && file.status === 'added') changed.set(file.path, 'modified')
      else changed.set(file.path, file.status)
    }
  }
  return changed
}
