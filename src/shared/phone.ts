// The phone protocol: how the Celeste app on an Android phone talks to Celeste on a computer on the same Wi-Fi.
// See docs/PHONE_PLAN.md. Both ends import this file: Core (Node) and the phone app (a WebView), so the crypto is
// WebCrypto only (X25519, HKDF, AES-GCM, SHA-256), which both have.
//
// Pairing, with no code to type:
//   1. The phone makes a key pair and a random nonce, and sends a commitment to both: SHA-256(phone key ‖ nonce).
//   2. The computer answers with its own key and nonce.
//   3. The phone reveals its key and nonce. The computer checks them against the commitment.
//   4. Both show three emoji made from (computer key, phone key, both nonces). The person compares them and presses
//      Allow on the computer. Because the phone committed before it saw the computer's nonce, someone in the middle
//      gets one guess at matching the pictures, not millions (the same idea as Bluetooth's numeric comparison).
// After that, every request and every push is sealed with AES-GCM under a key both sides derive from their two key pairs.

import type { Effort, ModelInfo } from './agent'
import type { CorePush, SessionSummary } from './api'
import type { InputDef } from './workflow'

export const PHONE_PROTOCOL = 1
/** mDNS service type the computer announces while phones may connect: `_celeste._tcp`. */
export const PHONE_SERVICE = 'celeste'
/** How long a request may be in flight before the computer refuses it as stale. */
export const PHONE_MAX_SKEW_MS = 120_000

/** What the phone may call. Everything else is refused before it reaches Core: a phone is never an admin. */
export const PHONE_METHODS = [
  'phone.hello',
  'phone.newChat',
  'phone.projects',
  'phone.models',
  'phone.setModel',
  'phone.reply',
  'phone.ack',
  'phone.attach',
  'phone.control',
  'phone.workflows',
  'phone.runWorkflow',
  'sessions.get',
  'sessions.send',
  'sessions.interrupt',
  'sessions.respondApproval',
  'sessions.respondAsk',
  'workflows.list',
  'runs.list',
  'runs.get',
  'runs.respondApproval',
  'runs.respondAsk'
] as const
export type PhoneMethod = (typeof PHONE_METHODS)[number]
export const isPhoneMethod = (m: string): m is PhoneMethod => (PHONE_METHODS as readonly string[]).includes(m)

/** The pushes a phone receives. Terminals, vendor sign-ins, devices and tools stay on the computer. */
export const PHONE_PUSHES: CorePush['type'][] = ['event', 'summary', 'removed', 'run', 'runEvent', 'workflows']

/** A phone that was allowed to connect. */
export interface PhoneRecord {
  id: string
  name: string
  /** The phone's public key, base64. */
  key: string
  pairedAt: number
  lastSeen: number
}

/** What the computer says about itself, before and after pairing. */
export interface PhoneHello {
  protocol: number
  /** The computer's name, as people know it ("DANA-PC"). */
  name: string
  /** A short id for this Celeste, so a phone can tell two computers with the same name apart. */
  id: string
  version: string
  /** The computer's public key, base64. */
  key: string
}

/** What `phone.hello` answers once paired: enough to draw the chat list. */
export interface PhoneBootstrap {
  computer: string
  version: string
  userName: string
  theme: 'dark' | 'light' | 'system'
  sessions: SessionSummary[]
}

/** A project the phone may start a Develop session in: one the person already used for Develop on the computer. */
export interface PhoneProject {
  path: string
  name: string
  /** The branch it is on now, if it is a git project. */
  branch: string | null
  lastUsed: number
}

/** The models the phone may pick, from the assistants connected on the computer, and the ones the person pinned there. */
export interface PhoneModels {
  models: ModelInfo[]
  pinned: string[]
}

/** A model from `phone.models`, and its effort. Left out, the session carries on with the person's usual one. */
export interface PhoneModelChoice {
  model?: string
  effort?: Effort | null
}

/** How the phone starts a session. A Develop session needs one of `phone.projects`; a phone can never name another folder. */
export type PhoneNewSession = ({ mode: 'chat' } | { mode: 'develop'; project: string; /** Work in a separate copy (a git worktree) on a new branch. */ copy?: boolean }) &
  PhoneModelChoice

/**
 * Phone abilities: what the assistant may ask the phone to do (docs/PHONE_PLAN.md, step A2). Each is switched on in the app,
 * and each request (except `status`) is approved on the phone by the person holding it.
 */
export type PhoneAbility =
  | 'status'
  | 'notifications'
  | 'notification_reply'
  | 'notification_dismiss'
  | 'open'
  | 'alarm'
  | 'location'
  /** Photos and files the person picks on the phone; they arrive with `phone.attach` before the reply. */
  | 'photos'
  | 'files'
  | 'calendar'
  | 'calendar_add'
  /** Texts and calls: the phone's own app opens with everything filled in, and the person presses Send or Call. */
  | 'message'
  | 'call'
  /** Phone control (step A3): asked for once, on the phone, for a limited time; then the actions below need no card each. */
  | 'control_request'
  | 'control_screen'
  | 'control_tap'
  | 'control_type'
  | 'control_swipe'
  | 'control_key'
  | 'control_release'
