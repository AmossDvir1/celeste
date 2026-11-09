import { Modal } from '@/components/Dialog'
import { Button } from '@/components/ui'
import { usePhone } from '@/stores/phone'

/** A phone asks to connect: the person compares the three pictures with the phone's screen and answers. Shown wherever they are. */
export function PhonePairingDialog() {
  const pairing = usePhone((s) => s.pairing)
  const answer = usePhone((s) => s.answer)
  return (
    <Modal
      open={!!pairing}
      onOpenChange={(open) => !open && void answer(false)}
      title={pairing ? `${pairing.name} wants to connect` : 'A phone wants to connect'}
      description="Allow it only if your phone shows these same three pictures."
    >
      <div className="px-6 pt-5 pb-6">
        <div className="flex justify-center gap-3" aria-label={`The pictures: ${pairing?.emoji.join(' ') ?? ''}`}>
          {pairing?.emoji.map((e, i) => (
            <span key={i} className="grid h-[84px] w-[78px] place-items-center rounded-2xl border border-edge-strong bg-raised text-[40px]">
              {e}
            </span>
          ))}
        </div>
        <p className="mt-4 text-center text-[13px] text-ink-muted">
          It will be able to chat, follow your sessions and answer approvals. You can remove it any time in Settings, Phone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void answer(false)}>
            Don’t allow
          </Button>
          <Button variant="primary" onClick={() => void answer(true)}>
            Allow
          </Button>
        </div>
      </div>
    </Modal>
  )
}
