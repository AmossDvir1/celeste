import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Database, Globe, Info, Monitor, MousePointer2, Moon, Plug, Settings as SettingsIcon, Smartphone, Sun, Laptop, X, Plug2 } from 'lucide-react'
import { PhoneSettings } from '@/features/phone/PhoneSettings'
import { cn } from '@/lib/cn'
import { Modal } from '@/components/Dialog'
import { Field, SelectField } from '@/components/form'
import { Button, IconButton, Switch, TextInput } from '@/components/ui'
import { APPROVAL_OPTIONS, VENDORS, VENDOR_ORDER } from '@/lib/vendors'
import { useModels } from '@/stores/models'
import { core, revealDataFolder } from '@/api'
import type { DesktopGrantRecord, UpdateInfo } from '@shared/api'
import type { BrowserPrefs } from '@shared/browser'
import { browserCall, useBrowser } from '@/stores/browser'
import { useSessions } from '@/stores/sessions'
import { useSettings, type ThemePref } from '@/stores/settings'
import { useUi, type SettingsSection } from '@/stores/ui'
import { openExternal, useVendors } from '@/stores/vendors'
import { DevicesSettings } from '@/features/devices/DevicesSettings'
import { McpSettings } from '@/features/tools/McpSettings'
import { SeparateCopies } from './SeparateCopies'
import { VendorCard } from './VendorCard'

const AUTHOR_URL = 'https://github.com/AmossDvir1'

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Bot }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'vendors', label: 'AI vendors', icon: Plug2 },
  { id: 'tools', label: 'Tools & Integrations', icon: Plug },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'desktop', label: 'Desktop control', icon: MousePointer2 },
  { id: 'phone', label: 'Phone', icon: Smartphone },
  { id: 'devices', label: 'Devices', icon: Monitor },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'about', label: 'About', icon: Info }
]

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      <div className="mt-6 space-y-6">{children}</div>
    </div>
  )
}

