import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronRight, FileText, Folder, LoaderCircle, Paperclip, X } from 'lucide-react'
import type { ContextRef } from '@shared/agent'
import type { FileListing } from '@shared/api'
import { PHONE_CONTEXT_MAX, PHONE_UPLOAD_MAX_BYTES, PHONE_UPLOAD_MAX_FILES, type PhoneUploaded, type PhoneUploadPart } from '@shared/phone'
import { useApp } from './store'
import { Shimmer, buzz } from './ui'

/*
 * What a message can carry, as on the computer: files from the phone (sent to the computer in parts, as they are chosen),
 * and, in Develop, files and folders of the project (chosen from a list the computer gives, and sent as names only).
 */

export interface Attached {
  key: string
  name: string
  mime: string
  size: number
  /** Thumbnail of an image. */
  preview?: string
  /** The computer's id for it, once it has arrived. */
  id?: string
  state: 'sending' | 'ready'
  /** How much of it has arrived, 0 to 1, while it is sending. */
  progress?: number
}

const readBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(new Error('That file could not be read.'))
    r.readAsDataURL(blob)
  })

/** Ends a wait that never answers, so one stuck step cannot leave a file spinning for ever. */
const within = <T,>(work: Promise<T>, ms: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e))
    )
  })

const sizeOfImage = (url: string) =>
  within(
    new Promise<{ width: number; height: number } | undefined>((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : undefined)
      img.onerror = () => resolve(undefined)
      img.src = url
    }),
    5000,
    ''
  ).catch(() => undefined)

const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Parts are small enough to pass through the relay (away from home), which drops large messages; the computer takes any up to its own limit. */
const PART = 192 * 1024
/** Over a direct link there is no such limit, and fewer, larger parts are faster. */
const DIRECT_PART = 1_000_000

/** Sends one file to the computer, part by part. Throws a message fit to show. */
async function upload(file: File, dims: { width: number; height: number } | undefined, cancelled: () => boolean, progress: (fraction: number) => void): Promise<PhoneUploaded | null> {
  const link = useApp.getState().link
  if (!link) throw new Error('Not connected to the computer.')
  const id = randomId()
  let offset = 0
  for (let n = 0; ; n++) {
    if (cancelled()) return null
    // The size follows the route as it is now: a link that falls back to the relay mid-file gets smaller parts again.
    const end = Math.min(file.size, offset + (link.route === 'direct' ? DIRECT_PART : PART))
    const last = end >= file.size
    const part: PhoneUploadPart = {
      upload: id,
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      part: n,
      data: await within(readBase64(file.slice(offset, end)), 20_000, 'That file could not be read.'),
      last,
      ...(dims ?? {})
    }
    const reply = await within(link.call<PhoneUploaded | { part: number }>('phone.upload', part), 45_000, 'The computer did not answer. Try again.')
    progress(end / Math.max(1, file.size))
    offset = end
    if (last) return reply as PhoneUploaded
  }
}

