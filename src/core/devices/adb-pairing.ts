import { randomBytes } from 'node:crypto'
import { parseMdns } from './adb-connector'
import { runProcess, textOf, type Exec } from './exec'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const token = (n: number) => [...randomBytes(n)].map((b) => ALPHABET[b % ALPHABET.length]).join('')

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface PairingOptions {
  exec?: Exec
  sleep?: (ms: number) => Promise<void>
  /** How long to look for the phone's connect port, and for a QR scan. */
  findPortMs?: number
  qrMs?: number
}

/**
 * Pairs an Android phone for wireless debugging, either with the six-digit code the phone shows or by showing a
 * QR code for the phone to scan. Pairing and connecting use two different ports, and the phone announces both on
 * the network, so Celeste listens for them through adb itself.
 */
export class AdbPairing {
  private readonly exec: Exec
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly adb: () => string | null,
    private readonly options: PairingOptions = {}
  ) {
    this.exec = options.exec ?? runProcess
    this.sleep = options.sleep ?? wait
  }

  private path(): string {
    const adb = this.adb()
    if (!adb) throw new Error('Android’s adb tool was not found. Install Android platform-tools, or set CELESTE_ADB to its path.')
    return adb
  }

  private async services() {
    const r = await this.exec(this.path(), ['mdns', 'services'], { timeoutMs: 10_000 })
    return parseMdns(textOf(r.stdout))
  }

  private async pair(address: string, code: string): Promise<void> {
    const r = await this.exec(this.path(), ['pair', address, code], { timeoutMs: 30_000 })
    const out = textOf(r.stdout) + textOf(r.stderr)
    if (!/successfully paired/i.test(out)) {
      throw new Error(/wrong|incorrect|failed/i.test(out) ? 'The phone refused. Check the six-digit code, which changes each time the pairing screen opens.' : out.trim() || 'Pairing did not work.')
    }
  }

  /** After pairing, the phone announces its connect port. */
  private async connectPort(host: string): Promise<number> {
    const deadline = Date.now() + (this.options.findPortMs ?? 15_000)
    do {
      const found = (await this.services()).find((s) => s.kind === 'connect' && s.host === host)
      if (found) return found.port
      await this.sleep(1000)
    } while (Date.now() < deadline)
    throw new Error('Paired, but the phone’s connection port was not found. On the phone, open Wireless debugging, read the IP address and port at the top, and add the phone by address.')
  }

  async pairByCode(address: string, code: string): Promise<{ host: string; port: number }> {
    const host = address.split(':')[0]
    await this.pair(address, code)
    return { host, port: await this.connectPort(host) }
  }

  /** What to show as a QR code, and a way to be told when the phone has scanned it. */
  startQr(
    _name: string,
    onPaired: (found: { host: string; port: number }) => void,
    onFailed: (error: Error) => void
  ): { payload: string; cancel(): void } {
    const instance = `studio-${token(10)}`
    const password = token(10)
    let cancelled = false
    void (async () => {
      const deadline = Date.now() + (this.options.qrMs ?? 120_000)
      try {
        while (!cancelled && Date.now() < deadline) {
          const found = (await this.services()).find((s) => s.kind === 'pairing' && s.instance === instance)
          if (found) {
            await this.pair(`${found.host}:${found.port}`, password)
            const port = await this.connectPort(found.host)
            if (!cancelled) onPaired({ host: found.host, port })
            return
          }
          await this.sleep(1000)
        }
        if (!cancelled) onFailed(new Error('The QR code was not scanned in time.'))
      } catch (err) {
        if (!cancelled) onFailed(err instanceof Error ? err : new Error(String(err)))
      }
    })()
    return { payload: `WIFI:T:ADB;S:${instance};P:${password};;`, cancel: () => void (cancelled = true) }
  }
}
