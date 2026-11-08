import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Field } from '@/components/form'
import { Logo } from '@/components/Logo'
import { VendorLogo } from '@/components/VendorLogo'
import { Button, TextInput } from '@/components/ui'
import { GlowArc } from '@/glow/GlowArc'
import { ApprovalCards, ModelSelect, ThemeTiles } from '@/features/settings/SettingsDialog'
import { VendorCard } from '@/features/settings/VendorCard'
import { VENDOR_ORDER } from '@/lib/vendors'
import { lookupModel, useModels } from '@/stores/models'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { useVendors, connectedVendors } from '@/stores/vendors'

const STEPS = ['Welcome', 'Appearance', 'Connect', 'Defaults', 'Ready'] as const

/**
 * First-run setup: five short steps, one idea each. Everything can be changed later in Settings.
 * It is also reachable from the account menu ("Run setup again").
 */
export function Wizard() {
  const settings = useSettings()
  const setWizardOpen = useUi((s) => s.setWizardOpen)
  const resetDraft = useUi((s) => s.resetDraft)
  const vendors = useVendors((s) => s.vendors)
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings.userName)
  const heading = useRef<HTMLHeadingElement>(null)
  const connected = connectedVendors(vendors)

  useEffect(() => heading.current?.focus(), [step])

  const finish = () => {
    settings.set({ userName: name.trim() || 'there', wizardDone: true })
    resetDraft()
    setWizardOpen(false)
  }
  const last = step === STEPS.length - 1
  const byId = useModels((s) => s.byId)
  const model = lookupModel(byId, settings.defaults.model)

  return (
    <div role="dialog" aria-modal="true" aria-label="Set up Celeste" className="fixed inset-0 z-[80] flex flex-col bg-canvas text-ink">
      <GlowArc />
      <header
        className="app-drag relative z-10 flex h-14 shrink-0 items-center px-6"
        style={{ paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 24px)' }}
      >
        <div className="flex items-center gap-3">
          <Logo size={34} />
          <span className="text-[20px] font-semibold">celeste</span>
        </div>
        <button type="button" onClick={finish} className="app-no-drag ml-auto rounded-md px-2 py-1 text-[13px] text-ink-muted hover:text-ink">
          Skip setup
        </button>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-6">
        <div className="w-[min(640px,100%)]">
          <div className="mb-8 flex items-center gap-3" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
            <div className="flex gap-1.5">
              {STEPS.map((s, i) => (
                <span key={s} className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-8 bg-accent' : i < step ? 'w-4 bg-accent/60' : 'w-4 bg-edge-strong')} />
              ))}
            </div>
            <span className="text-xs text-ink-faint">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>

          <div key={step} className="animate-fade-up">
            {step === 0 && (
              <>
                <h1 ref={heading} tabIndex={-1} className="text-[40px] leading-tight font-bold outline-none">
                  Welcome to Celeste
                </h1>
                <p className="mt-3 text-[20px] font-light text-ink-soft">One place for your AI assistants. This takes about a minute.</p>
                <Field label="What should we call you?" className="mt-9">
                  {(id) => <TextInput id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setStep(1)} className="h-12 text-[16px]" />}
                </Field>
              </>
            )}

            {step === 1 && (
              <>
                <h1 ref={heading} tabIndex={-1} className="text-[34px] leading-tight font-bold outline-none">
                  Pick a look
                </h1>
                <p className="mt-2 text-[17px] text-ink-muted">It changes right now, so you can see it.</p>
                <div className="mt-8">
                  <ThemeTiles value={settings.theme} onChange={(theme) => settings.set({ theme })} />
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h1 ref={heading} tabIndex={-1} className="text-[34px] leading-tight font-bold outline-none">
                  Connect an AI vendor
                </h1>
                <p className="mt-2 text-[17px] text-ink-muted">One is enough. You can add more later in Settings.</p>
                <div className="mt-6 space-y-3">
                  {VENDOR_ORDER.map((id) => (
                    <VendorCard key={id} id={id} compact />
                  ))}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h1 ref={heading} tabIndex={-1} className="text-[34px] leading-tight font-bold outline-none">
                  How should it work?
                </h1>
                <p className="mt-2 text-[17px] text-ink-muted">Sensible starting points. Every chat can change them.</p>
                <div className="mt-7 space-y-6">
                  <Field label="Default model">
                    {(id) => <ModelSelect id={id} value={settings.defaults.model} onChange={(m) => settings.setDefaults({ model: m })} />}
                  </Field>
                  <div className="space-y-2">
                    <div className="text-[13px] text-ink-muted">When the agent wants to act</div>
                    <ApprovalCards value={settings.defaults.approval} onChange={(approval) => settings.setDefaults({ approval })} />
                    <p className="text-[12.5px] leading-relaxed text-ink-faint">
                      With auto-approve, the agent edits files and runs commands as you, without asking. You can switch to asking first from the box where you type.
                    </p>
                  </div>
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <h1 ref={heading} tabIndex={-1} className="text-[40px] leading-tight font-bold outline-none">
                  You’re all set, <span className="bg-gradient-to-r from-[#f45f9d] via-[#c06ae0] to-[#8f8aff] bg-clip-text text-transparent">{name.trim() || 'there'}.</span>
                </h1>
                <ul className="mt-8 divide-y divide-edge/70 rounded-xl border border-edge bg-field/40">
                  {(
                    [
                      ['Look', settings.theme === 'system' ? 'Follows your system' : settings.theme === 'dark' ? 'Dark' : 'Light'],
                      [
                        'Connected',
                        connected.length ? (
                          <>
                            <span className="flex items-center gap-1.5">
                              {connected.map((id) => (
                                <VendorLogo key={id} id={id} className="h-4 w-4" />
                              ))}
                            </span>
                            {connected.length} vendor{connected.length > 1 ? 's' : ''}
                          </>
                        ) : (
                          'None yet (add one in Settings)'
                        )
                      ],
                      [
                        'Default model',
                        model ? (
                          <>
                            <VendorLogo id={model.vendor} className="h-4 w-4" />
                            {model.label}
                          </>
                        ) : (
                          '—'
                        )
                      ],
                      ['Approval', settings.defaults.approval === 'auto' ? 'Auto-approve' : settings.defaults.approval === 'edits' ? 'Approve edits' : 'Ask first']
                    ] as [string, ReactNode][]
                  ).map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between px-4 py-3 text-[14px]">
                      <span className="text-ink-muted">{k}</span>
                      <span className="flex items-center gap-2 text-ink">
                        <Check className="h-4 w-4 text-success" /> {v}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="mt-10 flex items-center gap-3">
            {step > 0 && (
              <Button variant="ghost" size="lg" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button
              variant={step === 2 && connected.length === 0 ? 'secondary' : 'primary'}
              size="lg"
              className="ml-auto min-w-[140px]"
              onClick={() => (last ? finish() : setStep(step + 1))}
            >
              {last ? 'Start chatting' : step === 2 && connected.length === 0 ? 'Skip for now' : 'Continue'}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}
