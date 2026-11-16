import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServerView } from '@shared/api'
import { storeServerSecrets } from './mcp'

const view = (over: Partial<McpServerView>): McpServerView => ({ id: 'mcp-1a2b', name: 'Notes', type: 'stdio', command: 'npx', args: [], envNames: [], headerNames: [], enabled: false, status: { state: 'unchecked' }, ...over })

describe('storing the secrets of a plugin', () => {
  let stored: Record<string, string>
  let removed: string[]
  beforeEach(() => {
    stored = {}
    removed = []
    ;(globalThis as { window?: unknown }).window = { celeste: { secrets: { set: async (n: string, v: string) => void (stored[n] = v), remove: async (n: string) => void removed.push(n) } } }
  })
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('puts each typed value in the secret store under the plugin’s own name for it, and nothing else', async () => {
    await storeServerSecrets(view({ envNames: ['API_KEY'], headerNames: ['Authorization'] }), { env: { API_KEY: 'k1' }, header: { Authorization: 'Bearer t' } })
    expect(stored).toEqual({ 'mcp.mcp-1a2b.env.API_KEY': 'k1', 'mcp.mcp-1a2b.header.Authorization': 'Bearer t' })
  })

  it('keeps what is stored for a name that got no new value', async () => {
    await storeServerSecrets(view({ envNames: ['API_KEY'] }), { env: {}, header: {} })
    expect(stored).toEqual({})
    expect(removed).toEqual([])
  })

  it('forgets the values of variables and headers a changed plugin no longer has', async () => {
    await storeServerSecrets(view({ envNames: ['NEW'] }), { env: { NEW: 'v' }, header: {} }, view({ envNames: ['OLD'], headerNames: ['X-Old'] }))
    expect(removed.sort()).toEqual(['mcp.mcp-1a2b.env.OLD', 'mcp.mcp-1a2b.header.X-Old'])
  })
})