/** The files chosen for one message, sent to the computer as they are chosen. */
export function useAttachments() {
  const [files, setFiles] = useState<Attached[]>([])
  const cancelled = useRef(new Set<string>())
  const chain = useRef<Promise<void>>(Promise.resolve())
  const current = useRef<Attached[]>([])
  current.current = files

  const discard = (id: string) => void useApp.getState().link?.call('phone.discard', id).catch(() => undefined)

  const add = useCallback((picked: File[]) => {
    const say = useApp.getState().say
    const room = PHONE_UPLOAD_MAX_FILES - current.current.length
    const take = picked.filter((f) => {
      const problem = f.size === 0 ? 'is empty.' : f.size > PHONE_UPLOAD_MAX_BYTES ? 'is over 25 MB.' : ''
      if (problem) say(`${f.name || 'That file'} ${problem}`)
      return !problem
    })
    if (take.length > room) say(`A message can carry up to ${PHONE_UPLOAD_MAX_FILES} files.`)
    for (const file of take.slice(0, Math.max(0, room))) {
      const key = randomId()
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      const entry: Attached = { key, name: file.name || 'file', mime: file.type || 'application/octet-stream', size: file.size, preview, state: 'sending' }
      current.current = [...current.current, entry]
      setFiles(current.current)
      const drop = () => {
        if (preview) URL.revokeObjectURL(preview)
        setFiles((l) => l.filter((x) => x.key !== key))
      }
      // One file at a time keeps each request small on a slow link.
      chain.current = chain.current.then(async () => {
        if (cancelled.current.delete(key)) return
        try {
          const dims = preview ? await sizeOfImage(preview) : undefined
          const done = await upload(
            file,
            dims,
            () => cancelled.current.has(key),
            (progress) => setFiles((l) => l.map((x) => (x.key === key ? { ...x, progress } : x)))
          )
          if (cancelled.current.delete(key)) {
            if (done) discard(done.id)
            return
          }
          if (!done) return drop()
          setFiles((l) => l.map((x) => (x.key === key ? { ...x, id: done.id, size: done.size, state: 'ready' } : x)))
        } catch (err) {
          say(err instanceof Error ? err.message : 'That file could not be sent.')
          drop()
        }
      })
    }
  }, [])

  const remove = (key: string) => {
    const f = current.current.find((x) => x.key === key)
    if (!f) return
    if (f.state === 'sending') cancelled.current.add(key)
    else if (f.id) discard(f.id)
    if (f.preview) URL.revokeObjectURL(f.preview)
    setFiles((l) => l.filter((x) => x.key !== key))
  }

  /** After a send: the computer has them, nothing to discard. */
  const clear = () => {
    for (const f of current.current) if (f.preview) URL.revokeObjectURL(f.preview)
    current.current = []
    setFiles([])
  }

  // Leaving with files that were never sent: the computer lets them go.
  useEffect(
    () => () => {
      for (const f of current.current) {
        if (f.preview) URL.revokeObjectURL(f.preview)
        if (f.state === 'ready' && f.id) discard(f.id)
        else cancelled.current.add(f.key)
      }
    },
    []
  )

  return {
    files,
    add,
    remove,
    clear,
    sending: files.some((f) => f.state === 'sending'),
    ids: files.flatMap((f) => (f.id ? [f.id] : []))
  }
}

export function AttachButton({ onPick, disabled }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  // The system's file chooser takes a moment to appear: the button spins until it has, and again when it closes without a choice.
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    if (!opening) return
    const done = () => setOpening(false)
    const timer = setTimeout(done, 10_000)
    // The chooser is a screen of its own; coming back to the app (with or without a choice) ends the wait.
    const back = () => !document.hidden && setTimeout(done, 400)
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    const el = input.current
    el?.addEventListener('cancel', done)
    return () => {
      clearTimeout(timer)
      el?.removeEventListener('cancel', done)
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [opening])
  return (
    <>
      <button
        type="button"
        className="attachbtn"
        aria-label="Attach files"
        aria-busy={opening}
        disabled={disabled}
        onClick={() => {
          if (opening) return
          setOpening(true)
          input.current?.click()
        }}
      >
        {opening ? <LoaderCircle size={20} className="spin" /> : <Paperclip size={20} />}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? [])
          e.target.value = ''
          setOpening(false)
          if (list.length) onPick(list)
        }}
      />
    </>
  )
}

