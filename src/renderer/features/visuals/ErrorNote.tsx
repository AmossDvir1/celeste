import { useState } from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'
import { useSessions } from '@/stores/sessions'
import { chatNow } from './chat'
import { MAX_RETRIES, hashOf, noteRetry, retriesOf, retryMessage, type VisualKind } from './spec'

const NAME: Record<VisualKind, string> = { mermaid: 'diagram', chart: 'chart', steps: 'steps', excalidraw: 'drawing' }

/**
 * What a block shows when it cannot be drawn: a sentence, Try again (which sends the error back to the assistant as an ordinary message,
 * marked automatic, at most twice in a row), and the source folded away for the rare person who wants to copy it.
 */
export function ErrorNote({ kind, error, source }: { kind: VisualKind; error: string; source: string }) {
  const [, again] = useState(0)
  const chat = chatNow()
  const hash = hashOf(source)
  const left = MAX_RETRIES - (chat ? retriesOf(chat.id, hash) : MAX_RETRIES)
  return (
    <div role="group" aria-label={`The ${NAME[kind]} could not be drawn`} className="my-3 max-w-[760px] rounded-xl border border-edge bg-raised/50 p-3.5">
      <div className="flex items-start gap-2.5 text-[14px] text-ink">
        <CircleAlert className="mt-0.5 h-[18px] w-[18px] shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Couldn’t draw this {NAME[kind]}</div>
          <div className="mt-1 text-[13px] text-ink-muted">
            {chat && left > 0 ? 'The assistant can be asked to fix it.' : left <= 0 && chat ? 'It was sent back twice and still did not work.' : ''}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {chat && left > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  noteRetry(chat.id, hash)
                  void useSessions.getState().send(chat.mode, { text: retryMessage(kind, error), attachments: [] }, 'queue')
                  again((n) => n + 1)
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Try again
              </Button>
            )}
          </div>
          <details className="mt-2 text-[12.5px] text-ink-muted">
            <summary className="cursor-pointer select-none hover:text-ink">Show source</summary>
            <div className="selectable mt-1.5 text-ink-faint">{error}</div>
            <pre className="selectable mt-1.5 max-h-[240px] overflow-auto rounded-lg bg-field p-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-ink">{source}</pre>
          </details>
        </div>
      </div>
    </div>
  )
}
