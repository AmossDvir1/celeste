import type { ContextRef } from '@shared/agent'
import { listFolder, readPreview } from './files'

/*
 * Files and folders that the person dragged into a message as context. The agent is told about them in the text it receives:
 * a small file is put in whole, so the agent has it without having to go and read it; a larger one, a file that is not text, and
 * a folder are named, with a note on how to look at them. The message in the log keeps only the paths, which is also what the
 * person sees as chips under it.
 */

/** A file bigger than this is named, not put in. */
export const CONTEXT_FILE_BYTES = 100 * 1024
/** Once this much has been put in, the rest are named. */
export const CONTEXT_TOTAL_BYTES = 300 * 1024
/** A message carries at most this many. */
export const MAX_CONTEXT = 20
/** A folder names at most this many of the things in it. */
const FOLDER_NAMES = 40

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`)

/** A fence longer than any run of backticks inside the text, so the text cannot end it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** What to tell the agent, to follow the person's own words. Empty when there is nothing. */
export function contextText(root: string, refs: ContextRef[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  let used = 0
  for (const ref of refs) {
    const path = ref.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!path || seen.has(path)) continue
    seen.add(path)

    if (ref.kind === 'dir') {
      try {
        const { entries, more } = listFolder(root, path)
        const names = entries.slice(0, FOLDER_NAMES).map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name))
        const rest = entries.length - names.length + more
        parts.push(`Folder: ${path}/ (contains ${names.join(', ') || 'nothing'}${rest > 0 ? `, and ${rest} more` : ''}). Look at what you need from it.`)
      } catch {
        parts.push(`Folder: ${path}/ (it could not be read; it may have been moved or removed).`)
      }
      continue
    }

    let preview: ReturnType<typeof readPreview> | undefined
    try {
      preview = readPreview(root, path)
    } catch {
      preview = undefined
    }
    if (!preview || preview.kind === 'missing') parts.push(`File: ${path} (it could not be read; it may have been moved or removed).`)
    else if (preview.kind === 'binary') parts.push(`File: ${path} (${kb(preview.size)}, not text, so it is not included).`)
    else if (preview.kind === 'large' || preview.size > CONTEXT_FILE_BYTES || used + preview.size > CONTEXT_TOTAL_BYTES) {
      parts.push(`File: ${path} (${kb(preview.size)}, too large to include here. Read the part you need from the project).`)
    } else {
      used += preview.size
      const fence = fenceFor(preview.text)
      parts.push(`File: ${path}\n${fence}\n${preview.text.replace(/\n$/, '')}\n${fence}`)
    }
  }
  if (parts.length === 0) return ''
  return `[Files and folders from the project that the person added as context. Paths are relative to the project folder.]\n\n${parts.join('\n\n')}`
}
