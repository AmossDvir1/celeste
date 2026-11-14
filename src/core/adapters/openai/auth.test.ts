import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthError, ChatgptAuth, pkce, verifyIdToken, type TokenRecord } from './auth'
import { FAKE_CLIENT, FakeChatgptAuth } from './fake-chatgpt-auth'

/*
 * "Continue with ChatGPT" against a stand-in for OpenAI's sign-in service that signs real ID tokens: the address the person's browser
 * is sent to, the answer coming back to the loopback listener, the code exchange, every check on the ID token and the scopes, renewal
 * of an expiring token, and signing out.
 */

const CLIENT = FAKE_CLIENT
const SECRET_FIELDS = ['access_token', 'refresh_token', 'id_token']

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')

describe('Continue with ChatGPT', () => {
  const issuer = new FakeChatgptAuth()
  let kept: string | null
  let now: number
  let removed: boolean
  let auth: ChatgptAuth

  beforeEach(async () => {
    await issuer.start()
    issuer.scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
    issuer.tamper = () => undefined
    issuer.badSignature = false
    issuer.refreshStatus = 200
    issuer.revocationStatus = 200
    issuer.posts = []
    issuer.revoked = []
    issuer.authorized = undefined
    kept = null
    removed = false
    now = Date.now()
    auth = new ChatgptAuth({
      store: { get: async () => kept, set: async (v) => ((kept = v), true), remove: async () => ((kept = null), void (removed = true)) },
      hostId: () => 'urn:uuid:11111111-1111-4111-8111-111111111111',
      issuer: issuer.url,
      resource: 'https://api.openai.com/v1',
      port: 0,
      now: () => now
    })
  })
  afterEach(() => issuer.stop())

  /** What the browser does: opens the address, and OpenAI sends it to the redirect address with the answer. */
  async function browser(handle: { url: string }, answer: (redirect: string, state: string) => string): Promise<Response> {
    const q = new URL(handle.url).searchParams
    issuer.authorized = { nonce: q.get('nonce') ?? '', redirect: q.get('redirect_uri') ?? '', state: q.get('state') ?? '', query: q }
    return fetch(answer(issuer.authorized.redirect, issuer.authorized.state))
  }
  const ok = (redirect: string, state: string) => `${redirect}?code=the-code&state=${state}&client_id=${CLIENT}`

  it('sends the person to OpenAI with every parameter OpenAI asks for, and nothing secret', async () => {
    const handle = await auth.begin()
    const u = new URL(handle.url)
    expect(`${u.origin}${u.pathname}`).toBe(`${issuer.url}/api/accounts/authorize`)
    const q = u.searchParams
    expect(q.get('client_id')).toBe('dynamic_agent_client')
    expect(q.get('agent_name_hint')).toBe('Celeste')
    expect(q.get('ext_agent_host_id')).toBe('urn:uuid:11111111-1111-4111-8111-111111111111')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
    expect(q.get('resource')).toBe('https://api.openai.com/v1')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')?.length).toBeGreaterThan(40)
    expect(q.get('state')?.length).toBeGreaterThan(20)
    expect(q.get('nonce')?.length).toBeGreaterThan(20)
    expect(q.get('id_token_hint')).toBeNull()
    // Loopback only, on 127.0.0.1 (not "localhost"), on the callback path.
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    handle.cancel()
    await expect(handle.done).rejects.toThrow('Cancelled.')
  })

  it('finishes a first sign-in: registers, exchanges the code with PKCE, checks the token and keeps the record', async () => {
    const handle = await auth.begin()
    const page = await browser(handle, ok)
    expect(page.status).toBe(200)
    const record = await handle.done
    // The client OpenAI issued in the answer is the one the code is exchanged under, and the one that is kept.
    const form = issuer.posts[0] as URLSearchParams
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('client_id')).toBe(CLIENT)
    expect(form.get('code')).toBe('the-code')
    expect(form.get('redirect_uri')).toBe(issuer.authorized?.redirect)
    expect(form.get('resource')).toBe('https://api.openai.com/v1')
    // The verifier is the one whose challenge was sent.
    const challenge = pkce().challenge
    expect(challenge).not.toBe(issuer.authorized?.query.get('code_challenge'))
    expect(record).toMatchObject({ email: 'dana@example.com', subject: 'user-123', client_id: CLIENT, expires_in: 3600, ext_agent_host_id: 'urn:uuid:11111111-1111-4111-8111-111111111111' })
    expect(record.scopes).toContain('chatgpt.tokens.use.direct')
    expect(JSON.parse(kept as string)).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-0' })
  })

  it('answers the browser, and ignores an answer that is not for this attempt', async () => {
    const handle = await auth.begin()
    const q = new URL(handle.url).searchParams
    const redirect = q.get('redirect_uri') as string
    const stray = await fetch(`${redirect}?code=x&state=not-ours&client_id=${CLIENT}`)
    expect(stray.status).toBe(400)
    expect((await fetch(redirect.replace('/auth/callback', '/other'))).status).toBe(404)
    // The real answer still works afterwards.
    issuer.authorized = { nonce: q.get('nonce') ?? '', redirect, state: q.get('state') ?? '', query: q }
    await fetch(ok(redirect, q.get('state') ?? ''))
    await expect(handle.done).resolves.toMatchObject({ client_id: CLIENT })
  })

  it('refuses a refused consent, and a sign-in without the permission to use the plan', async () => {
    const denied = await auth.begin()
    await browser(denied, (redirect, state) => `${redirect}?error=access_denied&state=${state}`)
    await expect(denied.done).rejects.toThrow(/plan use was not allowed/)
    expect(issuer.posts).toHaveLength(0)

    issuer.scope = 'openid profile email offline_access'
    const noPlan = await auth.begin()
    await browser(noPlan, ok)
    await expect(noPlan.done).rejects.toThrow(/plan use was not allowed/)
    expect(kept).toBeNull()
  })

  it.each([
    ['a bad signature', (i: FakeChatgptAuth) => void (i.badSignature = true), /signature/],
    ['another issuer', (i: FakeChatgptAuth) => void (i.tamper = (c) => (c['iss'] = 'https://evil.example')), /issuer/],
    ['another app', (i: FakeChatgptAuth) => void (i.tamper = (c) => (c['aud'] = 'someone_else')), /another app/],
    ['an old token', (i: FakeChatgptAuth) => void (i.tamper = (c) => (c['exp'] = Math.floor(Date.now() / 1000) - 10)), /expired/],
    ['another attempt (wrong nonce)', (i: FakeChatgptAuth) => void (i.tamper = (c) => (c['nonce'] = 'replayed')), /this sign-in attempt/]
  ])('does not trust an ID token with %s', async (_name, setup, message) => {
    setup(issuer)
    const handle = await auth.begin()
    await browser(handle, ok)
    await expect(handle.done).rejects.toThrow(message)
    expect(kept).toBeNull()
  })

  it('uses the token as it is while it is good, and renews it before it ends, once, with the same client', async () => {
    const first = await auth.begin()
    await browser(first, ok)
    await first.done
    expect(await auth.accessToken()).toBe('access-1')
    expect(issuer.posts).toHaveLength(1)
    // Ten minutes before the end, nothing happens. Four minutes before, it is renewed.
    now += 50 * 60_000
    expect(await auth.accessToken()).toBe('access-1')
    now += 6 * 60_000
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()])
    expect(a).toBe('access-refreshed-1')
    expect(b).toBe('access-refreshed-1')
    const refreshes = issuer.posts.filter((p) => p.get('grant_type') === 'refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]?.get('client_id')).toBe(CLIENT)
    expect(refreshes[0]?.get('refresh_token')).toBe('refresh-0')
    expect(refreshes[0]?.get('resource')).toBe('https://api.openai.com/v1')
    // The rotated refresh token is the one kept.
    expect(JSON.parse(kept as string)).toMatchObject({ access_token: 'access-refreshed-1', refresh_token: 'refresh-1' })
  })

  it('says to sign in again when the sign-in has been ended on OpenAI’s side, but not when OpenAI is only having trouble', async () => {
    const first = await auth.begin()
    await browser(first, ok)
    await first.done
    now += 2 * 3600_000
    issuer.refreshStatus = 500
    await expect(auth.accessToken()).rejects.toMatchObject({ reauthenticate: false })
    issuer.refreshStatus = 400
    await expect(auth.accessToken()).rejects.toMatchObject({ reauthenticate: true })
    await expect(auth.accessToken()).rejects.toBeInstanceOf(AuthError)
  })

  it('signs back in with the client it was registered under, naming the account', async () => {
    const first = await auth.begin()
    await browser(first, ok)
    await first.done
    const again = await auth.begin()
    const q = new URL(again.url).searchParams
    expect(q.get('client_id')).toBe(CLIENT)
    expect(q.get('agent_name_hint')).toBeNull()
    expect(q.get('id_token_hint')).toBe((JSON.parse(kept as string) as TokenRecord).id_token)
    again.cancel()
    await expect(again.done).rejects.toThrow()
  })

  it('signs out by revoking the refresh token, and forgets everything even when OpenAI cannot be reached', async () => {
    const first = await auth.begin()
    await browser(first, ok)
    await first.done
    expect(await auth.signOut()).toEqual({ revoked: true })
    const form = issuer.revoked[0] as URLSearchParams
    expect(form.get('token')).toBe('refresh-0')
    expect(form.get('token_type_hint')).toBe('refresh_token')
    expect(form.get('client_id')).toBe(CLIENT)
    expect(removed).toBe(true)
    expect(await auth.record()).toBeUndefined()

    const second = await auth.begin()
    await browser(second, ok)
    await second.done
    issuer.revocationStatus = 503
    expect(await auth.signOut()).toEqual({ revoked: false })
    expect(await auth.record()).toBeUndefined()
  })

  it('does not put a token in the page it shows the browser', async () => {
    const handle = await auth.begin()
    const page = await browser(handle, ok)
    const text = await page.text()
    for (const field of SECRET_FIELDS) expect(text).not.toContain(field)
    expect(text).not.toContain('the-code')
    await handle.done
  })
})

describe('reading an ID token', () => {
  it('refuses what is not a token, and a signing method it does not accept', () => {
    const expect_ = { issuer: 'https://auth.openai.com', audience: 'a', nonce: 'n', now: Date.now() }
    expect(() => verifyIdToken('nonsense', [], expect_)).toThrow(/could not read/)
    const none = `${b64({ alg: 'none' })}.${b64({})}.x`
    expect(() => verifyIdToken(none, [], expect_)).toThrow(/does not accept/)
  })
})
