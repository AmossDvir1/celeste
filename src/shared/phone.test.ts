import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { LABEL, commitment, fromB64, makeKeyPair, open, pairingEmoji, randomB64, seal, sessionKey, setX25519Fallback, toB64, type X25519Fallback } from './phone'

// A stand-in for the phone app's pure-JS X25519, made from Node's own, working on raw bytes as @noble/curves does.
const DER_PRIV = Buffer.from('302e020100300506032b656e04220420', 'hex')
const DER_PUB = Buffer.from('302a300506032b656e032100', 'hex')
const nodeX25519: X25519Fallback = {
  keyPair: () => {
    const { privateKey, publicKey } = generateKeyPairSync('x25519')
    return { priv: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16)), pub: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)) }
  },
  shared: (priv, pub) =>
    new Uint8Array(
      diffieHellman({
        privateKey: createPrivateKey({ key: Buffer.concat([DER_PRIV, priv]), format: 'der', type: 'pkcs8' }),
        publicKey: createPublicKey({ key: Buffer.concat([DER_PUB, pub]), format: 'der', type: 'spki' })
      })
    )
}

afterEach(() => setX25519Fallback(null, false))

describe('phone protocol', () => {
  it('seals and opens, and refuses another label or a changed box', async () => {
    const a = await makeKeyPair()
    const b = await makeKeyPair()
    const ka = await sessionKey(a.priv, b.pub, a.pub, b.pub)
    const kb = await sessionKey(b.priv, a.pub, a.pub, b.pub)
    const box = await seal(ka, { hi: 'there' }, LABEL.push)
    expect(await open(kb, box, LABEL.push)).toEqual({ hi: 'there' })
    await expect(open(kb, box, LABEL.request)).rejects.toThrow()
    const bytes = fromB64(box)
    bytes[20] = (bytes[20] as number) ^ 1
    await expect(open(kb, toB64(bytes), LABEL.push)).rejects.toThrow()
  })

  it('a phone using the fallback X25519 talks to a computer using WebCrypto', async () => {
    const computer = await makeKeyPair()
    setX25519Fallback(nodeX25519, true)
    const phone = await makeKeyPair()
    expect(phone.priv['kty']).toBe('OKP')
    const onPhone = await sessionKey(phone.priv, computer.pub, computer.pub, phone.pub)
    setX25519Fallback(null, false)
    const onComputer = await sessionKey(computer.priv, phone.pub, computer.pub, phone.pub)
    expect(await open(onComputer, await seal(onPhone, { n: 1 }, LABEL.request), LABEL.request)).toEqual({ n: 1 })
    // And the fallback's stored key still works once the WebView has X25519 itself.
    const later = await sessionKey(phone.priv, computer.pub, computer.pub, phone.pub)
    expect(await open(onComputer, await seal(later, { n: 2 }, LABEL.request), LABEL.request)).toEqual({ n: 2 })
  })

  it('without X25519 and without a fallback, it says what to update', async () => {
    setX25519Fallback(null, true)
    await expect(makeKeyPair()).rejects.toThrow(/Android System WebView/)
  })

  it('the pictures depend on every part, so a key or nonce swapped in the middle shows', async () => {
    const c = await makeKeyPair()
    const p = await makeKeyPair()
    const pn = randomB64(16)
    const cn = randomB64(16)
    const base = await pairingEmoji(c.pub, p.pub, pn, cn)
    expect(base).toHaveLength(3)
    const other = await makeKeyPair()
    const changed = await Promise.all([pairingEmoji(other.pub, p.pub, pn, cn), pairingEmoji(c.pub, other.pub, pn, cn), pairingEmoji(c.pub, p.pub, randomB64(16), cn)])
    expect(changed.filter((e) => e.join() === base.join()).length).toBeLessThan(2)
    expect(await commitment(p.pub, pn)).not.toBe(await commitment(other.pub, pn))
  })
})
