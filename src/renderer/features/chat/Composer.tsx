import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ListPlus, Paperclip, Send, Square, TriangleAlert, X, Zap } from 'lucide-react'
import type { ContextRef, SessionMode, UserInput } from '@shared/agent'
import type { SendMode } from '@shared/queue'
import { cn } from '@/lib/cn'
import { IconButton } from '@/components/ui'
import { slugify } from '@shared/workflow'
import { lookupModel, useModels } from '@/stores/models'
import { useWorkflows } from '@/stores/workflows'
import { useUi } from '@/stores/ui'
import { connectedVendors, useVendors } from '@/stores/vendors'
import { AttachmentStrip, type AttachmentsApi } from './attachments'
import { ContextStrip } from './context'
import { ApprovalPicker, ModelControls, type Prefs } from './controls'
import { SlashList, WorkflowChip, parseSlash, useSlash } from './slash'

const NO_CONTEXT: ContextRef[] = []
const NO_HISTORY: string[] = []

/** The visual line (counting from 0, wrapped lines included) that the caret at `pos` is on, measured with a hidden copy of the box. */
function caretLine(el: HTMLTextAreaElement, pos: number): number {
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const name of Array.from(style)) mirror.style.setProperty(name, style.getPropertyValue(name))
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    height: 'auto',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word'
  })
  // The marker is the character right after the caret: a zero-width one at a wrap point would stay on the line above.
  const marker = document.createElement('span')
  marker.textContent = el.value.charAt(pos) || '\u200b'
  mirror.append(el.value.slice(0, pos), marker)
  document.body.appendChild(mirror)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
  const line = Math.round(marker.offsetTop / lineHeight)
  mirror.remove()
  return line
}

export interface ComposerProps {
  variant: 'home' | 'dock'
  mode: SessionMode
  text: string
  onText: (text: string) => void
  prefs: Prefs
  onPrefs: (patch: Partial<Prefs>) => void
  attachments: AttachmentsApi
  /** The conversation this box belongs to. A workflow chosen with "/" runs in it; without one it is opened in the Workflows tab. */
  sessionId?: string
  /** Files and folders of the project added to this message (Develop). */
  context?: ContextRef[]
  onRemoveContext?: (path: string) => void
  busy?: boolean
  /** `mode` says what to do when the assistant is working: wait for its turn, or stop it and send now. */
  onSend: (input: UserInput, mode: SendMode) => void | Promise<boolean>
  onStop?: () => void
  /** Up arrow in an empty box: change the newest waiting message. Returns false when there is none. */
  onEditLast?: () => boolean
  /** The messages sent in this conversation, oldest first. Up and Down step through them, like a shell. */
  history?: string[]
  autoFocus?: boolean
  placeholder?: string
}

