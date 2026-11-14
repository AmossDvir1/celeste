import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/*
 * "Continue with ChatGPT": OpenAI's open-source route for using a person's ChatGPT plan in a local app
 * (developers.openai.com/siwc/token-sharing-open-source). The app registers itself on the first sign-in, so there is no client
 * secret and no partner key in this repository. The person signs in in their own browser; the answer comes back to a listener on
 * 127.0.0.1; the code is exchanged with PKCE; the ID token and the granted scopes are checked before anything is stored.
 * The access token is only ever handed to the Codex program, as an environment variable.
 */

export const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const FIRST_CLIENT = 'dynamic_agent_client'
/** The name OpenAI shows on its consent screen and keeps across installations. It must match Codex's `clientInfo.name`. */
export const APP_NAME = 'celeste'
const PREFERRED_PORT = 1455
export const SIGN_IN_LIMIT_MS = 10 * 60_000
/** A token this close to its end is replaced before it is used. */
const REFRESH_AHEAD_MS = 5 * 60_000

export interface TokenRecord {
  email: string | null
  issuer: string
  subject: string
  client_id: string
  ext_agent_host_id: string
  id_token: string
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scopes: string[]
  /** When this app received the token response, in milliseconds since 1970. */
  saved_at: number
}

export class AuthError extends Error {
  constructor(
    message: string,
    /** True when signing in again is the only way forward. */
    readonly reauthenticate = false
  ) {
    super(message)
  }
}

export interface AuthDeps {
  /** Where the sign-in is kept: the secret store of the main process. */
  store: { get: () => Promise<string | null>; set: (value: string) => Promise<boolean>; remove: () => Promise<void> }
  /** An opaque id for this computer, chosen once and kept. */
  hostId: () => string
  fetch?: typeof fetch
  now?: () => number
  /** Another address than OpenAI's for the sign-in service. For app checks, which run a stand-in. */
  issuer?: string
  /** The address Codex sends its requests to (the same bearer token is accepted there). */
  resource?: string
  /** The first port tried for the loopback listener. 0 picks any free one. */
  port?: number
}

const b64url = (buf: Buffer): string => buf.toString('base64url')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

/** A host id in the form OpenAI accepts that holds nothing about the person. Made once and kept by the caller. */
export const newHostId = (): string => `urn:uuid:${randomUUID()}`

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

interface Jwk {
  kty: string
  kid?: string
  alg?: string
  [key: string]: unknown
}

