import { useEffect, useRef, useState } from 'react'
import { Check, ShieldQuestion } from 'lucide-react'
import type { AskAnswers, Question } from '@shared/agent'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui'
import type { TimelineItem } from '@/stores/types'

/** The assistant's question, one at a time, with its options (the digit keys pick one) and a place for another answer. */
export function AskUserCard({
  item,
  onAnswer
}: {
  item: Extract<TimelineItem, { kind: 'ask' }>
  onAnswer: (answers: AskAnswers) => void
}) {
  const { questions } = item
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [typingOther, setTypingOther] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const q: Question = questions[step]
  const last = step === questions.length - 1

  useEffect(() => {
    if (item.status === 'pending') root.current?.focus()
  }, [item.status])

  if (item.status === 'answered' && item.answers) {
    return (
      <div className="max-w-[760px] space-y-1 text-[13px] text-ink-muted">
        {questions.map((qq) => {
          const a = item.answers?.[qq.question]
          return (
            <div key={qq.question} className="flex items-start gap-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <span>
                {qq.question} <span className="text-ink">{Array.isArray(a) ? a.join(', ') : a}</span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const current = picked[q.question] ?? []
  const otherText = (other[q.question] ?? '').trim()
  const hasAnswer = current.length > 0 || otherText.length > 0

  const toggle = (label: string) => {
    setPicked((p) => {
      const cur = p[q.question] ?? []
      if (q.multiSelect) return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      return { ...p, [q.question]: [label] }
    })
    if (!q.multiSelect) setOther((o) => ({ ...o, [q.question]: '' }))
  }

  const finish = () => {
    const answers: AskAnswers = {}
    for (const qq of questions) {
      const labels = picked[qq.question] ?? []
      const free = (other[qq.question] ?? '').trim()
      const all = free ? [...labels, free] : labels
      answers[qq.question] = qq.multiSelect ? all : (all[0] ?? '')
    }
    onAnswer(answers)
  }
  const next = () => {
    if (!hasAnswer) return
    if (last) finish()
    else {
      setStep(step + 1)
      setTypingOther(false)
    }
  }

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label="Celeste is asking you a question"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') {
          if (e.key === 'Enter') next()
          return
        }
        const n = Number(e.key)
        if (n >= 1 && n <= q.options.length) toggle(q.options[n - 1].label)
        if (e.key === 'Enter') next()
      }}
      className="animate-fade-up max-w-[760px] rounded-xl border border-accent-edge bg-accent-soft/50 p-4 outline-none"
    >
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <ShieldQuestion className="h-4 w-4 text-accent-text" />
        <span className="font-medium text-accent-text">Celeste is asking</span>
        {questions.length > 1 && (
          <span className="ml-auto">
            Question {step + 1} of {questions.length}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] text-ink-muted">{q.header}</span>
        <h3 className="text-[15px] font-medium text-ink">{q.question}</h3>
      </div>
      <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question} className="mt-3 space-y-1.5">
        {q.options.map((o, i) => {
          const on = current.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              onClick={() => toggle(o.label)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                on ? 'border-accent-edge bg-accent-soft' : 'border-edge bg-field hover:border-edge-strong'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center border text-[10px] font-semibold',
                  q.multiSelect ? 'rounded' : 'rounded-full',
                  on ? 'border-accent bg-accent text-white' : 'border-edge-strong text-ink-faint'
                )}
              >
                {on ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] text-ink">{o.label}</span>
                {o.description && <span className="block text-[12.5px] text-ink-muted">{o.description}</span>}
              </span>
            </button>
          )
        })}
        <div
          className={cn(
            'flex items-center gap-3 rounded-lg border px-3 py-1.5',
            otherText ? 'border-accent-edge bg-accent-soft' : 'border-edge bg-field'
          )}
        >
          <span className="w-[18px] shrink-0 text-center text-[11px] text-ink-faint">…</span>
          <input
            value={other[q.question] ?? ''}
            placeholder="Something else"
            aria-label="Other answer"
            onFocus={() => setTypingOther(true)}
            onChange={(e) => {
              setOther({ ...other, [q.question]: e.target.value })
              if (!q.multiSelect && e.target.value) setPicked((p) => ({ ...p, [q.question]: [] }))
            }}
            className="h-8 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={!hasAnswer} onClick={next}>
          {last ? 'Send answers' : 'Next'}
        </Button>
        {step > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <span className="ml-auto text-xs text-ink-faint">{typingOther ? 'Enter to continue' : 'Press 1–' + q.options.length + ' to choose, Enter to continue'}</span>
      </div>
    </div>
  )
}
