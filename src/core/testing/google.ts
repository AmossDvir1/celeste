// A stand-in for the two Google servers the relay talks to to wake a phone: the one that trades a signed request for an
// access token, and Firebase Cloud Messaging's send (and, on the same port, one for Cloudflare's TURN credentials). It checks the signature and the token the way Google does, and keeps
// what it was asked to send, so tests can see exactly what Google would have been given.

import { createServer, type Server } from 'node:http'
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import type { FcmEnv } from '../../../relay/src/fcm'
import type { TurnEnv } from '../../../relay/src/turn'

export interface SentMessage {
  token: string
  data: Record<string, string>
  priority: string
  ttl: string
}

export interface StandInGoogle {
  /** What the relay needs: the service account (as the secret) and where Google is. */
  env: Required<Pick<FcmEnv, 'FIREBASE_SERVICE_ACCOUNT' | 'FCM_ENDPOINT' | 'TOKEN_ENDPOINT'>> & Required<TurnEnv>
  sent: SentMessage[]
  /** The lifetimes asked of the stand-in for Cloudflare's TURN credentials (it lives here too, on the same port). */
  turnAsked: number[]
  /** Tokens Google answers "no longer registered" for (the app was removed from the phone). */
  unregistered: Set<string>
  /** How many access tokens were handed out. */
  tokens(): number
  /** Makes the next send answer 401, as an expired access token does. */
  expireToken(): void
  stop(): Promise<void>
}

/**
 * `privatePem` and `port` are for `npm run verify:relay`, which starts the real Worker first and has to tell it where Google is
 * and which key to trust before the tests (which then stand in for Google on that port) begin.
 */
export async function startGoogle(opts: { privatePem?: string; port?: number } = {}): Promise<StandInGoogle> {
  const privateKey = opts.privatePem ? createPrivateKey(opts.privatePem) : generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const publicKey = createPublicKey(privateKey)
  const email = 'relay@test-proj.iam.gserviceaccount.com'
  const sent: SentMessage[] = []
  const unregistered = new Set<string>()
  const turnAsked: number[] = []
  let issued = 0
  let current = ''
  const b64 = (s: string) => Buffer.from(s, 'base64url')

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (req.url === '/token') {
        const assertion = new URLSearchParams(body).get('assertion') ?? ''
        const [head, claim, sig] = assertion.split('.')
        const ok = !!sig && verify('sha256', Buffer.from(`${head}.${claim}`), publicKey, b64(sig))
        const c = ok ? (JSON.parse(b64(claim as string).toString()) as { iss?: string; scope?: string }) : null
        if (!c || c.iss !== email || c.scope !== 'https://www.googleapis.com/auth/firebase.messaging') return reply(400, { error: 'invalid_grant' })
        current = `access-${++issued}`
        return reply(200, { access_token: current, expires_in: 3600 })
      }
      if (req.url === '/v1/projects/test-proj/messages:send') {
        if (req.headers.authorization !== `Bearer ${current}`) return reply(401, { error: { status: 'UNAUTHENTICATED' } })
        const m = (JSON.parse(body) as { message: { token: string; data: Record<string, string>; android: { priority: string; ttl: string } } }).message
        if (unregistered.has(m.token)) return reply(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })
        sent.push({ token: m.token, data: m.data, priority: m.android.priority, ttl: m.android.ttl })
        return reply(200, { name: `projects/test-proj/messages/${sent.length}` })
      }
      // Cloudflare's TURN credentials: the key id and token are fixed here, and what is handed out is made up.
      if (req.url === '/v1/turn/keys/turn-key-1/credentials/generate-ice-servers') {
        if (req.headers.authorization !== 'Bearer turn-secret') return reply(401, {})
        turnAsked.push((JSON.parse(body) as { ttl: number }).ttl)
        return reply(201, {
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:443?transport=tcp'], username: `user-${turnAsked.length}`, credential: 'made-up' }
          ]
        })
      }
      reply(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    env: {
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: email, project_id: 'test-proj', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
      FCM_ENDPOINT: base,
      TOKEN_ENDPOINT: `${base}/token`,
      TURN_KEY_ID: 'turn-key-1',
      TURN_KEY_API_TOKEN: 'turn-secret',
      TURN_ENDPOINT: base
    },
    sent,
    turnAsked,
    unregistered,
    tokens: () => issued,
    expireToken: () => void (current = 'expired'),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
