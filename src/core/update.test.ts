import { describe, expect, it } from 'vitest'
import { checkForUpdate, compareVersions } from './update'

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('comparing versions', () => {
  it('orders them by number, not by text, and ignores a v and a pre-release tag', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v2.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })
})

describe('looking for an update', () => {
  it('says when a newer version exists and where to get it', async () => {
    const r = await checkForUpdate('1.0.0', answer({ tag_name: 'v1.1.0', html_url: 'https://github.com/AmossDvir1/celeste/releases/tag/v1.1.0' }))
    expect(r).toEqual({ current: '1.0.0', latest: '1.1.0', url: 'https://github.com/AmossDvir1/celeste/releases/tag/v1.1.0', newer: true })
  })

  it('says nothing is newer when this is the newest, or newer than the newest', async () => {
    expect((await checkForUpdate('1.1.0', answer({ tag_name: 'v1.1.0', html_url: 'https://github.com/AmossDvir1/celeste/releases/tag/v1.1.0' }))).newer).toBe(false)
    expect((await checkForUpdate('2.0.0', answer({ tag_name: 'v1.1.0', html_url: 'https://github.com/AmossDvir1/celeste/releases/tag/v1.1.0' }))).newer).toBe(false)
  })

  it('is not an error when no release has been published', async () => {
    expect(await checkForUpdate('1.0.0', answer({}, 404))).toEqual({ current: '1.0.0', newer: false })
  })

  it('only offers a download page that is this project’s, whatever the answer says', async () => {
    const r = await checkForUpdate('1.0.0', answer({ tag_name: 'v9.0.0', html_url: 'https://evil.example/download' }))
    expect(r.url).toBe('https://github.com/AmossDvir1/celeste/releases')
  })

  it('explains in words when it cannot tell', async () => {
    await expect(checkForUpdate('1.0.0', (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).rejects.toThrow('Could not reach GitHub')
    await expect(checkForUpdate('1.0.0', answer({}, 500))).rejects.toThrow('answered 500')
    await expect(checkForUpdate('1.0.0', answer({ no: 'tag' }))).rejects.toThrow('did not say which version')
  })
})