export function Composer({
  variant,
  mode,
  text,
  onText,
  prefs,
  onPrefs,
  attachments,
  sessionId,
  context = NO_CONTEXT,
  onRemoveContext,
  busy,
  onSend,
  onStop,
  onEditLast,
  history = NO_HISTORY,
  autoFocus,
  placeholder =  'Message Celeste...'
}: ComposerProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const home = variant === 'home'
  const byId = useModels((s) => s.byId)
  const model = lookupModel(byId, prefs.model)
  const noVendor = useVendors((s) => connectedVendors(s.vendors).length === 0)
  const openSettings = useUi((s) => s.openSettings)
  const slash = useSlash(text, sessionId)
  const listId = useId()
  // A workflow chosen with "/" is run by sending; it needs no AI vendor of its own, but its steps may.
  const canSend = slash.chip !== null || (!noVendor && (text.trim().length > 0 || attachments.items.length > 0 || context.length > 0))
  const imageBlocked = model?.images === false && attachments.items.some((a) => a.mime.startsWith('image/'))
  // While a message is being sent the prompt stays in the box, and it is not sent twice.
  const [sending, setSending] = useState(false)
  // Which earlier prompt Up/Down is showing (an index into `history`), or null when the box holds the person's own text.
  const [recall, setRecall] = useState<number | null>(null)
  // Set when Up/Down moves to another prompt: the caret goes to its first line, and the arrow keys move line by line from there.
  const caretToStart = useRef(false)

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus()
  }, [autoFocus])

  useLayoutEffect(() => {
    if (!caretToStart.current) return
    caretToStart.current = false
    areaRef.current?.setSelectionRange(0, 0)
  }, [recall, text])

  /** Shows the prompt at `index` of the history in the box. */
  function recallAt(index: number | null) {
    caretToStart.current = index !== null
    setRecall(index)
    onText(index === null ? '' : history[index])
  }

  const submit = async (sendMode: SendMode = 'queue') => {
    if (slash.chip) {
      void slash.run()
      return
    }
    if (sending || !canSend) return
    // "/name answer=value" typed out in full is a workflow as well.
    const typed = parseSlash(text)
    const named = typed && useWorkflows.getState().list.find((w) => slugify(w.name) === typed.name)
    if (typed && named) {
      onText('')
      void slash.choose(named.id, typed.args)
      return
    }
    setSending(true)
    // The prompt is only cleared once it has gone. If sending fails, what was written is still there to fix and send again.
    // While the assistant works, the message waits its turn ('queue') or stops the turn and goes now ('stop').
    const sent = await onSend({ text: text.trim(), attachments: attachments.items, ...(context.length ? { context } : {}) }, sendMode)
    setSending(false)
    if (sent === false) return
    attachments.clear()
    setRecall(null)
    onText('')
  }


  /** Chooses an item of the "/" menu: a command happens at once, a workflow becomes a chip. The text typed so far goes. */
  function pickItem(i: number) {
    const item = slash.items[i]
    if (!item) return
    // A command may leave the start of a sentence to finish ("Use my computer to ").
    onText('insert' in item && typeof item.insert === 'string' ? item.insert : '')
    slash.pick(item)
  }

  const round = cn('flex shrink-0 items-center justify-center rounded-full transition-colors', home ? 'h-[50px] w-[50px]' : 'h-10 w-10')
  const sendButton = busy ? (
    <div className="ml-auto flex items-center gap-1.5">
      {canSend && (
        <>
          <button
            type="button"
            title="Stop what it is doing and send this now (Ctrl+Enter)"
            disabled={sending}
            onClick={() => void submit('stop')}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-edge-strong px-3 text-[13px] font-medium text-ink-soft transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            <Zap className="h-3.5 w-3.5" /> Send now
          </button>
          <button
            type="button"
            aria-label="Add to queue"
            title="Add to the queue: it is sent when this answer ends (Enter)"
            disabled={sending}
            onClick={() => void submit('queue')}
            className={cn(round, 'bg-accent-soft text-accent-text hover:bg-accent/20 disabled:opacity-50')}
          >
            <ListPlus className="h-[18px] w-[18px]" />
          </button>
        </>
      )}
      <button type="button" aria-label="Stop" onClick={onStop} className={cn(round, 'bg-accent-fill text-accent-ink hover:brightness-110')}>
        <Square className="h-4 w-4 fill-current" />
      </button>
    </div>
  ) : (
    <button
      type="button"
      aria-label="Send message"
      disabled={!canSend || sending}
      onClick={() => void submit()}
      className={cn(
        round,
        home && 'absolute right-[22px] bottom-[18px]',
        !home && 'ml-auto',
        canSend ? 'bg-accent-fill text-accent-ink hover:brightness-110' : 'bg-send text-send-ink',
        !canSend && 'cursor-default'
      )}
    >
      <Send className={home ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'} />
    </button>
  )

  return (
    <div
      className={cn(
        'relative rounded-xl border border-composer-edge bg-composer transition-colors',
        home ? 'min-h-[134px] px-[22px] pt-[17px] pb-[14px]' : 'px-4 pt-3 pb-2.5'
      )}
    >
      {slash.open && <SlashList id={listId} items={slash.items} index={slash.index} onPick={(i) => pickItem(i)} onHover={slash.setIndex} />}
      {slash.chip && <WorkflowChip chip={slash.chip} problem={slash.problem} onChange={(values) => slash.setChip({ ...(slash.chip as NonNullable<typeof slash.chip>), values })} onRemove={() => slash.setChip(null)} />}
      {context.length > 0 && <ContextStrip items={context} onRemove={onRemoveContext} className="mb-2.5" />}
      {attachments.items.length > 0 && (
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} className="mb-3" />
      )}

      {noVendor && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-text">
          Connect an AI vendor to start chatting.
          <button type="button" onClick={() => openSettings('vendors')} className="ml-auto font-medium underline underline-offset-2 hover:brightness-110">
            Connect…
          </button>
        </div>
      )}

      {imageBlocked && (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          {model?.label} can’t read images. The file is attached, but the model won’t see it.
        </div>
      )}
      {attachments.notice && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {attachments.notice}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={attachments.dismissNotice}
            className="ml-auto text-warning/80 hover:text-warning"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <textarea
        ref={areaRef}
        value={text}
        rows={1}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => {
          setRecall(null)
          onText(e.target.value)
        }}
        aria-controls={slash.open ? listId : undefined}
        aria-activedescendant={slash.open ? `${listId}-${slash.index}` : undefined}
        onKeyDown={(e) => {
          if (slash.open && !e.nativeEvent.isComposing) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              slash.setIndex((slash.index + (e.key === 'ArrowDown' ? 1 : slash.items.length - 1)) % slash.items.length)
              return
            }
            if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
              e.preventDefault()
              pickItem(slash.index)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              slash.dismiss()
              return
            }
          }
          const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown'
          const plainKey = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing
          if (arrow && plainKey && recall === null && !text) {
            if (e.key === 'ArrowUp' && onEditLast?.()) {
              e.preventDefault()
              return
            }
            if (e.key === 'ArrowUp' && history.length > 0) {
              e.preventDefault()
              recallAt(history.length - 1)
              return
            }
          }
          if (arrow && plainKey && recall !== null) {
            const el = e.currentTarget
            // Inside a prompt the arrows move the caret line by line; they change prompt only from the top or bottom line.
            if (e.key === 'ArrowUp' && caretLine(el, el.selectionStart) === 0 && recall > 0) {
              e.preventDefault()
              recallAt(recall - 1)
              return
            }
            if (e.key === 'ArrowDown' && caretLine(el, el.selectionEnd) === caretLine(el, el.value.length)) {
              e.preventDefault()
              recallAt(recall < history.length - 1 ? recall + 1 : null)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit(e.ctrlKey || e.metaKey ? 'stop' : 'queue')
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files)
          if (files.length) {
            e.preventDefault()
            void attachments.add(files)
          }
        }}
        className={cn(
          'selectable block w-full resize-none bg-transparent text-ink outline-none placeholder:text-ink-muted/65',
          home ? 'min-h-[58px] pr-16 text-[17px] leading-7' : 'min-h-[28px] text-[15px] leading-6'
        )}
      />

      <div className={cn('flex items-center gap-2', home ? 'mt-2.5 h-[34px]' : 'mt-1.5')}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void attachments.add(e.target.files)
            e.target.value = ''
          }}
        />
        <IconButton label="Attach files" onClick={() => fileRef.current?.click()} className="-ml-1.5 text-ink-soft">
          <Paperclip className="h-[18px] w-[18px]" />
        </IconButton>
        <ModelControls prefs={prefs} onPrefs={onPrefs} />
        <ApprovalPicker value={prefs.approval} onChange={(approval) => onPrefs({ approval })} mode={mode} />
        {!home && sendButton}
      </div>
      {home && sendButton}
    </div>
  )
}
