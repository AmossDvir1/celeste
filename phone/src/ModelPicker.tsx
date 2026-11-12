import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Pin } from 'lucide-react'
import type { Effort, ModelInfo, VendorId } from '@shared/agent'
import type { PhoneModelChoice } from '@shared/phone'
import { VendorLogo } from '@/components/VendorLogo'
import { useApp } from './store'
import { Shimmer, buzz } from './ui'

/*
 * The model and its thinking effort, as on the computer: a chip above the message box, and a sheet to choose from the
 * assistants connected there. In a chat the list keeps to the chat's own assistant, since a chat cannot change it.
 */

const VENDOR_NAME: Record<VendorId, string> = { copilot: 'GitHub Copilot', claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' }
const EFFORT_NAME: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }

/** A name for a model the list does not have (yet): its saved id, tidied. */
function labelOf(id: string): string {
  const bare = id.replace(/^claude:/, '').replace(/^copilot-/, '')
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'Model'
}

/** The effort to keep after switching models: the current one if the new model takes it, else the model's own. */
export function effortFor(model: ModelInfo, current: Effort | null | undefined): Effort | null {
  if (model.efforts.length === 0) return null
  if (current && model.efforts.includes(current)) return current
  return model.defaultEffort ?? model.efforts[0] ?? null
}

export function ModelChip({
  value,
  vendor,
  only,
  onChange
}: {
  value: { model: string; effort: Effort | null }
  /** The assistant `value.model` belongs to, when known. */
  vendor?: VendorId
  /** Offer only this assistant's models (a chat that already started). */
  only?: VendorId
  onChange: (choice: PhoneModelChoice) => void
}) {
  const models = useApp((s) => s.models)
  const online = useApp((s) => s.linkState === 'connected')
  const [open, setOpen] = useState(false)
  const found = models?.models.find((m) => m.id === value.model)
  const shownEffort = found ? effortFor(found, value.effort) : value.effort
  const v = found?.vendor ?? vendor ?? (value.model.startsWith('claude') ? 'claude' : 'copilot')
  // Read again each time the sheet opens: the person may have connected an assistant on the computer meanwhile.
  useEffect(() => {
    if (online && (open || !models)) void useApp.getState().loadModels()
  }, [open, online])
  return (
    <>
      <button
        type="button"
        className="mchip"
        aria-label={`Model: ${found?.label ?? labelOf(value.model)}`}
        disabled={!online}
        onClick={() => {
          buzz(5)
          setOpen(true)
        }}
      >
        <VendorLogo id={v} className="vlogo" />
        <span className="nm">{found?.label ?? labelOf(value.model)}</span>
        {shownEffort ? <span className="ef">· {EFFORT_NAME[shownEffort]}</span> : null}
        <ChevronDown size={14} className="faint" />
      </button>
      {/* Over the whole app, as the request cards are, not inside the message box. */}
      {open && createPortal(<ModelSheet value={value} only={only} onChange={onChange} onClose={() => setOpen(false)} />, document.querySelector('.app') ?? document.body)}
    </>
  )
}

function ModelSheet({
  value,
  only,
  onChange,
  onClose
}: {
  value: { model: string; effort: Effort | null }
  only?: VendorId
  onChange: (choice: PhoneModelChoice) => void
  onClose: () => void
}) {
  const models = useApp((s) => s.models)
  const [leaving, setLeaving] = useState(false)
  const close = () => {
    setLeaving(true)
    setTimeout(onClose, 200)
  }
  const offered = (models?.models ?? []).filter((m) => !only || m.vendor === only)
  const pinned = offered.filter((m) => models?.pinned.includes(m.id))
  const vendors = [...new Set(offered.map((m) => m.vendor))]
  const current = offered.find((m) => m.id === value.model)
  // A session started with no effort runs at the model's own default, so that is the one to show as chosen.
  const chosenEffort = current ? effortFor(current, value.effort) : value.effort
  const pick = (m: ModelInfo) => {
    buzz(6)
    onChange({ model: m.id, effort: effortFor(m, value.effort) })
  }
  const row = (m: ModelInfo, showVendor: boolean) => {
    const on = m.id === value.model
    return (
      <button key={`${showVendor ? 'p' : 'v'}-${m.id}`} className={`mrow${on ? ' on' : ''}`} onClick={() => pick(m)}>
        {showVendor && <VendorLogo id={m.vendor} className="vlogo" />}
        <span className="grow">{m.label}</span>
        {on && <Check size={18} />}
      </button>
    )
  }
  return (
    <div className={`card-layer${leaving ? ' out' : ''}`}>
      <div className="scrim" onClick={close} />
      <div className="sheet tall" role="dialog" aria-label="Choose a model">
        <div className="handle" />
        <div className="overline" style={{ fontSize: 10 }}>
          Model
        </div>
        <h1 className="h-l" style={{ fontSize: 20, margin: '2px 0 4px' }}>
          {only ? `${VENDOR_NAME[only]} models` : 'Choose a model'}
        </h1>
        <div className="mlist">
          {models === null ? (
            <div className="empty" style={{ padding: 24 }}>
              <Shimmer>Asking the computer</Shimmer>
            </div>
          ) : offered.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              {only ? `${VENDOR_NAME[only]} is not connected on the computer now.` : 'No assistant is connected on the computer. Connect one there, in Settings.'}
            </div>
          ) : (
            <>
              {pinned.length > 0 && (
                <>
                  <div className="mgroup">
                    <Pin size={13} /> Pinned
                  </div>
                  {pinned.map((m) => row(m, true))}
                </>
              )}
              {vendors.map((vd) => {
                const own = offered.filter((m) => m.vendor === vd && !pinned.includes(m))
                return (
                  own.length > 0 && (
                    <div key={vd}>
                      <div className="mgroup">
                        <VendorLogo id={vd} className="vlogo sm" /> {VENDOR_NAME[vd]}
                      </div>
                      {own.map((m) => row(m, false))}
                    </div>
                  )
                )
              })}
            </>
          )}
        </div>
        {current && current.efforts.length > 0 && (
          <>
            <div className="mgroup" style={{ marginTop: 16 }}>
              Thinking effort
            </div>
            <div className="seg effort">
              {current.efforts.map((e) => (
                <button
                  key={e}
                  className={chosenEffort === e ? 'on' : ''}
                  onClick={() => {
                    buzz(5)
                    onChange({ model: current.id, effort: e })
                  }}
                >
                  {EFFORT_NAME[e]}
                </button>
              ))}
            </div>
          </>
        )}
        <button className="btn primary block" style={{ marginTop: 16 }} onClick={close}>
          Done
        </button>
      </div>
    </div>
  )
}
