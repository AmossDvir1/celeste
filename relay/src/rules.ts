// The relay's rules, with nothing of Cloudflare's in them, so the Worker (worker.ts) and the stand-in the desktop's
// tests use (src/core/testing/relay.ts) follow the same ones.
//
// One room per computer. In it: one host (the computer) and a few phones. The relay reads nothing it passes.
//   phone → relay:  any text                 relay → host:  "<conn> <text>"
//   host  → relay:  "<conn> <text>"          relay → phone: "<text>"
//   relay → host:   "<conn> -"               that phone's socket closed
//   host  → relay:  "<conn> !close"          close that phone's socket (a phone the computer no longer knows)
//   relay → phone:  "!host 1" / "!host 0"    the computer is here / is not
//   either → relay: "ping"                   answered "pong" (by the Worker without waking it)

export const HOST_PROTOCOL = 'celeste.host'
export const PHONE_PROTOCOL = 'celeste.phone'

/** Room names and host secrets: base64url, as the computer makes them. */
export const ROOM_RE = /^[A-Za-z0-9_-]{20,64}$/
export const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/

export const MAX_PHONES = 8
/** A sealed file part is under 2 MB; nothing a phone or a computer sends is larger than this. */
export const MAX_FRAME = 6_000_000
/** A phone's frames: this many at once, refilled at this many a second. Past it the phone's socket is closed. */
export const BURST = 240
export const PER_SECOND = 8
/** A room nobody's computer has come back to for this long is forgotten. */
export const FORGET_AFTER_MS = 60 * 24 * 3600_000

export const CLOSE = {
  replaced: 4001,
  tooFast: 4008,
  tooLarge: 4009,
  full: 4010,
  byHost: 4011
} as const

/** What a connection asks to be, from its `Sec-WebSocket-Protocol` header. Null: not one of ours. */
export function role(header: string | null | undefined): { role: 'host'; secret: string } | { role: 'phone' } | null {
  const parts = (header ?? '').split(',').map((s) => s.trim())
  if (parts[0] === PHONE_PROTOCOL && parts.length === 1) return { role: 'phone' }
  if (parts[0] === HOST_PROTOCOL && parts.length === 2 && SECRET_RE.test(parts[1] as string)) return { role: 'host', secret: parts[1] as string }
  return null
}

/** A host's frame, split into the phone it is for and the text. Null: not a frame. */
export function hostFrame(text: string): { conn: string; text: string } | null {
  const cut = text.indexOf(' ')
  if (cut !== CONN_LENGTH || !CONN_RE.test(text.slice(0, cut))) return null
  return { conn: text.slice(0, cut), text: text.slice(cut + 1) }
}

/** A phone connection's name in its room: 12 hex characters, made by the relay. */
export const CONN_LENGTH = 12
const CONN_RE = /^[0-9a-f]{12}$/
export function newConn(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A token bucket for one phone. `take` is false when it has sent too much too fast. */
export interface Bucket {
  tokens: number
  at: number
}
export function take(b: Bucket | undefined, now: number): { ok: boolean; bucket: Bucket } {
  const had = b ?? { tokens: BURST, at: now }
  const tokens = Math.min(BURST, had.tokens + ((now - had.at) / 1000) * PER_SECOND)
  if (tokens < 1) return { ok: false, bucket: { tokens, at: now } }
  return { ok: true, bucket: { tokens: tokens - 1, at: now } }
}

export async function sha256Hex(text: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compares two strings of the same kind without stopping at the first difference. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
