import type { ReactNode } from 'react'
import { ArrowRight, Code, MessageSquare, Workflow } from 'lucide-react'
import type { SessionMode, UserInput } from '@shared/agent'
import { greetingFor } from '@/lib/format'
import { GlowArc } from '@/glow/GlowArc'
import { useDrafts } from '@/stores/drafts'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { Composer } from './Composer'
import { DropZone, useAttachments } from './attachments'

const SUGGESTIONS: Record<SessionMode, { icon: typeof Code; text: string }[]> = {
  chat: [
    { icon: MessageSquare, text: 'Review PR #3421' },
    { icon: Code, text: 'Analyze Jira SC-1234' },
    { icon: Workflow, text: 'Create deployment workflow' }
  ],
  develop: [
    { icon: Code, text: 'Explain how this project is organized' },
    { icon: MessageSquare, text: 'Find and fix the failing tests' },
    { icon: Workflow, text: 'Add input validation to the login form' }
  ]
}

/**
 * The home screen of Chat and Develop, from design/Inner chat design.jpeg:
 * eyebrow, greeting, composer, three suggestions, over the glow arc.
 */
export function ChatHome({
  mode,
  onSend,
  extras,
  greeting
}: {
  mode: SessionMode
  onSend: (input: UserInput) => void
  /** Overrides the time-of-day greeting. Used when comparing with the picture. */
  greeting?: string
  /** Rendered between the subtitle and the composer (Develop puts its project picker here). */
  extras?: ReactNode
}) {
  const userName = useSettings((s) => s.userName)
  const draft = useUi((s) => s.draft)
  const setDraft = useUi((s) => s.setDraft)
  // What you type here is saved as a draft, so it is still there after a restart.
  const draftKey = `home:${mode}`
  const attachments = useAttachments(draftKey)
  const text = useDrafts((s) => s.drafts[draftKey]?.text ?? '')
  const setText = (t: string) => useDrafts.getState().setText(draftKey, t)

  return (
    <DropZone onFiles={(f) => void attachments.add(f)} className="h-full">
      <div className="relative h-full min-h-0 overflow-hidden">
        <GlowArc />
        <div className="relative z-10 mx-auto flex h-full w-[min(881px,calc(100%-96px))] -translate-x-0.5 flex-col justify-center pt-[102px] pb-6">
          <div className="text-xs font-medium tracking-[0.22em] text-ink-muted/80 uppercase">Your AI workbench</div>
          <h1 className="mt-[26px] text-[54px] leading-[1.1] font-bold text-ink">
            {greeting ?? greetingFor()},{' '}
            <span className="bg-gradient-to-r from-[#f45f9d] via-[#c06ae0] to-[#8f8aff] bg-clip-text text-transparent">
              {userName}.
            </span>
          </h1>
          <p className="mt-[16px] text-[27.5px] leading-9 font-light text-ink-soft">
            {mode === 'develop' ? 'Which project are we working on?' : 'What would you like to work on today?'}
          </p>

          {extras && <div className="mt-8">{extras}</div>}

          <div className={extras ? 'mt-4' : 'mt-[58px]'}>
            <Composer
              variant="home"
              mode={mode}
              text={text}
              onText={setText}
              prefs={draft}
              onPrefs={setDraft}
              attachments={attachments}
              onSend={(input) => {
                onSend(input)
                useDrafts.getState().clear(draftKey)
              }}
              autoFocus
            />
          </div>

          <div className="mt-[41px] flex flex-wrap items-center justify-center gap-5">
            {SUGGESTIONS[mode].map(({ icon: Icon, text: s }) => (
              <button
                key={s}
                type="button"
                onClick={() => setText(s)}
                className="group flex h-[50px] items-center gap-3.5 rounded-full border border-edge-strong bg-panel/30 pr-[17px] pl-6 text-[14.5px] text-ink transition-colors hover:border-accent-edge hover:bg-raised/70"
              >
                <Icon className="h-[18px] w-[18px] text-ink-soft" />
                {s}
                <ArrowRight className="ml-[21px] h-4 w-4 text-ink-soft transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </DropZone>
  )
}
