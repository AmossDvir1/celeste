import { afterEach, describe, expect, it } from 'vitest'
import { startBroker, type StandInBroker } from '../core/testing/mqtt'
import { SignalChannel, signalTopic } from './signal'

const stops: (() => unknown)[] = []
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s()
})
const wait = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('public signalling', () => {
  it('works out the same topic from the same key, and a different one from another', async () => {
    const a = await signalTopic(new Uint8Array(32).fill(1))
    expect(a).toMatch(/^celeste\/[0-9a-f]{32}$/)
    expect(await signalTopic(new Uint8Array(32).fill(1))).toBe(a)
    expect(await signalTopic(new Uint8Array(32).fill(2))).not.toBe(a)
  })

  it('carries a message between two ends on several brokers, hears it once, and survives a broker being down', async () => {
    const one: StandInBroker = await startBroker()
    const two: StandInBroker = await startBroker()
    stops.push(() => one.stop(), () => two.stop())
    const topic = await signalTopic(new Uint8Array(32).fill(7))
    // The third broker does not exist: that must cost nothing.
    const brokers = [one.url, two.url, 'ws://127.0.0.1:9/mqtt']
    const heardA: string[] = []
    const heardB: string[] = []
    const a = new SignalChannel(brokers, topic, (t) => heardA.push(t))
    const b = new SignalChannel(brokers, topic, (t) => heardB.push(t))
    a.start()
    b.start()
    stops.push(() => a.stop(), () => b.stop())
    await wait(() => a.connected === 2 && b.connected === 2)
    a.send('hello from a ✓')
    await wait(() => heardB.includes('hello from a ✓'))
    await new Promise((r) => setTimeout(r, 200))
    expect(heardB.filter((t) => t === 'hello from a ✓')).toHaveLength(1)
    // A large one, split across WebSocket frames.
    const big = 'x'.repeat(40_000)
    b.send(big)
    await wait(() => heardA.includes(big))

    // A broker restarting: the line comes back by itself.
    one.dropAll()
    await wait(() => a.connected < 2)
    await wait(() => a.connected === 2 && b.connected === 2, 8000)
    a.send('after the restart')
    await wait(() => heardB.includes('after the restart'))
  })

  it('does not hear another topic', async () => {
    const broker = await startBroker()
    stops.push(() => broker.stop())
    const heard: string[] = []
    const a = new SignalChannel([broker.url], 'celeste/aaaa', (t) => heard.push(t))
    const b = new SignalChannel([broker.url], 'celeste/bbbb', () => undefined)
    a.start()
    b.start()
    stops.push(() => a.stop(), () => b.stop())
    await wait(() => a.connected === 1 && b.connected === 1)
    b.send('for somebody else')
    await new Promise((r) => setTimeout(r, 300))
    expect(heard).toEqual([])
  })
})
