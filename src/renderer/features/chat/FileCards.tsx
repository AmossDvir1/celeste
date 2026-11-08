import { Archive, FileCode2, FileImage, FileSpreadsheet, FileText, File as FileIcon, FolderOpen, Globe, Save } from 'lucide-react'
import { canOpenFile, fileKind, formatBytes, type FileKind, type ProducedFile } from '@shared/produced'
import { Button, IconButton } from '@/components/ui'
import { useUi } from '@/stores/ui'

const ICON: Record<FileKind, typeof FileText> = {
  image: FileImage,
  document: FileText,
  text: FileText,
  data: FileSpreadsheet,
  web: Globe,
  archive: Archive,
  other: FileIcon
}

const LABEL: Record<FileKind, string> = { image: 'Image', document: 'Document', text: 'Text', data: 'Data', web: 'Web page', archive: 'Archive', other: 'File' }

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * The files the agent made while answering, under the answer. A document opens with the computer's own program; anything that
 * could run is only shown in its folder (the main process refuses to start it either way). A copy can be saved anywhere.
 */
export function FileCards({ sessionId, files, more }: { sessionId: string; files: ProducedFile[]; more: number }) {
  const pushToast = useUi((s) => s.pushToast)
  const act = async (path: string, action: 'open' | 'reveal' | 'save') => {
    try {
      const result = await window.celeste?.chatFile(sessionId, path, action)
      if (result && !result.ok && result.message) pushToast({ text: result.message })
      else if (result?.ok && result.message) pushToast({ text: result.message })
    } catch {
      pushToast({ text: 'Could not do that with the file.' })
    }
  }

  return (
    <section aria-label="Files made in this answer" className="animate-fade-up max-w-[760px]">
      <ul className="divide-y divide-edge/70 overflow-hidden rounded-xl border border-edge bg-field/50">
        {files.map((f) => {
          const name = nameOf(f.path)
          const kind = fileKind(name)
          const Icon = kind === 'other' && /\.(py|js|ts|sh|ps1|bat|cmd)$/i.test(name) ? FileCode2 : ICON[kind]
          const folder = folderOf(f.path)
          return (
            <li key={f.path} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-muted">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] text-ink" title={f.path}>
                  {name}
                </div>
                <div className="truncate text-[12.5px] text-ink-muted">
                  {LABEL[kind]} · {formatBytes(f.size)} · {f.status === 'added' ? 'New' : 'Changed'}
                  {folder && ` · in ${folder}`}
                </div>
              </div>
              {canOpenFile(name) && (
                <Button variant="soft" size="sm" aria-label={`Open ${name}`} onClick={() => void act(f.path, 'open')}>
                  Open
                </Button>
              )}
              <IconButton label={`Show ${name} in its folder`} size="sm" onClick={() => void act(f.path, 'reveal')}>
                <FolderOpen className="h-[15px] w-[15px]" />
              </IconButton>
              <IconButton label={`Save a copy of ${name}`} size="sm" onClick={() => void act(f.path, 'save')}>
                <Save className="h-[15px] w-[15px]" />
              </IconButton>
            </li>
          )
        })}
      </ul>
      {more > 0 && <p className="mt-1.5 px-1 text-xs text-ink-faint">and {more} more {more === 1 ? 'file' : 'files'} in this chat’s folder.</p>}
    </section>
  )
}