export function Chips({ files, context, onRemoveFile, onRemoveContext }: { files: Attached[]; context: ContextRef[]; onRemoveFile: (key: string) => void; onRemoveContext: (path: string) => void }) {
  if (!files.length && !context.length) return null
  return (
    <div className="achips">
      {files.map((f) => (
        <div key={f.key} className={`achip${f.state === 'sending' ? ' busy' : ''}`}>
          {f.preview ? <img src={f.preview} alt="" /> : <FileText size={16} />}
          <span className="nm">{f.name}</span>
          {f.state === 'sending' && (
            <>
              <LoaderCircle size={14} className="spin" />
              {f.progress ? <span className="small faint">{Math.round(f.progress * 100)}%</span> : null}
            </>
          )}
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onRemoveFile(f.key)}>
            <X size={14} />
          </button>
        </div>
      ))}
      {context.map((c) => (
        <div key={c.path} className="achip">
          {c.kind === 'dir' ? <Folder size={16} /> : <FileText size={16} />}
          <span className="nm">{c.path}</span>
          <button type="button" aria-label={`Remove ${c.path}`} onClick={() => onRemoveContext(c.path)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** The project of a Develop session, folder by folder: tick the files and folders the message should point at. */
export function ProjectFiles({ sessionId, picked, onChange, onClose }: { sessionId: string; picked: ContextRef[]; onChange: (next: ContextRef[]) => void; onClose: () => void }) {
  const link = useApp((s) => s.link)
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState<FileListing | null>(null)
  const [error, setError] = useState('')
  const [leaving, setLeaving] = useState(false)
  const close = () => {
    setLeaving(true)
    setTimeout(onClose, 200)
  }
  useEffect(() => {
    let live = true
    setListing(null)
    setError('')
    void link?.call<FileListing>('sessions.listFiles', sessionId, dir).then(
      (l) => live && setListing(l),
      (e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not read this folder.')
    )
    return () => {
      live = false
    }
  }, [link, sessionId, dir])
  const join = (name: string) => (dir ? `${dir}/${name}` : name)
  const toggle = (ref: ContextRef) => {
    buzz(5)
    if (picked.some((p) => p.path === ref.path)) return onChange(picked.filter((p) => p.path !== ref.path))
    if (picked.length >= PHONE_CONTEXT_MAX) return useApp.getState().say(`A message can carry up to ${PHONE_CONTEXT_MAX} files and folders.`)
    onChange([...picked, ref])
  }
  const up = () => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')
  return createPortal(
    <div className={`card-layer${leaving ? ' out' : ''}`}>
      <div className="scrim" onClick={close} />
      <div className="sheet tall" role="dialog" aria-label="Project files">
        <div className="handle" />
        <div className="overline" style={{ fontSize: 10 }}>
          Project files
        </div>
        <h1 className="h-l" style={{ fontSize: 20, margin: '2px 0 4px' }}>
          Add to your message
        </h1>
        {dir && (
          <button className="mgroup pathbar" onClick={up}>
            <ArrowLeft size={14} /> <span className="mono">{dir}</span>
          </button>
        )}
        <div className="mlist">
          {error ? (
            <div className="empty" style={{ padding: 24 }}>
              {error}
            </div>
          ) : listing === null ? (
            <div className="empty" style={{ padding: 24 }}>
              <Shimmer>Asking the computer</Shimmer>
            </div>
          ) : listing.entries.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              Nothing in this folder.
            </div>
          ) : (
            <>
              {listing.entries.map((e) => {
                const path = join(e.name)
                const on = picked.some((p) => p.path === path)
                return (
                  <div key={path} className={`mrow frow${on ? ' on' : ''}`}>
                    <button className="grow fmain" onClick={() => (e.kind === 'dir' ? setDir(path) : toggle({ path, kind: 'file' }))}>
                      {e.kind === 'dir' ? <Folder size={18} /> : <FileText size={18} />}
                      <span className="nm">{e.name}</span>
                      {e.kind === 'dir' && <ChevronRight size={16} className="faint" />}
                    </button>
                    <button className={`ftick${on ? ' on' : ''}`} aria-label={on ? `Remove ${path}` : `Add ${path}`} onClick={() => toggle({ path, kind: e.kind })}>
                      {on ? <Check size={16} /> : <span>Add</span>}
                    </button>
                  </div>
                )
              })}
              {listing.more > 0 && <div className="mgroup">and {listing.more} more not shown</div>}
            </>
          )}
        </div>
        <button className="btn primary block" style={{ marginTop: 16 }} onClick={close}>
          {picked.length ? `Done (${picked.length})` : 'Done'}
        </button>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body
  )
}