export interface PhoneRequest {
  id: string
  ability: PhoneAbility
  args: Record<string, unknown>
  /** The chat that asks, for the card on the phone. */
  chat: string
}
/** Sent on a phone's stream only: the computer asks it to do something. Not a CorePush; other windows never see it. */
export interface PhoneRequestPush {
  type: 'phoneRequest'
  request: PhoneRequest
}
/** Sent on a phone's stream when the person pressed Stop in the chat: drop these requests' cards, and end phone control. */
export interface PhoneCancelPush {
  type: 'phoneCancel'
  ids: string[]
  endControl: boolean
  /** Why control ends, for the phone to show. Left out: Stop was pressed in the chat. */
  why?: string
}

/** The phone's answer, with `phone.reply`. */
export interface PhoneReply {
  id: string
  ok: boolean
  text: string
  /** A screenshot, for phone control: JPEG, base64. */
  image?: { mime: string; data: string }
}

/** A workflow the phone may start: what Start asks for, and nothing of what its steps do (the run's own card shows that). */
export interface PhoneWorkflow {
  id: string
  name: string
  description: string
  inputs: InputDef[]
}

/**
 * What happened to phone control on the phone, with `phone.control`, for the card in the computer's chat. The computer
 * writes the start and each action itself; only what the person does on the phone comes from there.
 */
export interface PhoneControlReport {
  state: 'paused' | 'resumed' | 'ended'
  /** Why it ended, in the person's words ("The user pressed Stop on the phone."). */
  why?: string
  /** How many actions it took, when it ended. */
  actions?: number
}

/**
 * Part of a file the person picked on the phone (a photo or a document), with `phone.attach`, sent before the
 * `phone.reply` that answers the request. Files go one after another, each in parts, in order.
 */
export interface PhoneAttachPart {
  /** The request it answers. */
  id: string
  /** Which file, from 0. */
  file: number
  name: string
  mime: string
  /** Which part of the file, from 0. */
  part: number
  /** The part's bytes, base64. */
  data: string
  /** The file's last part. */
  last: boolean
}
/** Bytes in one part: base64 twice over (here, then sealed), a part stays well under the bridge's 4 MB limit on a call. */
export const PHONE_ATTACH_PART = 1_048_576
export const PHONE_ATTACH_MAX_FILES = 10
/** All the files for one request together. */
export const PHONE_ATTACH_MAX_BYTES = 40 * 1_048_576

/** A pairing waiting for the person at the computer. */
export interface PhonePairRequest {
  pairId: string
  name: string
  emoji: string[]
  at: number
}

/** What Settings → Phone shows. */
export interface PhoneStatus {
  enabled: boolean
  /** Listening and announced on the network. */
  running: boolean
  port: number | null
  /** The computer's addresses on the local network. The first is the likeliest. */
  addresses: string[]
  phones: PhoneRecord[]
  /** The page that installs the app, for the QR code. Null when not running. */
  installUrl: string | null
  /** An app file (APK) is there to hand out. */
  apk: boolean
  pending: PhonePairRequest | null
  error?: string
  /** Something about the network that keeps phones out (Windows: it is set to Public), with how to fix it. */
  network?: string
}

/** The pictures the two screens compare. 64 that are easy to tell apart and to say out loud. */
export const SAS_EMOJI = [
  '🦊', '🌙', '🎈', '🐢', '🍋', '🚲', '🎸', '🌵', '🐙', '🍉', '🚀', '🎩', '🐝', '🍄', '⚓', '🎲',
  '🦋', '🍩', '🔑', '🐳', '🌈', '🍒', '🧭', '🐧', '🌻', '🍕', '🛶', '🦉', '🍪', '🔔', '🐞', '⛄',
  '🦒', '🍍', '📷', '🐸', '🌋', '🥕', '🎁', '🦀', '🍇', '🧲', '🐼', '🌶', '🛸', '🦔', '🥨', '🎯',
  '🐬', '🍓', '🧩', '🦜', '🌽', '🎺', '🐌', '🍎', '🪁', '🦈', '🥥', '💡', '🐿', '🌰', '🎻', '🦩'
]

const enc = new TextEncoder()
const dec = new TextDecoder()
const subtle = () => globalThis.crypto.subtle

export function toB64(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number)
  return btoa(s)
}
export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text)
  const out = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
export function randomB64(bytes = 16): string {
  return toB64(globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(bytes))))
}
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A private key as JSON (a JWK). */
export type Jwk = Record<string, unknown>

/** A key pair that can be kept as text: the private half as a JWK, the public half as raw base64. */
export interface StoredKeyPair {
  pub: string
  priv: Jwk
}

/**
 * X25519 done outside WebCrypto, for phones whose WebView is older than Chrome 133 (which added X25519 to WebCrypto).
 * The phone app passes an audited pure-JS one (@noble/curves). Keys look the same either way (an OKP JWK and raw bytes),
 * so a phone whose WebView is updated later keeps its pairing.
 */
