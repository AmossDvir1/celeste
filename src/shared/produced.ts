/** A file a chat's agent made or changed, listed under its answer so it can be opened. */
export interface ProducedFile {
  /** Relative to the chat's private folder, with forward slashes. */
  path: string
  size: number
  status: 'added' | 'modified'
}

const EXT = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Kinds of file, for the icon and the label on a card. */
export type FileKind = 'image' | 'document' | 'text' | 'data' | 'web' | 'archive' | 'other'

const KINDS: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  pdf: 'document', doc: 'document', docx: 'document', odt: 'document', rtf: 'document', ppt: 'document', pptx: 'document', xls: 'document', xlsx: 'document',
  txt: 'text', md: 'text', log: 'text',
  csv: 'data', tsv: 'data', json: 'data', yaml: 'data', yml: 'data', xml: 'data',
  html: 'web', htm: 'web',
  zip: 'archive'
}

export const fileKind = (name: string): FileKind => KINDS[EXT(name)] ?? 'other'

/**
 * Only plain documents are opened with the computer's own program. Anything that could run (programs, scripts, shortcuts, installers) can
 * only be shown in its folder: a file an agent wrote is not something to start on its own.
 */
export const canOpenFile = (name: string): boolean => EXT(name) in KINDS

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