/** What a valid ID token says about the account, once its signature, issuer, audience, expiry and nonce have been checked. */
export function verifyIdToken(
  token: string,
  jwks: Jwk[],
  expect: { issuer: string; audience: string; nonce: string; now: number }
): { subject: string; email: string | null } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AuthError('OpenAI sent an ID token Celeste could not read.')
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = decodePart(parts[0] as string)
    claims = decodePart(parts[1] as string)
  } catch {
    throw new AuthError('OpenAI sent an ID token Celeste could not read.')
  }
  const alg = header['alg']
  if (alg !== 'RS256' && alg !== 'ES256') throw new AuthError('OpenAI signed the ID token in a way Celeste does not accept.')
  const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined
  const jwk = jwks.find((k) => (kid ? k.kid === kid : true) && (k.kty === (alg === 'RS256' ? 'RSA' : 'EC')))
  if (!jwk) throw new AuthError('The ID token was signed with a key Celeste could not find.')
  const verifier = createVerify(alg === 'RS256' ? 'RSA-SHA256' : 'SHA256')
  verifier.update(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2] as string, 'base64url')
  const key = createPublicKey({ key: jwk as never, format: 'jwk' })
  if (!verifier.verify(alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, signature)) throw new AuthError('The ID token’s signature is not valid.')
  if (claims['iss'] !== expect.issuer) throw new AuthError('The ID token is from another issuer.')
  const aud = claims['aud']
  if (!(aud === expect.audience || (Array.isArray(aud) && aud.includes(expect.audience)))) throw new AuthError('The ID token is for another app.')
  if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 <= expect.now) throw new AuthError('The ID token has expired.')
  if (claims['nonce'] !== expect.nonce) throw new AuthError('The ID token does not belong to this sign-in attempt.')
  if (typeof claims['sub'] !== 'string' || !claims['sub']) throw new AuthError('The ID token names no account.')
  return { subject: claims['sub'], email: typeof claims['email'] === 'string' ? claims['email'] : null }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p>`

export interface SignInHandle {
  /** The address to open in the person's browser. */
  url: string
  /** Resolves with the stored record when they finish, and rejects when they refuse, it takes too long, or the answer is not valid. */
  done: Promise<TokenRecord>
  cancel: () => void
}

export class ChatgptAuth {
  private readonly get: typeof fetch
  private readonly now: () => number
  private readonly issuer: string
  private readonly resource: string
  private refreshing: Promise<TokenRecord> | undefined

  constructor(private readonly deps: AuthDeps) {
    this.get = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.issuer = (deps.issuer ?? ISSUER).replace(/\/+$/, '')
    this.resource = deps.resource ?? RESOURCE
  }

  // --- what is kept --------------------------------------------------------------------------------------

  async record(): Promise<TokenRecord | undefined> {
    const raw = await this.deps.store.get().catch(() => null)
    if (!raw) return undefined
    try {
      const r = JSON.parse(raw) as TokenRecord
      return r && typeof r.access_token === 'string' && typeof r.refresh_token === 'string' ? r : undefined
    } catch {
      return undefined
    }
  }

  private async keep(record: TokenRecord): Promise<void> {
    if (!(await this.deps.store.set(JSON.stringify(record)))) throw new AuthError('This computer cannot store the sign-in securely, so Celeste did not keep it.')
  }

  // --- signing in ----------------------------------------------------------------------------------------

  /** Starts the browser sign-in: the listener first, then the address to open. */
  async begin(): Promise<SignInHandle> {
    const prior = await this.record()
    const { verifier, challenge } = pkce()
    const state = b64url(randomBytes(24))
    const nonce = b64url(randomBytes(24))
    let server: Server | undefined
    type Answer = { code?: string; error?: string; clientId?: string }
    let finish: ((r: Answer) => void) | undefined
    const answer = new Promise<Answer>((resolve) => (finish = resolve))

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end()
        return
      }
      // The browser can only have been sent here by the sign-in page, but anything on this computer can reach a loopback port.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('This is not the sign-in Celeste started', 'Go back to Celeste and try again.'))
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        error ? PAGE('Signing in was cancelled', 'You can close this tab and go back to Celeste.') : PAGE('You are signed in', 'You can close this tab and go back to Celeste.')
      )
      // On a first sign-in OpenAI registers the app and names the client it made in this answer.
      const issued = url.searchParams.get('client_id') ?? undefined
      finish?.(error ? { error } : code ? { code, ...(issued ? { clientId: issued } : {}) } : { error: 'no_code' })
    })
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server?.once('error', reject)
        server?.listen(port, '127.0.0.1', () => resolve())
      })
    const wanted = this.deps.port ?? PREFERRED_PORT
    try {
      await listen(wanted)
    } catch {
      // The usual port is taken: any free one will do, only the port may differ between sign-ins.
      server.removeAllListeners('error')
      await listen(0)
    }
    const port = (server.address() as AddressInfo).port
    const redirect = `http://127.0.0.1:${port}/auth/callback`
    const hostId = this.deps.hostId()
    const clientId = prior?.client_id ?? FIRST_CLIENT

    const query = new URLSearchParams({
      client_id: clientId,
      ...(clientId === FIRST_CLIENT ? { agent_name_hint: 'Celeste' } : {}),
      ext_agent_host_id: hostId,
      ...(prior?.id_token ? { id_token_hint: prior.id_token } : {}),
      response_type: 'code',
      redirect_uri: redirect,
      scope: SCOPE,
      resource: this.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge
    })
    const url = `${this.issuer}/api/accounts/authorize?${query.toString()}`

    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(timer)
      server?.closeAllConnections?.()
      server?.close()
      server = undefined
    }
    const done = (async (): Promise<TokenRecord> => {
      const outcome: Answer = await Promise.race([
        answer,
        new Promise<Answer>((resolve) => {
          timer = setTimeout(() => resolve({ error: 'timeout' }), SIGN_IN_LIMIT_MS)
        })
      ])
      stop()
      if (outcome.error === 'timeout') throw new AuthError('Signing in took too long. Try again.')
      if (outcome.error === 'cancelled') throw new AuthError('Cancelled.')
      if (outcome.error === 'access_denied') throw new AuthError('ChatGPT plan use was not allowed. Sign in again and allow it, or paste an OpenAI API key.')
      if (!outcome.code) throw new AuthError(`OpenAI did not finish the sign-in (${outcome.error ?? 'no answer'}).`)
      // The client this account was registered under is kept. An answer for another one is not this account's.
      if (prior && outcome.clientId && outcome.clientId !== prior.client_id) throw new AuthError('OpenAI answered for a different registration, so Celeste ignored it. Try again.')
      const issued = prior?.client_id ?? outcome.clientId
      if (!issued || issued === FIRST_CLIENT) throw new AuthError('OpenAI did not finish registering Celeste. Try again.')
      return this.exchange({ code: outcome.code, verifier, redirect, clientId: issued, hostId, nonce })
    })()
    // `done` may be abandoned (cancelled) without anyone awaiting it.
    done.catch(() => undefined)
    return { url, done, cancel: () => finish?.({ error: 'cancelled' }) }
  }

  private async exchange(a: { code: string; verifier: string; redirect: string; clientId: string; hostId: string; nonce: string }): Promise<TokenRecord> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, resource: this.resource, client_id: a.clientId })
    const res = await this.get(`${this.issuer}/api/accounts/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
    if (!res) throw new AuthError('Celeste could not reach OpenAI to finish signing in.')
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* handled below */
    }
    if (!res.ok) throw new AuthError(json['error'] === 'invalid_grant' ? 'The sign-in expired before it was finished. Try again.' : `OpenAI did not accept the sign-in (${res.status}).`)
    const accessToken = json['access_token']
    const refreshToken = json['refresh_token']
    const idToken = json['id_token']
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof idToken !== 'string') throw new AuthError('OpenAI’s answer was missing a token.')
    const scopes = String(json['scope'] ?? '').split(/\s+/).filter(Boolean)
    // A valid ID token alone does not allow plan usage. The scope has to have been granted.
    if (!scopes.includes(PLAN_SCOPE)) throw new AuthError('ChatGPT plan use was not allowed. Sign in again and allow it, or paste an OpenAI API key.')
    const { subject, email } = verifyIdToken(idToken, await this.jwks(), { issuer: this.issuer, audience: a.clientId, nonce: a.nonce, now: this.now() })
    const record: TokenRecord = {
      email,
      issuer: this.issuer,
      subject,
      client_id: a.clientId,
      ext_agent_host_id: a.hostId,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: typeof json['token_type'] === 'string' ? (json['token_type'] as string) : 'Bearer',
      expires_in: typeof json['expires_in'] === 'number' ? (json['expires_in'] as number) : 3600,
      scopes: scopes.sort(),
      saved_at: this.now()
    }
    await this.keep(record)
    return record
  }

  private async jwks(): Promise<Jwk[]> {
    const config = await this.get(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? (r.json() as Promise<{ jwks_uri?: string }>) : undefined)).catch(() => undefined)
    const uri = config?.jwks_uri
    if (!uri) throw new AuthError('Celeste could not find OpenAI’s signing keys, so it will not trust the sign-in.')
    const keys = await this.get(uri, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? (r.json() as Promise<{ keys?: Jwk[] }>) : undefined)).catch(() => undefined)
    if (!keys?.keys?.length) throw new AuthError('Celeste could not read OpenAI’s signing keys, so it will not trust the sign-in.')
    return keys.keys
  }

  // --- using it ------------------------------------------------------------------------------------------

  /** The access token to hand to Codex, renewed first when it is about to end. Rejects with `AuthError` when signing in again is needed. */
  async accessToken(): Promise<string> {
    const record = await this.record()
    if (!record) throw new AuthError('You are not signed in to ChatGPT.', true)
    if (this.now() < record.saved_at + record.expires_in * 1000 - REFRESH_AHEAD_MS) return record.access_token
    return (await this.refresh(record)).access_token
  }

  /** Milliseconds the stored token is still good for. Negative once it has ended. */
  async remaining(): Promise<number> {
    const record = await this.record()
    return record ? record.saved_at + record.expires_in * 1000 - this.now() : -1
  }

  /** The refresh token is replaced each time it is used, so two refreshes at once would invalidate one another: they share one. */
  refresh(record?: TokenRecord): Promise<TokenRecord> {
    this.refreshing ??= this.doRefresh(record).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async doRefresh(known?: TokenRecord): Promise<TokenRecord> {
    const record = known ?? (await this.record())
    if (!record) throw new AuthError('You are not signed in to ChatGPT.', true)
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: record.client_id, refresh_token: record.refresh_token, resource: this.resource })
    const res = await this.get(`${this.issuer}/api/accounts/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
    if (!res) throw new AuthError('Celeste could not reach OpenAI to renew the sign-in.')
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      // A refresh token that is refused for good (revoked, expired, used twice) ends this sign-in. A server error does not.
      const gone = res.status === 400 || res.status === 401 || res.status === 403
      throw new AuthError(gone ? 'Your ChatGPT sign-in has ended. Sign in again.' : `OpenAI could not renew the sign-in (${res.status}). Try again in a moment.`, gone)
    }
    if (typeof json['access_token'] !== 'string') throw new AuthError('OpenAI’s answer was missing a token.')
    const scopes = typeof json['scope'] === 'string' ? (json['scope'] as string).split(/\s+/).filter(Boolean).sort() : record.scopes
    if (!scopes.includes(PLAN_SCOPE)) throw new AuthError('ChatGPT plan use is no longer allowed. Sign in again.', true)
    const next: TokenRecord = {
      ...record,
      access_token: json['access_token'],
      refresh_token: typeof json['refresh_token'] === 'string' ? (json['refresh_token'] as string) : record.refresh_token,
      id_token: typeof json['id_token'] === 'string' ? (json['id_token'] as string) : record.id_token,
      expires_in: typeof json['expires_in'] === 'number' ? (json['expires_in'] as number) : record.expires_in,
      scopes,
      saved_at: this.now()
    }
    await this.keep(next)
    return next
  }

  /**
   * Signs out: asks OpenAI to revoke the refresh token, then forgets everything. When OpenAI could not be reached the tokens are
   * forgotten here all the same, and `revoked` is false, so the person can be told to disconnect Celeste in ChatGPT's settings.
   */
  async signOut(): Promise<{ revoked: boolean }> {
    const record = await this.record()
    let revoked = !record
    if (record) {
      try {
        const config = await this.get(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ revocation_endpoint?: string }>)
        if (config.revocation_endpoint) {
          const res = await this.get(config.revocation_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: record.refresh_token, token_type_hint: 'refresh_token', client_id: record.client_id }),
            signal: AbortSignal.timeout(10_000)
          })
          revoked = res.ok
        }
      } catch {
        revoked = false
      }
    }
    await this.deps.store.remove().catch(() => undefined)
    return { revoked }
  }
}