/** The last times the assistant had the screen: when, what for, what it could use, how long, how many actions, how it ended. */
function RecentGrants() {
  const [grants, setGrants] = useState<DesktopGrantRecord[] | null>(null)
  useEffect(() => {
    let live = true
    void core.call('desktop.grants').then((list) => live && setGrants(list), () => live && setGrants([]))
    return () => {
      live = false
    }
  }, [])
  if (!grants?.length) return null
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] text-ink-muted">Recent times the assistant had the screen</div>
      <ul className="space-y-1.5 text-[12.5px] leading-snug text-ink-muted">
        {grants.slice(0, 8).map((g) => (
          <li key={g.at} className="rounded-lg bg-field px-3 py-2">
            <div className="text-ink">{g.reason}</div>
            <div>
              {new Date(g.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {g.scope} · {Math.max(1, Math.round(g.ms / 60_000))} min · {g.actions} {g.actions === 1 ? 'action' : 'actions'} · {g.why}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Programs the assistant never sees or touches, whatever it was allowed. Saved when the box loses the keyboard, so a half-typed name is not saved. */
function NeverApps() {
  const saved = useSettings((st) => st.desktopNeverApps)
  const set = useSettings((st) => st.set)
  const [text, setText] = useState(saved.join(', '))
  return (
    <Field label="Never touch these" hint="Program names or words in a window's title, separated by commas. They are painted over in what the assistant sees, and clicks and typing into them are refused. Only as good as what you add.">
      {(id) => (
        <TextInput
          id={id}
          value={text}
          placeholder="keepass, 1password, bitwarden, my bank"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const list = [...new Set(text.split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 50)
            setText(list.join(', '))
            set({ desktopNeverApps: list })
          }}
        />
      )}
    </Field>
  )
}

/** The sites the person chose "Always allow" for, each with a way to take it back. */
function AllowedSites() {
  const sites = useSettings((st) => st.browserAllowedSites)
  const set = useSettings((st) => st.set)
  // The assistant adds to this list while Settings is closed, so what Core has is read when it opens.
  useEffect(() => {
    let live = true
    void core.call('settings.get').then((s) => live && useSettings.setState({ browserAllowedSites: s.browserAllowedSites }), () => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!sites.length) return null
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] text-ink-muted">Sites it may always use</div>
      <ul className="space-y-1.5">
        {sites.map((site) => (
          <li key={site} className="flex items-center justify-between gap-3 rounded-lg bg-field px-3 py-1.5 text-[13.5px] text-ink">
            <span className="min-w-0 truncate">{site}</span>
            <IconButton label={`Stop always allowing ${site}`} size="sm" onClick={() => set({ browserAllowedSites: sites.filter((s) => s !== site) })}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The browser: what the assistant may do in it, the person's own settings for it, and whether other programs may use it. */
function BrowserSection() {
  const settings = useSettings()
  const prefs = useBrowser((s) => s.prefs)
  const external = useBrowser((s) => s.external)
  const pushToast = useUi((s) => s.pushToast)
  const failed = () => pushToast({ text: 'Could not change that.' })
  const setPrefs = (patch: Partial<BrowserPrefs>) => void browserCall('setPrefs', patch).catch(failed)
  return (
    <Section title="Browser" description="Celeste’s own browser, beside the chat. You can use it, and so can the assistant.">
      <Row title="Let the assistant use the browser" description="It can open pages, read them, click, type and take pictures of them, in its own chat’s tabs. A chat set to Ask asks before it uses a new site. Off: the browser is only yours.">
        <Switch label="Let the assistant use the browser" checked={settings.browserTools} onCheckedChange={(browserTools) => settings.set({ browserTools })} />
      </Row>
      <AllowedSites />

      <Row title="Keep cookies" description="Stay signed in to sites after you quit Celeste. Off: the browser starts signed out each time.">
        <Switch label="Keep cookies" checked={prefs.keepCookies} onCheckedChange={(keepCookies) => setPrefs({ keepCookies })} />
      </Row>

      <div className="space-y-3">
        <Row title="Let other programs control Celeste’s browser" description="Such as Playwright or Playwright MCP, on this computer. Off by default. They see only the browser’s tabs, never Celeste’s windows, and turning this off disconnects them at once.">
          <Switch label="Let other programs control Celeste’s browser" checked={external.endpoint !== null} onCheckedChange={(on) => void browserCall('external', { on }).catch(failed)} />
        </Row>
        {external.endpoint && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <TextInput aria-label="Address for other programs" readOnly value={external.endpoint} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(external.endpoint ?? '').then(() => pushToast({ text: 'Copied the address.' }), failed)}>
                Copy
              </Button>
            </div>
            <p className="text-[13px] text-ink-muted">
              {external.clients === 0 ? 'No program is connected.' : external.clients === 1 ? '1 program is connected.' : `${external.clients} programs are connected.`} The address works only while this is on, and it
              changes each time Celeste starts. Anyone who has it can use the browser, including the sites you are signed in to there.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2 text-[13px] leading-relaxed text-ink-muted">
        <p>The browser is a real one: sites, sign-ins and video work as in any browser. It starts signed out, separate from your own browser, and Celeste does not see or send where you go.</p>
        <p>
          When an assistant uses it, what it reads from a page, the pictures it takes and what it types go to your AI vendor, like anything else in the chat. A page can contain text that tries to steer the assistant, which is why it asks before using a new
          site, and why it is told never to follow what a page says. It is also told not to buy anything, create an account or get past a CAPTCHA without asking you.
        </p>
      </div>
    </Section>
  )
}

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-[14px] text-ink">{title}</div>
        {description && <div className="text-[13px] text-ink-muted">{description}</div>}
      </div>
      {children}
    </div>
  )
}

/** A small picture of each theme, so the choice is visual. */
export function ThemeTiles({ value, onChange }: { value: ThemePref; onChange: (t: ThemePref) => void }) {
  const tiles: { id: ThemePref; label: string; icon: typeof Sun; bg: string; panel: string; line: string }[] = [
    { id: 'dark', label: 'Dark', icon: Moon, bg: '#080c17', panel: '#0b111e', line: '#f5487f' },
    { id: 'light', label: 'Light', icon: Sun, bg: '#f7f8fc', panel: '#ffffff', line: '#f5487f' },
    { id: 'system', label: 'System', icon: Laptop, bg: 'linear-gradient(90deg,#080c17 50%,#f7f8fc 50%)', panel: 'transparent', line: '#f5487f' }
  ]
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
      {tiles.map((t) => {
        const on = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(t.id)}
            className={cn('rounded-xl border p-2.5 text-left transition-colors', on ? 'border-accent bg-accent-soft' : 'border-edge hover:border-edge-strong')}
          >
            <div className="relative h-[84px] overflow-hidden rounded-lg border border-black/10" style={{ background: t.bg }}>
              <div className="absolute inset-x-3 top-3 h-2 rounded-full opacity-90" style={{ background: t.line, width: '38%' }} />
              <div className="absolute inset-x-3 top-8 bottom-3 rounded-md" style={{ background: t.panel, opacity: t.id === 'system' ? 0 : 1 }} />
            </div>
            <div className="mt-2.5 flex items-center gap-2 px-0.5 text-[14px] text-ink">
              <t.icon className="h-4 w-4 text-ink-muted" />
              {t.label}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function ApprovalCards({ value, onChange }: { value: string; onChange: (v: 'auto' | 'edits' | 'ask') => void }) {
  const options = APPROVAL_OPTIONS.filter((o) => !o.developOnly)
  return (
    <div role="radiogroup" aria-label="Default approval" className="space-y-2">
      {options.map((o) => {
        const on = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value as 'auto' | 'edits' | 'ask')}
            className={cn('flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors', on ? 'border-accent-edge bg-accent-soft' : 'border-edge hover:border-edge-strong')}
          >
            <span className={cn('mt-0.5 h-[18px] w-[18px] shrink-0 rounded-full border-2', on ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_var(--c-panel)]' : 'border-edge-strong')} />
            <span>
              <span className="block text-[14px] text-ink">
                {o.label} {o.value === 'auto' && <span className="ml-1 text-[11px] text-ink-faint">default</span>}
              </span>
              <span className="block text-[13px] text-ink-muted">{o.description}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function ModelSelect({ value, onChange, id }: { value: string; onChange: (id: string) => void; id?: string }) {
  const vendors = useVendors((s) => s.vendors)
  const models = useModels((s) => s.list)
  const connected = VENDOR_ORDER.filter((v) => vendors[v].status === 'connected')
  return (
    <SelectField id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {connected.length === 0 && <option value={value}>Connect a vendor first</option>}
      {connected.map((v) => (
        <optgroup key={v} label={VENDORS[v].menuLabel}>
          {models.filter((m) => m.vendor === v).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </SelectField>
  )
}

const NOTICES = [
  ['Electron', 'MIT'],
  ['React', 'MIT'],
  ['Tailwind CSS', 'MIT'],
  ['Radix UI', 'MIT'],
  ['React Flow', 'MIT'],
  ['Zustand', 'MIT'],
  ['Lucide icons', 'ISC'],
  ['react-markdown', 'MIT'],
  ['Outfit font', 'SIL Open Font License'],
  ['JetBrains Mono font', 'SIL Open Font License']
]

/** Asks GitHub for the newest version, when the person asks, and says so plainly. */
function UpdateCheck() {
  const [state, setState] = useState<{ busy: boolean; info?: UpdateInfo; error?: string }>({ busy: false })
  const check = () => {
    setState({ busy: true })
    core.call('app.checkUpdate').then(
      (info) => setState({ busy: false, info }),
      (err: unknown) => setState({ busy: false, error: err instanceof Error ? err.message : 'Could not check.' })
    )
  }
  const { info } = state
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" onClick={check} disabled={state.busy}>
        {state.busy ? 'Looking…' : 'Check for updates'}
      </Button>
      <span role="status" className="text-[13px] text-ink-muted">
        {state.error ? <span className="text-danger">{state.error}</span> : null}
        {info && !info.newer && (info.latest ? `You have the newest version (${info.current}).` : `No newer version has been published (this is ${info.current}).`)}
        {info?.newer && (
          <>
            Version {info.latest} is available.{' '}
            <button type="button" onClick={() => info.url && openExternal(info.url)} className="text-accent-text underline underline-offset-2 hover:brightness-110">
              Open the download page
            </button>
          </>
        )}
      </span>
    </div>
  )
}

function Content({ section }: { section: SettingsSection }) {
  const settings = useSettings()
  const pushToast = useUi((s) => s.pushToast)
  const resetDraft = useUi((s) => s.resetDraft)
  const dataDir = useUi((s) => s.dataDir)
  const version = useUi((s) => s.version)
  const [confirmDelete, setConfirmDelete] = useState(false)

  switch (section) {
    case 'general':
      return (
        <Section title="General" description="Celeste uses your name in the greeting. A new chat starts with the model and the approval you pick here, and you can change them in any chat.">
          <Field label="Your name">{(id) => <TextInput id={id} value={settings.userName} onChange={(e) => settings.set({ userName: e.target.value })} className="max-w-sm" />}</Field>
          <ThemeTiles value={settings.theme} onChange={(theme) => settings.set({ theme })} />
          <Field label="Default model">
            {(id) => (
              <ModelSelect
                id={id}
                value={settings.defaults.model}
                onChange={(model) => {
                  settings.setDefaults({ model })
                  resetDraft()
                }}
              />
            )}
          </Field>
          <div className="space-y-2">
            <div className="text-[13px] text-ink-muted">When the agent wants to act</div>
            <ApprovalCards
              value={settings.defaults.approval}
              onChange={(approval) => {
                settings.setDefaults({ approval })
                resetDraft()
              }}
            />
          </div>
        </Section>
      )
    case 'vendors':
      return (
        <Section title="AI vendors" description="Connect the assistants you use. One is enough, and you can add more any time.">
          <div className="space-y-3">
            {VENDOR_ORDER.map((id) => (
              <VendorCard key={id} id={id} />
            ))}
          </div>
          <p className="text-[13px] leading-relaxed text-ink-faint">
            Celeste has no server of its own. What you ask goes from this computer to your own account with each vendor, and each vendor’s terms apply.
          </p>
        </Section>
      )
    case 'browser':
      return <BrowserSection />
    case 'desktop':
      return (
        <Section title="Desktop control" description="Lets the assistant ask to use this computer's screen, mouse and keyboard, for tasks that have no command or tool, such as clicking through a settings page.">
          <Row title="Let the assistant ask to control this computer" description="Off by default. Even when this is on, it can do nothing until you press Allow on a card in the conversation.">
            <Switch label="Let the assistant ask to control this computer" checked={settings.desktopControl} onCheckedChange={(desktopControl) => settings.set({ desktopControl })} />
          </Row>
          <NeverApps />
          <RecentGrants />
          <div className="space-y-2 text-[13px] leading-relaxed text-ink-muted">
            <p>Each time, a card asks how long: 20 minutes unless you move the slider, up to 2 hours. A bar stays on screen with a Stop button, and Ctrl+Alt+Esc stops it at once from anywhere.</p>
            <p>It asks you again before a button called Send, Buy, Delete or Allow, never types into password fields, and pauses when you move the mouse. What it sees goes to your AI vendor.</p>
            <details className="text-ink-faint">
              <summary className="cursor-pointer text-ink-muted">More about what it can do</summary>
              <div className="mt-2 space-y-2">
                <p>It can be limited to one program or window, which hides the rest of the screen from it and is what it is told to ask for. With the whole screen it can see everything and click and type anywhere you can, so it could send a message, delete something or change a setting. Celeste's checkpoints cannot undo a click.</p>
                <p>Websites, documents and emails on the screen can contain text that tries to steer it. For anything sensitive, close it first, or use a separate user account or a virtual machine.</p>
                <p>Works on Windows for now. It cannot control programs that run as an administrator, the sign-in screen or the lock screen, or Celeste's own windows.</p>
              </div>
            </details>
          </div>
        </Section>
      )
    case 'tools':
      return (
        <Section title="Tools & Integrations" description="One list of tools, shared by every vendor. Add an internal tool once and any assistant can use it.">
          <McpSettings />
        </Section>
      )
    case 'phone':
      return (
        <Section title="Phone" description="Use Celeste from your Android phone: chat, follow your sessions, and answer what the assistant asks, on the same Wi-Fi.">
          <PhoneSettings />
        </Section>
      )
    case 'devices':
      return (
        <Section title="Devices" description="VMs, other computers and Android phones the assistant can work on.">
          <DevicesSettings />
        </Section>
      )
    case 'data':
      return (
        <Section title="Data" description="Your sessions stay on this computer.">
          <Row title="Storage location" description={dataDir || 'Not available'}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void revealDataFolder().then((shown) => !shown && pushToast({ text: 'Your files can only be shown from the Celeste app.' }))}
            >
              Show in folder
            </Button>
          </Row>
          <SeparateCopies />
          <div className="rounded-xl border border-danger/30 p-4">
            <Row title="Delete all sessions" description="Removes every chat and Develop session from this computer. This cannot be undone.">
              {confirmDelete ? (
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      void useSessions.getState().removeAll()
                      setConfirmDelete(false)
                    }}
                  >
                    Yes, delete everything
                  </Button>
                </div>
              ) : (
                <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </Button>
              )}
            </Row>
          </div>
        </Section>
      )
    case 'about':
      return (
        <Section title="About Celeste" description={`Version ${version || '…'}. Works with GitHub Copilot and Claude; OpenAI and Gemini are coming soon.`}>
          <UpdateCheck />
          <p className="text-[13.5px] leading-relaxed text-ink-muted">
            Created by{' '}
            <button type="button" onClick={() => openExternal(AUTHOR_URL)} className="text-accent-text underline underline-offset-2 hover:brightness-110">
              Amoss Dvir
            </button>{' '}
            on GitHub.
          </p>
          <p className="text-[13px] leading-relaxed text-ink-faint">
            Celeste has no server of its own and collects nothing: your chats, workflows and settings stay on this computer, and what you ask goes from here to your own account with each vendor. It looks for a new version only when you press the button above.
          </p>
          <div>
            <h3 className="text-[14px] text-ink">Open-source software in this app</h3>
            <ul className="mt-3 divide-y divide-edge/70 rounded-xl border border-edge">
              {NOTICES.map(([name, license]) => (
                <li key={name} className="flex items-center justify-between px-4 py-2 text-[13.5px] text-ink-muted">
                  {name}
                  <span className="text-ink-faint">{license}</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )
  }
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen)
  const section = useUi((s) => s.settingsSection)
  const closeSettings = useUi((s) => s.closeSettings)
  const openSettings = useUi((s) => s.openSettings)

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && closeSettings()}
      title="Settings"
      hideTitle
      className="h-[min(700px,90vh)] w-[min(1000px,calc(100vw-64px))] max-h-none"
    >
      <div className="flex h-full">
        <nav aria-label="Settings sections" className="flex w-[230px] shrink-0 flex-col gap-0.5 border-r border-edge bg-canvas/60 p-3">
          <div className="px-3 pt-2 pb-3 text-[17px] font-semibold text-ink">Settings</div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => openSettings(id)}
              className={cn(
                'flex h-10 items-center gap-3 rounded-lg px-3 text-left text-[14px] transition-colors',
                section === id ? 'bg-select text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink'
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </button>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto p-8 pr-10">
          <IconButton label="Close settings" onClick={closeSettings} className="absolute top-4 right-4">
            <X className="h-[18px] w-[18px]" />
          </IconButton>
          <Content section={section} />
        </div>
      </div>
    </Modal>
  )
}
