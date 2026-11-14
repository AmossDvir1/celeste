import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/*
 * A stand-in for OpenAI's sign-in service (auth.openai.com), for testing "Continue with ChatGPT" with no account: it publishes
 * its signing keys, takes the code exchange and the refresh, signs real ID tokens, and takes the revocation. The test plays the
 * browser: it reads what the authorize address asked for into `authorized`, then calls the redirect address with the answer.
 * Plain Node-strippable TypeScript: no parameter properties.
 */

/** The client OpenAI "issues" to the app on its first sign-in. */
export const FAKE_CLIENT = 'oaiapp_test_client'

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')

export class FakeChatgptAuth {
  server!: Server
  url = ''
  private privateKey: KeyObject
  private publicJwk: Record<string, unknown>
  /** What the authorize request asked for, read by the token endpoint to build the ID token. */
  authorized: { nonce: string; redirect: string; state: string; query: URLSearchParams } | undefined
  /** The forms posted to the token endpoint, in order. */
  posts: URLSearchParams[] = []
  revoked: URLSearchParams[] = []
  scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
  email = 'dana@example.com'
  /** Changes the ID token's claims, to see them refused. */
  tamper: (claims: Record<string, unknown>) => void = () => undefined
  badSignature = false
  refreshStatus = 200
  revocationStatus = 200
  private issued = 0

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.privateKey = privateKey
    this.publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Says what the authorize address asked for, as the browser would have it, and returns the address OpenAI sends the browser back to. */
  visit(authorizeUrl: string, over: { code?: string; error?: string } = {}): string {
    const q = new URL(authorizeUrl).searchParams
    this.authorized = { nonce: q.get('nonce') ?? '', redirect: q.get('redirect_uri') ?? '', state: q.get('state') ?? '', query: q }
    const params = new URLSearchParams({ state: this.authorized.state, ...(over.error ? { error: over.error } : { code: over.code ?? 'the-code', client_id: FAKE_CLIENT }) })
    return `${this.authorized.redirect}?${params.toString()}`
  }

  idToken(over: Record<string, unknown> = {}): string {
    const claims: Record<string, unknown> = { iss: this.url, aud: FAKE_CLIENT, sub: 'user-123', email: this.email, exp: Math.floor(Date.now() / 1000) + 3600, nonce: this.authorized?.nonce, ...over }
    this.tamper(claims)
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })
    const body = b64(claims)
    const sign = createSign('RSA-SHA256')
    sign.update(`${head}.${body}`)
    const signature = sign.sign(this.privateKey).toString('base64url')
    // The first character holds six real bits. (The last holds padding bits, so changing it can leave the signature as it was.)
    return `${head}.${body}.${this.badSignature ? signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) : signature}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    const path = (req.url ?? '').split('?')[0]
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (path === '/.well-known/openid-configuration') return json(200, { issuer: this.url, jwks_uri: `${this.url}/jwks`, revocation_endpoint: `${this.url}/revoke` })
    if (path === '/jwks') return json(200, { keys: [this.publicJwk] })
    if (path === '/revoke') {
      this.revoked.push(form)
      return json(this.revocationStatus, {})
    }
    if (path === '/api/accounts/oauth/token') {
      this.posts.push(form)
      if (form.get('grant_type') === 'refresh_token') {
        if (this.refreshStatus !== 200) return json(this.refreshStatus, { error: 'invalid_grant' })
        this.issued++
        return json(200, { access_token: `access-refreshed-${this.issued}`, refresh_token: `refresh-${this.issued}`, expires_in: 3600, scope: this.scope })
      }
      return json(200, { access_token: 'access-1', refresh_token: 'refresh-0', id_token: this.idToken(), token_type: 'Bearer', expires_in: 3600, scope: this.scope })
    }
    res.writeHead(404).end()
  }
}
