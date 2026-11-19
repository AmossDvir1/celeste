import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, LoaderCircle, Paperclip, PenLine, Plus } from 'lucide-react'
import { SketchPad } from './Sketch'
import { buzz } from './ui'

/*
 * The "+" in the message box, as on the computer: one button that opens a small menu of what can be put on the message, right above it:
 * files from the phone, a photo taken now, a sketch drawn now. The file chooser and the camera are the system's own, opened by the item that
 * was pressed (they need that press, so the inputs live here and not in the menu, which goes away).
 */
export function AddButton({ onPick, disabled }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const button = useRef<HTMLButtonElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  /** Where the menu goes: just above the button, its left edge on the button's. Null: closed. */
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null)
  const [sketching, setSketching] = useState(false)
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
    const el = files.current
    el?.addEventListener('cancel', done)
    return () => {
      clearTimeout(timer)
      el?.removeEventListener('cancel', done)
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('focus', back)
    }
  }, [opening])

  const choose = (list: FileList | null, input: HTMLInputElement) => {
    const picked = Array.from(list ?? [])
    input.value = ''
    setOpening(false)
    if (picked.length) onPick(picked)
  }

  const show = () => {
    const r = button.current?.getBoundingClientRect()
    if (!r) return
    setAt({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 8 })
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="attachbtn"
        aria-label="Add to the message"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-busy={opening}
        disabled={disabled}
        onClick={() => !opening && (at ? setAt(null) : show())}
      >
        {opening ? <LoaderCircle size={22} className="spin" /> : <Plus size={22} />}
      </button>
      <input ref={files} type="file" multiple hidden onChange={(e) => choose(e.target.files, e.target)} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => choose(e.target.files, e.target)} />
      {at &&
        createPortal(
          <AddMenu
            at={at}
            onClose={() => setAt(null)}
            onFiles={() => {
              setOpening(true)
              files.current?.click()
            }}
            onCamera={() => camera.current?.click()}
            onSketch={() => setSketching(true)}
          />,
          document.body
        )}
      {sketching &&
        createPortal(
          <SketchPad
            onClose={() => setSketching(false)}
            onDone={(file) => {
              setSketching(false)
              onPick([file])
            }}
          />,
          document.body
        )}
    </>
  )
}

function AddMenu({ at, onClose, onFiles, onCamera, onSketch }: { at: { left: number; bottom: number }; onClose: () => void; onFiles: () => void; onCamera: () => void; onSketch: () => void }) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    first.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    // A turned screen moves the button: the menu goes rather than hang where the button was.
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  // The chosen item does its work at once (the system's chooser needs the press that asked for it), and the menu goes away.
  const item = (label: string, icon: React.ReactNode, run: () => void, ref?: React.Ref<HTMLButtonElement>) => (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      className="addmenu-item"
      onClick={() => {
        buzz(8)
        run()
        onClose()
      }}
    >
      {icon}
      {label}
    </button>
  )
  return (
    <div className="addmenu-layer" onPointerDown={onClose}>
      <div className="addmenu" role="menu" aria-label="Add to the message" style={{ left: at.left, bottom: at.bottom }} onPointerDown={(e) => e.stopPropagation()}>
        {item('Attach files', <Paperclip size={20} />, onFiles, first)}
        {item('Take a photo', <Camera size={20} />, onCamera)}
        {item('Draw a sketch', <PenLine size={20} />, onSketch)}
      </div>
    </div>
  )
}
