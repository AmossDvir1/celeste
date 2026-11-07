import { useEffect, useRef } from 'react'
import { Paperclip, Send, Square, TriangleAlert, X } from 'lucide-react'
import type { SessionMode, UserInput } from '@shared/agent'
import { cn } from '@/lib/cn'
import { IconButton } from '@/components/ui'
import { MODEL_BY_ID } from '@/mocks/models'
import { AttachmentStrip, type AttachmentsApi } from './attachments'
import { ApprovalPicker, EffortPopover, ModelPicker, type Prefs } from './controls'

export interface ComposerProps {
  variant: 'home' | 'dock'
  mode: SessionMode
  text: string
  onText: (text: string) => void
  prefs: Prefs
  onPrefs: (patch: Partial<Prefs>) => void
  attachments: AttachmentsApi
  busy?: boolean
  onSend: (input: UserInput) => void
  onStop?: () => void
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
  busy,
  onSend,
  onStop,
  autoFocus,
  placeholder = 'Message Celeste...'
}: ComposerProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const home = variant === 'home'
  const model = MODEL_BY_ID[prefs.model]
  const canSend = text.trim().length > 0 || attachments.items.length > 0
  const imageBlocked = model?.images === false && attachments.items.some((a) => a.mime.startsWith('image/'))

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

  const submit = () => {
    if (busy || !canSend) return
    onSend({ text: text.trim(), attachments: attachments.items })
    attachments.clear()
    onText('')
  }

  const sendButton = (
    <button
      type="button"
      aria-label={busy ? 'Stop' : 'Send message'}
      disabled={!busy && !canSend}
      onClick={busy ? onStop : submit}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full transition-colors',
        home ? 'absolute right-[22px] bottom-[18px] h-[50px] w-[50px]' : 'ml-auto h-10 w-10',
        busy || canSend ? 'bg-accent text-accent-ink hover:brightness-110' : 'bg-send text-send-ink',
        !busy && !canSend && 'cursor-default'
      )}
    >
      {busy ? <Square className="h-4 w-4 fill-current" /> : <Send className={home ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'} />}
    </button>
  )

  return (
    <div
      className={cn(
        'relative rounded-xl border border-composer-edge bg-composer transition-colors',
        home ? 'min-h-[134px] px-[22px] pt-[17px] pb-[14px]' : 'px-4 pt-3 pb-2.5'
      )}
    >
      {attachments.items.length > 0 && (
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} className="mb-3" />
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
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
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

      <div className={cn('flex items-center', home ? 'mt-2 h-9 -ml-[9px] gap-[11px]' : 'mt-1.5 -ml-1.5 gap-1')}>
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
        <IconButton label="Attach files" onClick={() => fileRef.current?.click()} className="w-11 text-ink-soft">
          <Paperclip className="h-[21px] w-[21px]" />
        </IconButton>
        <EffortPopover prefs={prefs} onPrefs={onPrefs} />
        <div className="flex items-center gap-2">
          <ModelPicker prefs={prefs} onPrefs={onPrefs} />
          <ApprovalPicker value={prefs.approval} onChange={(approval) => onPrefs({ approval })} mode={mode} />
        </div>
        {!home && sendButton}
      </div>
      {home && sendButton}
    </div>
  )
}
