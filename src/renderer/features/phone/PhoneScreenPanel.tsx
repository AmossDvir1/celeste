import { useEffect, useRef } from 'react'
import { Smartphone, Square } from 'lucide-react'
import { Button } from '@/components/ui'
import { usePhoneView, type PhoneView } from '@/stores/phoneView'

/** A phone's screen, live, in a small panel in the corner while the person shares it from the phone. Watching only. */
export function PhoneScreenPanel() {
  const views = usePhoneView((s) => s.views)
  const stop = usePhoneView((s) => s.stop)
  const list = Object.values(views)
  if (!list.length) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col gap-3" aria-live="polite">
      {list.map((v) => (
        <View key={v.phoneId} view={v} onStop={() => stop(v.phoneId)} />
      ))}
    </div>
  )
}

function View({ view, onStop }: { view: PhoneView; onStop: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = video.current
    if (!el) return
    el.srcObject = view.stream
    if (view.stream) void el.play().catch(() => undefined)
  }, [view.stream])
  return (
    <div className="pointer-events-auto w-[260px] overflow-hidden rounded-2xl border border-edge bg-panel shadow-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Smartphone className="h-4 w-4 text-ink-soft" />
        <div className="min-w-0 flex-1 truncate text-[13px] text-ink">{view.name}</div>
        <Button variant="danger" size="sm" onClick={onStop} aria-label={`Stop showing ${view.name}`}>
          <Square className="h-3 w-3" /> Stop
        </Button>
      </div>
      <div className="relative aspect-[9/16] max-h-[420px] w-full bg-black">
        <video ref={video} muted playsInline autoPlay className="h-full w-full object-contain" />
        {view.state !== 'live' && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[13px] text-ink-muted">
            {view.state === 'failed' ? 'The picture was lost.' : 'Connecting…'}
          </div>
        )}
      </div>
      <div className="px-3 py-1.5 text-[11.5px] text-ink-faint">Watching only. Stop here, or on the phone.</div>
    </div>
  )
}
