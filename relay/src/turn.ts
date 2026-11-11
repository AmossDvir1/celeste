// Hands the computer short-lived addresses for the direct link (docs/PHONE_PLAN.md 7.1, A4c): Cloudflare's STUN, which
// tells each side its own public address, and, when the project has made a TURN key, Cloudflare's TURN, which carries the
// link's bytes when the two cannot reach each other straight. What passes through TURN is already sealed end to end.

export interface TurnEnv {
  /** From Cloudflare, Realtime → TURN → Create. Without both, only STUN is given and the link falls back to the relay. */
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
  /** For tests: where Cloudflare's credentials API is (a stand-in). */
  TURN_ENDPOINT?: string
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export const STUN_ONLY: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }]

/** How long a credential lives, in seconds: long enough for one session of watching or sending files. */
export const TURN_TTL = 6 * 3600

const SERVER = (s: unknown): s is IceServer => {
  const x = s as Partial<IceServer> | null
  return !!x && Array.isArray(x.urls) && x.urls.length > 0 && x.urls.every((u) => typeof u === 'string' && /^(stun|turns?):/.test(u)) && (x.username === undefined || typeof x.username === 'string') && (x.credential === undefined || typeof x.credential === 'string')
}

/** The ICE servers the computer and the phone should use. Never throws: STUN alone when TURN is not set up or does not answer. */
export async function iceServers(env: TurnEnv): Promise<{ servers: IceServer[]; turn: boolean }> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { servers: STUN_ONLY, turn: false }
  try {
    const base = env.TURN_ENDPOINT ?? 'https://rtc.live.cloudflare.com'
    const res = await fetch(`${base}/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL })
    })
    if (!res.ok) return { servers: STUN_ONLY, turn: false }
    const body = (await res.json()) as { iceServers?: unknown }
    const servers = Array.isArray(body.iceServers) ? body.iceServers.filter(SERVER) : []
    return servers.length ? { servers, turn: servers.some((s) => s.username !== undefined) } : { servers: STUN_ONLY, turn: false }
  } catch {
    return { servers: STUN_ONLY, turn: false }
  }
}
