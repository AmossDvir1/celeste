import { X } from 'lucide-react'
import type { ApprovalMode, SessionMode } from '@shared/agent'
import type { ScenarioId } from '@/mocks/engine'
import { useSessions } from '@/stores/sessions'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'

/*
 * Scenario switcher for reviewing the design (Ctrl+Shift+D). Development builds only:
 * it is not included in release builds.
 */

function play(mode: SessionMode, scenario: ScenarioId, text: string, approval?: ApprovalMode) {
  const ui = useUi.getState()
  const sessions = useSessions.getState()
  ui.setMode(mode)
  sessions.home(mode)
  ui.resetDraft()
  if (approval) ui.setDraft({ approval })
  sessions.setForcedScenario(scenario)
  sessions.send(mode, { text, attachments: [] })
  ui.resetDraft()
}

const SCENARIOS: { label: string; hint: string; run: () => void }[] = [
  {
    label: 'Empty',
    hint: 'Chat home',
    run: () => {
      const ui = useUi.getState()
      ui.setMode('chat')
      useSessions.getState().home('chat')
      ui.resetDraft()
    }
  },
  { label: 'Thinking', hint: 'Shimmering “Thinking”', run: () => play('chat', 'stuck-thinking', 'Help me plan the migration') },
  { label: 'Tool running', hint: 'A command streams output', run: () => play('develop', 'stuck-tool', 'Build the project and tell me what breaks') },
  { label: 'ask_user', hint: 'Two questions, one pending', run: () => play('chat', 'ask', 'Roll out the KB update, ask me what you need') },
  { label: 'Approval prompt', hint: 'Develop with “Ask first”', run: () => play('develop', 'auto', 'Add input validation to the login form', 'ask') },
  { label: 'Error', hint: 'Rate limit with retry', run: () => play('chat', 'error', 'Check the status page') },
  {
    label: 'Long conversation',
    hint: 'Markdown, table, code',
    run: () => {
      useUi.getState().setMode('chat')
      useSessions.getState().open('seed-wfo')
    }
  },
  {
    label: 'Develop with diffs',
    hint: 'Edits, tests, Changes panel',
    run: () => {
      useUi.getState().setMode('develop')
      useSessions.getState().open('seed-checkout')
      useUi.getState().setRight('changes')
    }
  },
  {
    label: 'Image attachment',
    hint: 'Hover the screenshot',
    run: () => {
      useUi.getState().setMode('chat')
      useSessions.getState().open('seed-build')
    }
  },
  {
    label: 'Setup wizard',
    hint: 'First-run steps',
    run: () => useUi.getState().setWizardOpen(true)
  }
]

export function DevMenu() {
  const open = useUi((s) => s.devMenuOpen)
  const setOpen = useUi((s) => s.setDevMenuOpen)
  const theme = useSettings((s) => s.theme)
  const set = useSettings((s) => s.set)
  if (!open) return null
  return (
    <aside
      aria-label="Scenario switcher"
      className="animate-fade-up fixed right-4 bottom-4 z-[95] w-[270px] rounded-xl border border-edge-strong bg-raised-2 p-2 shadow-pop"
    >
      <div className="flex items-center justify-between px-2 pt-1 pb-2">
        <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">Scenarios (dev only)</span>
        <button type="button" aria-label="Close scenario switcher" onClick={() => setOpen(false)} className="rounded-md p-1 text-ink-muted hover:bg-hover hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul>
        {SCENARIOS.map((s) => (
          <li key={s.label}>
            <button
              type="button"
              onClick={() => {
                s.run()
              }}
              className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
            >
              <span className="text-[13.5px] text-ink">{s.label}</span>
              <span className="text-[11.5px] text-ink-faint">{s.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1 border-t border-edge pt-2">
        <button
          type="button"
          onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })}
          className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13.5px] text-ink hover:bg-hover"
        >
          Switch to {theme === 'dark' ? 'light' : 'dark'} theme
        </button>
      </div>
    </aside>
  )
}
