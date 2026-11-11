// The phone bridge: lets the Celeste app on a phone on the same Wi-Fi use this Celeste (docs/PHONE_PLAN.md).
// A small HTTP server, on only while Settings → Phone is on:
//   GET  /              the page the QR code opens: it hands out the app (APK) that matches this version
//   GET  /celeste.apk   the app itself
//   GET  /hello         who this computer is (name, version, public key)
//   POST /pair/start    pairing, step 1 (see src/shared/phone.ts)
//   POST /pair/reveal   pairing, step 3; the person then sees three pictures and presses Allow here
//   GET  /pair/wait     the phone waits for that answer
//   POST /rpc           one sealed request from a paired phone, answered sealed
//   GET  /events        Server-Sent Events: sealed pushes for a paired phone
// Nothing is answered for an address outside the local network, and nothing but /, /hello and pairing before the phone
// proves it holds a paired key.

import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { CorePush } from '@shared/api'
import {
  LABEL,
  PHONE_MAX_SKEW_MS,
  PHONE_ATTACH_MAX_BYTES,
  PHONE_ATTACH_MAX_FILES,
  PHONE_ATTACH_PART,
  PHONE_PROTOCOL,
  PHONE_PUSHES,
  DEFAULT_RELAY_URL,
  commitment,
  isPhoneMethod,
  makeKeyPair,
  open,
  pairingEmoji,
  randomB64,
  relayRoom,
  seal,
  sessionKey,
  type PhoneAbility,
  type PhoneAttachPart,
  type PhoneControlReport,
  type PhoneHello,
  type PhoneMethod,
  type PhonePairRequest,
  type PhoneRecord,
  type PhoneRelayInfo,
  type PhoneReply,
  type PhoneCancelPush,
  type PhoneRequestPush,
  type PhoneStatus,
  type RelayHostFrame,
  type RelayPhoneFrame,
  type SealedCall,
  type SealedReply,
  type StoredKeyPair
} from '@shared/phone'
import { RelayLine } from './relay'

export interface PhoneSettingsStore {
  settings(): Record<string, unknown>
  setSetting(key: string, value: unknown): void
}

export interface PhoneBridgeDeps {
  store: PhoneSettingsStore
  /** Runs one of the phone's methods. Only methods in PHONE_METHODS ever get here. */
  call: (method: PhoneMethod, params: unknown[], phone: PhoneRecord) => Promise<unknown>
  computerName: () => string
  version: string
  /** The app to hand out, or null when there is none on this computer. */
  apkFile: () => string | null
  /** Settings → Phone changed (a phone added, removed, seen; the server started or stopped). */
  onStatus: () => void
  /** A pairing is waiting for the person at the computer, or no longer is (null). */
  onPairing: (request: PhonePairRequest | null) => void
  /** Something wrong with the network phones reach this computer on (Windows: a Public network), or null. */
  networkWarning?: (address: string | undefined) => Promise<string | null>
  /** The system's secret store, for this computer's key pair (Electron safeStorage, through the main process). */
  keyStore?: { get(): Promise<string | null>; set(value: string): Promise<boolean> }
  /** The phone says what happened to phone control there (the person paused it, pressed Continue, or ended it). */
  onControl?: (phoneId: string, report: PhoneControlReport) => void
  /** Announces the service on the local network. Returns how to stop announcing. */
  announce?: (port: number, name: string, id: string) => Promise<() => Promise<void>>
  addresses?: () => string[]
  now?: () => number
  /**
   * The relay phones reach this computer through away from home (docs/PHONE_PLAN.md 7.1), like wss://relay.example. Empty: none.
   * Left out, it is CELESTE_RELAY_URL, then the `phoneRelayUrl` setting, then the project's own.
   */
  relayUrl?: () => string
  /** Where to listen. Tests use 127.0.0.1. */
  host?: string
  /** A fixed port, for tests. Otherwise one is picked once and kept. */
  port?: number
}

const PAIR_TTL_MS = 120_000
const WAIT_MS = 25_000
const HEARTBEAT_MS = 20_000
const MAX_BODY = 4_000_000

/** A file the person picked on the phone, as it arrived. */
export interface PhoneFile {
  name: string
  mime: string
  data: Buffer
}

/** A phone's answer to a request: what happened, and a screenshot when phone control was asked for one. */
export interface PhoneAnswer {
  ok: boolean
  text: string
  image?: { mime: string; data: string }
  /** The files the person picked (phone_photos, phone_files), whole. */
  files?: PhoneFile[]
}

/** A file arriving in parts, with `phone.attach`. */
interface Incoming {
  name: string
  mime: string
  parts: Buffer[]
  done: boolean
}