export interface X25519Fallback {
  /** A new private key (32 random bytes) and its public key. */
  keyPair(): { priv: Uint8Array; pub: Uint8Array }
  shared(priv: Uint8Array, peerPub: Uint8Array): Uint8Array
}
let fallback: X25519Fallback | null = null
let nativeX25519: Promise<boolean> | null = null
/** `force` is for tests: true uses the fallback even where WebCrypto has X25519, false goes back to asking WebCrypto. */
export function setX25519Fallback(impl: X25519Fallback | null, force?: boolean): void {
  fallback = impl
  if (force !== undefined) nativeX25519 = force ? Promise.resolve(false) : null
}
function hasNativeX25519(): Promise<boolean> {
  nativeX25519 ??= Promise.resolve(subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])).then(
    () => true,
    () => false
  )
  return nativeX25519
}
async function useFallback(): Promise<X25519Fallback | null> {
  if (await hasNativeX25519()) return null
  if (!fallback) throw new Error('This phone’s web view is too old for Celeste’s encryption. Update “Android System WebView” from the Play Store.')
  return fallback
}
const b64url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))

export async function makeKeyPair(): Promise<StoredKeyPair> {
  const f = await useFallback()
  if (f) {
    const { priv, pub } = f.keyPair()
    return { pub: toB64(pub), priv: { kty: 'OKP', crv: 'X25519', d: b64url(priv), x: b64url(pub), ext: true, key_ops: ['deriveBits'] } }
  }
  const pair = (await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey }
  return { pub: toB64(await subtle().exportKey('raw', pair.publicKey)), priv: (await subtle().exportKey('jwk', pair.privateKey)) as Jwk }
}

async function sharedBits(priv: Jwk, peerPub: string): Promise<ArrayBuffer> {
  const f = await useFallback()
  if (f) {
    const bits = f.shared(fromB64url(String(priv['d'])), fromB64(peerPub))
    return concat(bits).buffer
  }
  const mine = await subtle().importKey('jwk', priv as never, { name: 'X25519' }, false, ['deriveBits'])
  const theirs = await subtle().importKey('raw', fromB64(peerPub), { name: 'X25519' }, false, [])
  return subtle().deriveBits({ name: 'X25519', public: theirs }, mine, 256)
}

/**
 * The raw 32-byte key one computer and one phone share. Either side computes it from its private half and the other's
 * public half. The phone hands it to its background service, which seals and opens with plain AES-GCM.
 */
export async function sessionKeyBytes(priv: Jwk, peerPub: string, computerPub: string, phonePub: string): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await sharedBits(priv, peerPub)
  const base = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveBits'])
  const out = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('celeste-phone-v1'), info: concat(fromB64(computerPub), fromB64(phonePub)) }, base, 256)
  return new Uint8Array(out)
}

/** The shared key, ready for `seal` and `open`. */
export async function sessionKey(priv: Jwk, peerPub: string, computerPub: string, phonePub: string): Promise<CryptoKey> {
  const raw = await sessionKeyBytes(priv, peerPub, computerPub, phonePub)
  return subtle().importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Seals a value for the other side: base64 of a 12-byte IV followed by the AES-GCM ciphertext. `label` binds it to its use. */
export async function seal(key: CryptoKey, value: unknown, label: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, enc.encode(JSON.stringify(value)))
  return toB64(concat(iv, new Uint8Array(ct)))
}

/** Opens what `seal` made, or throws when it was changed, made with another key, or for another use. */
export async function open<T = unknown>(key: CryptoKey, box: string, label: string): Promise<T> {
  const bytes = fromB64(box)
  if (bytes.length < 29) throw new Error('Too short')
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(label) }, key, bytes.slice(12))
  return JSON.parse(dec.decode(pt)) as T
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', concat(...parts)))
}

/** Step 1: what the phone sends before it sees anything of the computer's. */
export async function commitment(phonePub: string, phoneNonce: string): Promise<string> {
  return toB64(await sha256(enc.encode('celeste-commit'), fromB64(phonePub), fromB64(phoneNonce)))
}

/** Step 4: the three pictures. The same on both screens unless someone is in the middle. */
export async function pairingEmoji(computerPub: string, phonePub: string, phoneNonce: string, computerNonce: string): Promise<string[]> {
  const h = await sha256(enc.encode('celeste-sas'), fromB64(computerPub), fromB64(phonePub), fromB64(phoneNonce), fromB64(computerNonce))
  return [0, 1, 2].map((i) => SAS_EMOJI[(h[i] as number) & 63] as string)
}

/** Labels for `seal`, so a sealed request can never be replayed as a response or a push. */
export const LABEL = {
  request: 'celeste-rpc-request',
  response: 'celeste-rpc-response',
  push: 'celeste-push',
  listen: 'celeste-listen'
} as const

/** A sealed request's contents. `n` is random and `ts` is the phone's clock: together they stop a recorded request being sent again. */
export interface SealedCall {
  id: number
  method: PhoneMethod
  params: unknown[]
  ts: number
  n: string
}
export type SealedReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
