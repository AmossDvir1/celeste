// Sends a "wake up" to a phone through Firebase Cloud Messaging (HTTP v1), from the relay. The message carries one
// sealed box that only the phone can open, so Google sees a token and a block of bytes, never what is in it.
//
// The service account (a JSON key from the Firebase console) is a Worker secret: FIREBASE_SERVICE_ACCOUNT. With it the
// relay signs a short-lived request for an access token (RS256, WebCrypto) and sends with that. Nothing here is specific
// to Cloudflare, so the tests run the same code in Node against a stand-in for Google.

export interface FcmEnv {
  FIREBASE_SERVICE_ACCOUNT?: string
  /** Tests only: where Google's servers are stood in for. */
  FCM_ENDPOINT?: string
  TOKEN_ENDPOINT?: string
}

interface Account {
  client_email: string
  private_key: string
  project_id: string
  token_uri?: string
}

export type Wake = { ok: true } | { ok: false; code: 'NOT_CONFIGURED' | 'UNREGISTERED' | 'INVALID' | 'AUTH' | 'FAILED' }

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
let cached: { token: string; until: number; key: string } | null = null
let signer: { text: string; key: Promise<CryptoKey> } | null = null

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b)
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function account(env: FcmEnv): Account | null {
  try {
    const a = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT ?? '') as Partial<Account>
    return typeof a.client_email === 'string' && typeof a.private_key === 'string' && typeof a.project_id === 'string' ? (a as Account) : null
  } catch {
    return null
  }
}

function privateKey(pem: string): Promise<CryptoKey> {
  if (signer?.text !== pem) {
    const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----|\s/g, '')), (c) => c.charCodeAt(0))
    signer = { text: pem, key: crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']) }
  }
  return signer.key
}

async function accessToken(a: Account, env: FcmEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.key === a.client_email && cached.until > now + 120) return cached.token
  const uri = env.TOKEN_ENDPOINT ?? a.token_uri ?? 'https://oauth2.googleapis.com/token'
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await privateKey(a.private_key), new TextEncoder().encode(`${head}.${claim}`))
  const res = await fetch(uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64url(sig)}` })
  })
  const v = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!res.ok || !v.access_token) throw new Error(`token ${res.status}`)
  cached = { token: v.access_token, until: now + (v.expires_in ?? 3600), key: a.client_email }
  return v.access_token
}

/** Asks Google to deliver `box` to the phone with this FCM token, as a high-priority data message. */
export async function sendWake(env: FcmEnv, token: string, box: string, ttlSeconds: number): Promise<Wake> {
  const a = account(env)
  if (!a) return { ok: false, code: 'NOT_CONFIGURED' }
  const url = `${env.FCM_ENDPOINT ?? 'https://fcm.googleapis.com'}/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`
  const body = JSON.stringify({ message: { token, data: { b: box }, android: { priority: 'HIGH', ttl: `${ttlSeconds}s` } } })
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(a, env)}`, 'content-type': 'application/json' }, body })
    } catch {
      cached = null
      if (attempt === 0) continue
      return { ok: false, code: 'AUTH' }
    }
    if (res.ok) return { ok: true }
    const text = await res.text().catch(() => '')
    // An old access token: ask for a new one, once.
    if (res.status === 401 && attempt === 0) {
      cached = null
      continue
    }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'AUTH' }
    // The phone no longer has the app, or the token was replaced: the computer forgets it.
    if (res.status === 404 || text.includes('UNREGISTERED')) return { ok: false, code: 'UNREGISTERED' }
    if (res.status === 400) return { ok: false, code: 'INVALID' }
    return { ok: false, code: 'FAILED' }
  }
  return { ok: false, code: 'FAILED' }
}