/** The computer's addresses on the local network, home networks first. */
export function lanAddresses(): string[] {
  const rank = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2)
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal && isPrivate(a.address))
    .map((a) => a.address)
    .sort((a, b) => rank(a) - rank(b))
}

/** Loopback, private IPv4 ranges, IPv6 link-local and unique-local. */
export function isPrivate(address: string | undefined): boolean {
  if (!address) return false
  const a = address.replace(/^::ffff:/i, '')
  if (/^(127\.|10\.|192\.168\.)/.test(a)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true
  if (a === '::1') return true
  return /^(fe80:|fc|fd)/i.test(a)
}

interface Pending {
  pairId: string
  name: string
  commit: string
  nonce: string
  phoneKey?: string
  phoneNonce?: string
  emoji?: string[]
  state: 'started' | 'revealed' | 'allowed' | 'denied'
  phoneId?: string
  at: number
  waiters: Set<() => void>
}

/** A phone that is listening for pushes: on the Wi-Fi (an open HTTP stream) or through the relay (one of its connections). */
interface Listener {
  phoneId: string
  key: CryptoKey
  /** Sends one sealed push. */
  write: (box: string) => void
  /** Closes the phone's stream. */
  end: () => void
  /** Keeps a Wi-Fi stream from going quiet. The relay answers the phone's own pings. */
  ping?: () => void
  /** The relay connection it came through. */
  conn?: string
  queue: Promise<void>
}

export class PhoneBridge {
  private server: Server | null = null
  private stopAnnounce: (() => Promise<void>) | null = null
  private pending: Pending | null = null
  private readonly keys = new Map<string, Promise<CryptoKey>>()
  private readonly seen = new Map<string, Map<string, number>>()
  private readonly listeners = new Set<Listener>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastError: string | undefined
  private seenSaved = 0
  /** Requests sent to a phone, waiting for its reply. */
  private readonly asked = new Map<string, { phoneId: string; sessionId: string; done: (r: PhoneAnswer) => void; acked: () => void; files: Incoming[]; bytes: number }>()

  private readonly relay: RelayLine

  constructor(private readonly deps: PhoneBridgeDeps) {
    this.relay = new RelayLine({
      onFrame: (conn, text) => void this.relayFrame(conn, text).catch(() => undefined),
      onGone: (conn) => {
        for (const l of [...this.listeners]) if (l.conn !== undefined && (conn === null || l.conn === conn)) this.listeners.delete(l)
      },
      onState: () => this.deps.onStatus()
    })
  }

  private relayUrl(): string {
    const url = this.deps.relayUrl ? this.deps.relayUrl() : (process.env['CELESTE_RELAY_URL'] ?? (this.settings['phoneRelayUrl'] as string | undefined) ?? DEFAULT_RELAY_URL)
    return /^(wss?|https?):\/\/[^\s/]+/.test(url) ? url.replace(/\/+$/, '') : ''
  }

  /** Where a paired phone finds this computer away from home, or null when there is no relay. */
  private async relayInfo(): Promise<PhoneRelayInfo | null> {
    const url = this.relayUrl()
    if (!url) return null
    const { keys } = await this.identity()
    return { url, room: (await relayRoom(keys.priv)).room }
  }

  /** Opens the line to the relay while phones are on and one is paired, and closes it otherwise. */
  private async syncRelay(): Promise<void> {
    const url = this.relayUrl()
    if (!url || !this.server || !this.phones().length) return this.relay.use(null)
    const { keys } = await this.identity()
    const target = { url, ...(await relayRoom(keys.priv)) }
    // Switched off, or the last phone removed, while the key was read.
    if (!this.server || !this.phones().length) return this.relay.use(null)
    this.relay.use(target)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get settings(): Record<string, unknown> {
    return this.deps.store.settings()
  }

  phones(): PhoneRecord[] {
    return (this.settings['phones'] as PhoneRecord[] | undefined) ?? []
  }

  private savePhones(list: PhoneRecord[]): void {
    this.deps.store.setSetting('phones', list)
  }

  private ownKeys: Promise<StoredKeyPair> | null = null

  /**
   * This computer's key pair, made the first time it is needed (once, even when two phones ask at the same moment). It is
   * kept in the system's secret store; a key from an older Celeste, kept in its settings, moves there and leaves the
   * settings. Only a computer with no secret store keeps it in the settings.
   */
  private keyPair(): Promise<StoredKeyPair> {
    this.ownKeys ??= (async () => {
      const store = this.deps.keyStore
      const saved = store ? await store.get().catch(() => null) : null
      if (saved) {
        try {
          const k = JSON.parse(saved) as StoredKeyPair
          if (typeof k?.pub === 'string' && k.priv && typeof k.priv === 'object') return k
        } catch {
          // Not a key: make or move one below.
        }
      }
      const old = this.settings['phoneKey'] as StoredKeyPair | null | undefined
      const keys = old ?? (await makeKeyPair())
      const kept = store ? await store.set(JSON.stringify(keys)).catch(() => false) : false
      if (kept && old) this.deps.store.setSetting('phoneKey', null)
      else if (!kept && !old) this.deps.store.setSetting('phoneKey', keys)
      return keys
    })()
    return this.ownKeys
  }

  /** This computer's key pair and id, made the first time they are needed. */
  private async identity(): Promise<{ keys: StoredKeyPair; id: string }> {
    const keys = await this.keyPair()
    let id = this.settings['phoneId'] as string | undefined
    if (!id) {
      id = randomB64(6).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'celeste'
      this.deps.store.setSetting('phoneId', id)
    }
    return { keys, id }
  }

  get enabled(): boolean {
    return this.settings['phoneEnabled'] === true
  }

  get port(): number | null {
    const a = this.server?.address()
    return a && typeof a === 'object' ? a.port : null
  }

  status(): PhoneStatus {
    const addresses = (this.deps.addresses ?? lanAddresses)()
    const port = this.port
    const p = this.pending
    return {
      enabled: this.enabled,
      running: !!this.server,
      port,
      addresses,
      phones: this.phones(),
      installUrl: port && addresses[0] ? `http://${addresses[0]}:${port}/` : null,
      apk: !!this.deps.apkFile(),
      pending: p && p.state === 'revealed' && p.emoji ? { pairId: p.pairId, name: p.name, emoji: p.emoji, at: p.at } : null,
      relay: this.relay.state,
      ...(this.lastError ? { error: this.lastError } : {}),
      // Only while no phone is connected: one that is connected shows the network lets it in.
      ...(this.server && this.network.warning && !this.listening().length ? { network: this.network.warning } : {})
    }
  }

  /** The network check's last answer, and when it was asked; asked again at most once a minute, while phones may connect. */
  private network: { warning: string | null; at: number; running: boolean } = { warning: null, at: 0, running: false }

  /** Looks at the network again (Settings, Phone opened, or the server started), and says so when the answer changed. */
  checkNetwork(): void {
    const check = this.deps.networkWarning
    const n = this.network
    if (!check || !this.server || n.running || this.now() - n.at < 60_000) return
    n.running = true
    void check((this.deps.addresses ?? lanAddresses)()[0])
      .catch(() => null)
      .then((warning) => {
        n.running = false
        n.at = this.now()
        if (warning === n.warning) return
        n.warning = warning
        this.deps.onStatus()
      })
  }

  async setEnabled(on: boolean): Promise<PhoneStatus> {
    this.deps.store.setSetting('phoneEnabled', on)
    if (on) await this.start()
    else await this.stop()
    this.deps.onStatus()
    return this.status()
  }

  /** Starts listening if Settings → Phone is on. Called when Celeste starts. */
  async start(): Promise<void> {
    if (this.server || !this.enabled) return
    const { id } = await this.identity()
    const wanted = this.deps.port ?? (this.settings['phonePort'] as number | undefined) ?? 40000 + Math.floor(Math.random() * 9000)
    let server: Server
    try {
      server = await this.listen(wanted)
    } catch {
      // The port was taken (another program, or a second Celeste): pick another and keep that one.
      try {
        server = await this.listen(this.deps.port ? 0 : 40000 + Math.floor(Math.random() * 9000))
      } catch (err) {
        this.lastError = `Could not listen on the network: ${err instanceof Error ? err.message : String(err)}`
        return
      }
    }
    this.lastError = undefined
    this.server = server
    const port = this.port as number
    if (!this.deps.port) this.deps.store.setSetting('phonePort', port)
    this.heartbeat = setInterval(() => this.listeners.forEach((l) => l.ping?.()), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    if (this.deps.announce) {
      this.stopAnnounce = await this.deps.announce(port, this.deps.computerName(), id).catch(() => null)
    }
    this.network.at = 0
    this.checkNetwork()
    void this.syncRelay()
  }

  private listen(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(port, this.deps.host ?? '0.0.0.0', () => {
        server.off('error', reject)
        resolve(server)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.relay.use(null)
    this.listeners.forEach((l) => l.end())
    this.listeners.clear()
    if (this.pending) this.endPairing('denied')
    await this.stopAnnounce?.().catch(() => undefined)
    this.stopAnnounce = null
    const server = this.server
    this.server = null
    if (server) {
      // Switching phones off cuts every connection at once. (Waiting for them to end by themselves can hang for as long as a phone keeps its
      // stream open, or is reopening it just then.)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }

  /** Forgets a phone: its key no longer works, and its open stream is closed at once. */
  remove(phoneId: string): PhoneStatus {
    this.savePhones(this.phones().filter((p) => p.id !== phoneId))
    this.keys.delete(phoneId)
    this.seen.delete(phoneId)
    for (const l of [...this.listeners]) {
      if (l.phoneId !== phoneId) continue
      l.end()
      this.listeners.delete(l)
    }
    void this.syncRelay()
    this.deps.onStatus()
    return this.status()
  }

  /** The person at the computer answered the three pictures. */
  answer(pairId: string, allow: boolean): PhoneStatus {
    const p = this.pending
    if (!p || p.pairId !== pairId || p.state !== 'revealed' || !p.phoneKey) return this.status()
    if (allow) {
      const phone: PhoneRecord = { id: randomB64(9).replace(/[^a-z0-9]/gi, '').slice(0, 12), name: p.name, key: p.phoneKey, pairedAt: this.now(), lastSeen: this.now() }
      this.savePhones([...this.phones().filter((x) => x.key !== phone.key), phone])
      p.phoneId = phone.id
      this.endPairing('allowed')
      void this.syncRelay()
    } else {
      this.endPairing('denied')
    }
    this.deps.onStatus()
    return this.status()
  }

  private endPairing(state: 'allowed' | 'denied'): void {
    const p = this.pending
    if (!p) return
    p.state = state
    p.waiters.forEach((w) => w())
    p.waiters.clear()
    this.deps.onPairing(null)
    // Kept a little longer so a phone that is waiting still hears the answer.
    setTimeout(() => {
      if (this.pending === p) this.pending = null
    }, 30_000).unref?.()
  }

  /** Sends a push to every phone that is listening, sealed for each, in order. */
  broadcast(push: CorePush): void {
    if (!PHONE_PUSHES.includes(push.type)) return
    for (const l of this.listeners) {
      l.queue = l.queue
        .then(async () => {
          l.write(await seal(l.key, push, LABEL.push))
        })
        .catch(() => undefined)
    }
  }

  /** The paired phones that are listening now, the most recently seen first. */
  listening(): PhoneRecord[] {
    const ids = new Set([...this.listeners].map((l) => l.phoneId))
    return this.phones()
      .filter((p) => ids.has(p.id))
      .sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /**
   * Asks a phone to do something (a phone ability). The phone shows the person a card and answers with `phone.reply`.
   * Resolves with its answer, or with a refusal when it does not answer in time or the line goes.
   */
  ask(phoneId: string, ability: PhoneAbility, args: Record<string, unknown>, chat: string, timeoutMs = 180_000, sessionId = '', ackMs = 12_000): Promise<PhoneAnswer> {
    const targets = [...this.listeners].filter((l) => l.phoneId === phoneId)
    if (!targets.length) return Promise.resolve({ ok: false, text: 'The phone is not connected.' })
    const id = randomB64(12).replace(/[^a-z0-9]/gi, '')
    const push: PhoneRequestPush = { type: 'phoneRequest', request: { id, ability, args, chat } }
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ ok: false, text: 'Nobody answered on the phone in time.' }), timeoutMs)
      timer.unref?.()
      // The phone says "got it" within seconds. A phone whose app sleeps in the background (no Stay connected) never
      // does, and waiting minutes for it would leave the chat hanging.
      const noAck = setTimeout(
        () =>
          finish({
            ok: false,
            text: 'The phone did not respond. Celeste may be closed or asleep on it: ask the user to open Celeste on the phone, or to switch on “Stay connected” in its This phone tab.'
          }),
        ackMs
      )
      noAck.unref?.()
      const finish = (r: PhoneAnswer) => {
        clearTimeout(timer)
        clearTimeout(noAck)
        if (!this.asked.delete(id)) return
        resolve(r)
      }
      this.asked.set(id, { phoneId, sessionId, done: finish, acked: () => clearTimeout(noAck), files: [], bytes: 0 })
      this.sendTo(phoneId, push)
    })
  }

  /**
   * Stop was pressed in a chat, or a workflow step that used the phone ended: its requests waiting on the phone end now, their
   * cards go, and phone control ends.
   */
  cancel(sessionId: string, why?: string): void {
    const byPhone = new Map<string, string[]>()
    for (const [id, a] of [...this.asked]) {
      if (a.sessionId !== sessionId) continue
      byPhone.set(a.phoneId, [...(byPhone.get(a.phoneId) ?? []), id])
      a.done({ ok: false, text: why ?? 'The user stopped it.' })
    }
    for (const phone of this.listening()) {
      const push: PhoneCancelPush = { type: 'phoneCancel', ids: byPhone.get(phone.id) ?? [], endControl: true, ...(why ? { why } : {}) }
      this.sendTo(phone.id, push)
    }
  }

  /**
   * Part of a file for a request waiting on this phone. Files come one after another and each in order, within the limits;
   * anything else is refused, and the reply then carries only the files that arrived whole.
   */
  private attach(phoneId: string, p: Partial<PhoneAttachPart> | undefined): string | null {
    const waiting = typeof p?.id === 'string' ? this.asked.get(p.id) : undefined
    if (!p || !waiting || waiting.phoneId !== phoneId) return 'Nothing is waiting for that file.'
    if (typeof p.data !== 'string' || p.data.length > Math.ceil(PHONE_ATTACH_PART / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) return 'That part is not right.'
    const data = Buffer.from(p.data, 'base64')
    const files = waiting.files
    let file = files[files.length - 1]
    if (p.file === files.length && (!file || file.done) && p.part === 0) {
      if (files.length >= PHONE_ATTACH_MAX_FILES) return `At most ${PHONE_ATTACH_MAX_FILES} files at a time.`
      const name = typeof p.name === 'string' ? p.name.slice(0, 200) : ''
      const mime = typeof p.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(p.mime) ? p.mime.slice(0, 100) : 'application/octet-stream'
      file = { name, mime, parts: [], done: false }
      files.push(file)
    } else if (!file || file.done || p.file !== files.length - 1 || p.part !== file.parts.length) return 'That part came out of order.'
    if (waiting.bytes + data.length > PHONE_ATTACH_MAX_BYTES) {
      files.pop()
      return `The files are too large together (at most ${PHONE_ATTACH_MAX_BYTES / 1_048_576} MB).`
    }
    waiting.bytes += data.length
    file.parts.push(data)
    file.done = p.last === true
    return null
  }

  private sendTo(phoneId: string, value: PhoneRequestPush | PhoneCancelPush): void {
    for (const l of this.listeners) {
      if (l.phoneId !== phoneId) continue
      l.queue = l.queue.then(async () => l.write(await seal(l.key, value, LABEL.push))).catch(() => undefined)
    }
  }

  private keyFor(phone: PhoneRecord): Promise<CryptoKey> {
    let k = this.keys.get(phone.id)
    if (!k) {
      k = this.identity().then(({ keys }) => sessionKey(keys.priv, phone.key, keys.pub, phone.key))
      this.keys.set(phone.id, k)
    }
    return k
  }

  /** True the first time a nonce is seen from this phone within the allowed clock skew. */
  private fresh(phoneId: string, ts: number, n: string): boolean {
    const now = this.now()
    if (typeof ts !== 'number' || Math.abs(now - ts) > PHONE_MAX_SKEW_MS || typeof n !== 'string') return false
    let seen = this.seen.get(phoneId)
    if (!seen) {
      seen = new Map()
      this.seen.set(phoneId, seen)
    }
    for (const [k, at] of seen) if (now - at > PHONE_MAX_SKEW_MS * 2) seen.delete(k)
    if (seen.has(n)) return false
    seen.set(n, now)
    return true
  }

  private touch(phone: PhoneRecord): void {
    const now = this.now()
    if (now - this.seenSaved < 60_000) return
    this.seenSaved = now
    this.savePhones(this.phones().map((p) => (p.id === phone.id ? { ...p, lastSeen: now } : p)))
    this.deps.onStatus()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (!isPrivate(req.socket.remoteAddress)) return end(res, 403, { error: 'Only devices on the local network may connect.' })
    if (req.method === 'OPTIONS') return end(res, 204)
    const url = new URL(req.url ?? '/', 'http://phone')
    try {
      if (req.method === 'GET' && url.pathname === '/') return this.installPage(res)
      if (req.method === 'GET' && url.pathname === '/celeste.apk') return this.sendApk(res)
      if (req.method === 'GET' && url.pathname === '/hello') return end(res, 200, await this.hello())
      if (req.method === 'POST' && url.pathname === '/pair/start') return end(res, ...(await this.pairStart(await body(req))))
      if (req.method === 'POST' && url.pathname === '/pair/reveal') return end(res, ...(await this.pairReveal(await body(req))))
      if (req.method === 'GET' && url.pathname === '/pair/wait') return this.pairWait(url.searchParams.get('pairId') ?? '', res)
      if (req.method === 'POST' && url.pathname === '/rpc') return end(res, ...(await this.rpc(await body(req))))
      if (req.method === 'GET' && url.pathname === '/events') return this.events(url, res)
      return end(res, 404, { error: 'Not found' })
    } catch (err) {
      return end(res, 400, { error: err instanceof Error ? err.message : 'Bad request' })
    }
  }

  private async hello(): Promise<PhoneHello> {
    const { keys, id } = await this.identity()
    return { protocol: PHONE_PROTOCOL, name: this.deps.computerName(), id, version: this.deps.version, key: keys.pub }
  }

  private async pairStart(b: Record<string, unknown>): Promise<[number, unknown]> {
    const commit = str(b['commit'], 64)
    const name = str(b['name'], 60).trim() || 'Android phone'
    const p = this.pending
    if (p && this.now() - p.at < PAIR_TTL_MS && (p.state === 'revealed' || p.state === 'started')) {
      if (p.state === 'revealed') return [409, { error: 'Another phone is connecting. Try again in a moment.' }]
    }
    const { keys } = await this.identity()
    const pairId = randomB64(12).replace(/[^a-z0-9]/gi, '')
    this.pending = { pairId, name, commit, nonce: randomB64(16), state: 'started', at: this.now(), waiters: new Set() }
    return [200, { pairId, key: keys.pub, nonce: this.pending.nonce }]
  }

  private async pairReveal(b: Record<string, unknown>): Promise<[number, unknown]> {
    const p = this.pending
    const pairId = str(b['pairId'], 40)
    if (!p || p.pairId !== pairId || p.state !== 'started' || this.now() - p.at > PAIR_TTL_MS) return [410, { error: 'That pairing has ended. Start again.' }]
    const phoneKey = str(b['key'], 64)
    const phoneNonce = str(b['nonce'], 64)
    if ((await commitment(phoneKey, phoneNonce)) !== p.commit) {
      this.pending = null
      return [400, { error: 'The phone’s answer did not match what it promised.' }]
    }
    const { keys } = await this.identity()
    p.phoneKey = phoneKey
    p.phoneNonce = phoneNonce
    p.emoji = await pairingEmoji(keys.pub, phoneKey, phoneNonce, p.nonce)
    p.state = 'revealed'
    p.at = this.now()
    this.deps.onPairing({ pairId: p.pairId, name: p.name, emoji: p.emoji, at: p.at })
    this.deps.onStatus()
    // Nobody answered: it ends by itself.
    setTimeout(() => {
      if (this.pending === p && p.state === 'revealed') {
        this.endPairing('denied')
        this.deps.onStatus()
      }
    }, PAIR_TTL_MS).unref?.()
    return [200, { ok: true }]
  }

  private pairWait(pairId: string, res: ServerResponse): void {
    const p = this.pending
    const reply = () => {
      const q = this.pending
      if (!q || q.pairId !== pairId) return end(res, 200, { state: 'denied' })
      if (q.state === 'allowed') return end(res, 200, { state: 'allowed', phoneId: q.phoneId })
      if (q.state === 'denied') return end(res, 200, { state: 'denied' })
      return end(res, 200, { state: 'waiting' })
    }
    if (!p || p.pairId !== pairId || p.state !== 'revealed') return reply()
    const timer = setTimeout(() => {
      p.waiters.delete(done)
      reply()
    }, WAIT_MS)
    const done = () => {
      clearTimeout(timer)
      reply()
    }
    p.waiters.add(done)
    res.on('close', () => {
      clearTimeout(timer)
      p.waiters.delete(done)
    })
  }

  private async rpc(b: Record<string, unknown>): Promise<[number, unknown]> {
    const phone = this.phones().find((p) => p.id === b['phone'])
    if (!phone) return [401, { error: 'This phone is not paired. Connect it again.' }]
    const key = await this.keyFor(phone)
    let call: SealedCall
    try {
      call = await open<SealedCall>(key, str(b['box'], MAX_BODY), LABEL.request)
    } catch {
      return [401, { error: 'This phone is not paired. Connect it again.' }]
    }
    if (!this.fresh(phone.id, call.ts, call.n)) return [401, { error: 'Request refused: check the time on the phone.' }]
    this.touch(phone)
    let reply: SealedReply
    if (typeof call.method !== 'string' || !isPhoneMethod(call.method) || !Array.isArray(call.params)) {
      reply = { id: call.id, ok: false, error: 'Not available from a phone.' }
    } else if (call.method === 'phone.ack') {
      const r = call.params[0] as { id?: unknown } | undefined
      const waiting = typeof r?.id === 'string' ? this.asked.get(r.id) : undefined
      if (waiting && waiting.phoneId === phone.id) waiting.acked()
      reply = { id: call.id, ok: true, result: null }
    } else if (call.method === 'phone.control') {
      const r = call.params[0] as Partial<PhoneControlReport> | undefined
      if (r && (r.state === 'paused' || r.state === 'resumed' || r.state === 'ended')) {
        this.deps.onControl?.(phone.id, {
          state: r.state,
          ...(typeof r.why === 'string' ? { why: r.why.slice(0, 300) } : {}),
          ...(typeof r.actions === 'number' && Number.isFinite(r.actions) ? { actions: Math.max(0, Math.floor(r.actions)) } : {})
        })
        reply = { id: call.id, ok: true, result: null }
      } else reply = { id: call.id, ok: false, error: 'That is not a phone control state.' }
    } else if (call.method === 'phone.attach') {
      const error = this.attach(phone.id, call.params[0] as Partial<PhoneAttachPart> | undefined)
      reply = error ? { id: call.id, ok: false, error } : { id: call.id, ok: true, result: null }
    } else if (call.method === 'phone.reply') {
      // The answer to a request this computer sent: only the phone it was sent to can answer it.
      const r = call.params[0] as Partial<PhoneReply> | undefined
      const waiting = typeof r?.id === 'string' ? this.asked.get(r.id) : undefined
      if (waiting && waiting.phoneId === phone.id) {
        const image = r?.image && typeof r.image.data === 'string' && r.image.data.length < 3_000_000 && /^image\/(jpeg|png)$/.test(String(r.image.mime)) ? { mime: String(r.image.mime), data: r.image.data } : undefined
        const files = waiting.files.filter((f) => f.done).map((f) => ({ name: f.name, mime: f.mime, data: Buffer.concat(f.parts) }))
        waiting.done({ ok: r?.ok === true, text: typeof r?.text === 'string' ? r.text.slice(0, 100_000) : '', ...(image ? { image } : {}), ...(files.length ? { files } : {}) })
        reply = { id: call.id, ok: true, result: null }
      } else reply = { id: call.id, ok: false, error: 'Nothing is waiting for that answer.' }
    } else {
      try {
        let result = (await this.deps.call(call.method, call.params, phone)) ?? null
        // The phone learns here where to find this computer away from home, and keeps it with its pairing.
        if (call.method === 'phone.hello' && result && typeof result === 'object') result = { ...result, relay: await this.relayInfo() }
        reply = { id: call.id, ok: true, result }
      } catch (err) {
        reply = { id: call.id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    return [200, { box: await seal(key, reply, LABEL.response) }]
  }

  /** A phone asks to listen: it must be paired and prove it with a fresh sealed note. The reason when it may not. */
  private async admit(phoneId: unknown, auth: unknown): Promise<{ phone: PhoneRecord; key: CryptoKey } | string> {
    const phone = this.phones().find((p) => p.id === phoneId)
    if (!phone) return 'This phone is not paired.'
    const key = await this.keyFor(phone)
    try {
      const proof = await open<{ ts: number; n: string }>(key, typeof auth === 'string' ? auth : '', LABEL.listen)
      if (!this.fresh(phone.id, proof.ts, proof.n)) return 'Refused: check the time on the phone.'
    } catch {
      return 'This phone is not paired.'
    }
    return { phone, key }
  }

  private async events(url: URL, res: ServerResponse): Promise<void> {
    const ok = await this.admit(url.searchParams.get('phone'), url.searchParams.get('auth'))
    if (typeof ok === 'string') return end(res, 401, { error: ok })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n')
    const listener: Listener = {
      phoneId: ok.phone.id,
      key: ok.key,
      write: (box) => void res.write(`data: ${box}\n\n`),
      end: () => void res.end(),
      ping: () => void res.write(': ping\n\n'),
      queue: Promise.resolve()
    }
    this.listeners.add(listener)
    this.touch(ok.phone)
    res.on('close', () => this.listeners.delete(listener))
  }

  /**
   * Something a phone sent through the relay: a sealed request, or a request to listen. Each is checked exactly as on the
   * Wi-Fi (`rpc`, `admit`); nothing else is answered, so a phone can't be paired, or the app handed out, through the relay.
   */
  private async relayFrame(conn: string, text: string): Promise<void> {
    if (!this.server) return
    let f: Partial<RelayPhoneFrame>
    try {
      f = JSON.parse(text) as Partial<RelayPhoneFrame>
    } catch {
      return
    }
    const send = (frame: RelayHostFrame) => this.relay.send(conn, JSON.stringify(frame))
    if (f.t === 'rpc' && typeof f.id === 'number') {
      let status: number
      let value: { box?: string; error?: string }
      try {
        ;[status, value] = (await this.rpc({ phone: f.phone, box: f.box })) as [number, { box?: string; error?: string }]
      } catch {
        ;[status, value] = [400, { error: 'Bad request' }]
      }
      return send({ t: 'rpc', id: f.id, status, ...value })
    }
    if (f.t === 'listen') {
      const ok = await this.admit(f.phone, f.auth)
      if (typeof ok === 'string') {
        send({ t: 'listen', ok: false, error: ok })
        return this.relay.close(conn)
      }
      // The same connection asking again replaces its listener.
      for (const l of [...this.listeners]) if (l.conn === conn) this.listeners.delete(l)
      this.listeners.add({
        phoneId: ok.phone.id,
        key: ok.key,
        conn,
        write: (box) => send({ t: 'push', box }),
        end: () => this.relay.close(conn),
        queue: Promise.resolve()
      })
      this.touch(ok.phone)
      send({ t: 'listen', ok: true })
    }
  }

  private installPage(res: ServerResponse): void {
    const apk = !!this.deps.apkFile()
    const name = escapeHtml(this.deps.computerName())
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(INSTALL_PAGE(name, escapeHtml(this.deps.version), apk))
  }

  private sendApk(res: ServerResponse): void {
    const file = this.deps.apkFile()
    if (!file) return end(res, 404, { error: 'The app is not on this computer yet.' })
    const size = statSync(file).size
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(size),
      'content-disposition': `attachment; filename="celeste-${this.deps.version}.apk"`,
      'cache-control': 'no-store'
    })
    createReadStream(file).pipe(res)
  }
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('Bad request')
  return v
}

function end(res: ServerResponse, status: number, value?: unknown): void {
  if (res.headersSent) return void res.end()
  if (value === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
      } catch {
        reject(new Error('Bad request'))
      }
    })
    req.on('error', reject)
  })
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** The page the QR code opens on the phone. Plain HTML: it must work in any phone browser, with nothing to load from elsewhere. */
const INSTALL_PAGE = (computer: string, version: string, apk: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#080c17"><title>Celeste for Android</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#080c17;color:#f7f8fc;font:16px/1.5 system-ui,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center}
main{max-width:420px;width:100%;padding:56px 24px 32px;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;position:relative;overflow:hidden}
.glow{position:absolute;top:-260px;right:-260px;width:560px;height:560px;border-radius:50%;box-shadow:0 0 0 2px #a04684,0 0 60px 10px rgb(160 75 216/.35),inset 0 0 0 9999px #080c17;opacity:.9}
.mark{width:84px;height:84px;border-radius:50%;background:conic-gradient(from 200deg,#1b2977,#58309a,#c04a93,#f8718d,#1b2977);position:relative;margin-top:8px}
.mark::after{content:'';position:absolute;inset:16px 6px 16px 26px;border-radius:50%;background:#080c17}
h1{font-size:30px;line-height:1.15;margin:8px 0 0;position:relative}h1 span{background:linear-gradient(90deg,#f45f9d,#c06ae0,#8f8aff);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin:0;color:#aeb8d1;position:relative}.card{width:100%;background:#101826;border:1px solid #1b2538;border-radius:20px;padding:14px 16px;text-align:left;position:relative}
a.btn{display:flex;align-items:center;justify-content:center;width:100%;height:56px;border-radius:28px;background:#c9285e;color:#fff;font-weight:600;font-size:17px;text-decoration:none;box-shadow:0 8px 24px rgb(201 40 94/.3);position:relative}
ol{text-align:left;color:#aeb8d1;font-size:14px;padding-left:20px;margin:4px 0 0;position:relative}li{margin:6px 0}b{color:#f7f8fc}
</style></head><body><main><div class="glow"></div><div class="mark"></div>
<h1>Celeste for <span>Android</span></h1>
<p>Shared by <b>${computer}</b> on your Wi-Fi. Chat with Celeste from your phone, and answer what it asks.</p>
${apk ? `<div class="card"><b>Celeste</b><br><span style="color:#aeb8d1;font-size:14px">Version ${version}, the same as ${computer}</span></div>
<a class="btn" href="/celeste.apk">Install</a>
<ol><li>Chrome may say the file can be harmful, because it comes from your Wi-Fi and not from a store. It is the app ${computer} is sharing: tap <b>Download anyway</b>.</li><li>Android may ask once whether your browser can install apps. Switch it on, then go back.</li><li>Tap <b>Install</b>, then <b>Open</b>.</li><li>Celeste finds ${computer} by itself. Press <b>Allow</b> on the computer.</li></ol>`
  : `<div class="card">The app is not on this computer yet. Ask whoever set up Celeste, or build it from the project (phone/README.md).</div>`}
</main></body></html>`
