import { describe, expect, it } from 'vitest'
import type { Bootstrap, CreateSessionInput, SessionPatch, SessionSummary, VendorRecords } from '@shared/api'
import type { ModelInfo, UserInput, VendorId } from '@shared/agent'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { PhoneModels } from '@shared/phone'
import { phoneCalls, titleFromText } from './calls'

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 's', vendor: 'copilot', mode: 'chat', title: 't', model: 'copilot-auto', effort: null, approval: 'auto', status: 'idle', createdAt: 1, updatedAt: 1, lastSeq: 0, ...over
})

function fakeApi(sessions: SessionSummary[]) {
  const created: CreateSessionInput[] = []
  const sent: { id: string; input: UserInput }[] = []
  const api = {
    'app.bootstrap': (): Bootstrap => ({ settings: { ...DEFAULT_SETTINGS, userName: 'Dana', defaults: { ...DEFAULT_SETTINGS.defaults, model: 'claude-sonnet', approval: 'ask' } }, settingsStored: true, vendors: {}, sessions, drafts: {}, dataDir: '/d', version: '1.2.0' }),
    'sessions.create': (input: CreateSessionInput) => {
      created.push(input)
      return summary({ id: 'new', ...input })
    },
    'sessions.send': (id: string, input: UserInput) => void sent.push({ id, input }),
    'sessions.interrupt': (id: string) => void sent.push({ id, input: { text: 'STOP', attachments: [] } })
  }
  return { api, created, sent }
}

describe('phone calls', () => {
  it('hello gives the chat list and the person’s name', async () => {
    const { api } = fakeApi([summary({ id: 'a' })])
    const r = (await phoneCalls(() => api, () => 'DANA-PC')('phone.hello', [])) as { computer: string; userName: string; sessions: SessionSummary[] }
    expect(r.computer).toBe('DANA-PC')
    expect(r.userName).toBe('Dana')
    expect(r.sessions.map((s) => s.id)).toEqual(['a'])
  })

  it('a new chat carries on with the newest chat’s assistant and model, and sends the message', async () => {
    const { api, created, sent } = fakeApi([
      summary({ id: 'old', vendor: 'copilot', model: 'copilot-auto', updatedAt: 1 }),
      summary({ id: 'dev', vendor: 'claude', mode: 'develop', model: 'claude-opus', updatedAt: 9 }),
      summary({ id: 'new-ish', vendor: 'claude', model: 'claude-haiku', approval: 'edits', updatedAt: 5 })
    ])
    await phoneCalls(() => api, () => 'PC')('phone.newChat', ['What is on my calendar today?'])
    expect(created[0]).toMatchObject({ vendor: 'claude', model: 'claude-haiku', mode: 'chat', approval: 'edits', title: 'What is on my calendar today?' })
    expect(sent).toEqual([{ id: 'new', input: { text: 'What is on my calendar today?', attachments: [] } }])
  })

  it('with no chats yet, a new chat uses the defaults', async () => {
    const { api, created } = fakeApi([])
    await phoneCalls(() => api, () => 'PC')('phone.newChat', ['hi'])
    expect(created[0]).toMatchObject({ vendor: 'claude', model: 'claude-sonnet', approval: 'ask' })
  })

  it('a message from the phone is text only: no files from the computer, no project context', async () => {
    const { api, sent } = fakeApi([])
    await phoneCalls(() => api, () => 'PC')('sessions.send', ['s1', { text: 'hello', attachments: [{ id: 'x', name: 'C:/secret.txt' }], context: [{ path: '/etc' }] }])
    expect(sent).toEqual([{ id: 's1', input: { text: 'hello', attachments: [] } }])
    await expect(phoneCalls(() => api, () => 'PC')('sessions.send', ['s1', { text: '  ' }])).rejects.toThrow('Write something first.')
  })

  it('passes the other allowed methods through', async () => {
    const { api, sent } = fakeApi([])
    await phoneCalls(() => api, () => 'PC')('sessions.interrupt', ['s9'])
    expect(sent[0]?.id).toBe('s9')
    await expect(phoneCalls(() => api, () => 'PC')('runs.list', [])).rejects.toThrow('Not available from a phone.')
  })

  it('lists the projects used for Develop, a separate copy counting for its project, newest first', async () => {
    const { api } = fakeApi([
      summary({ id: 'a', mode: 'develop', cwd: 'D:/code/site', updatedAt: 5 }),
      summary({ id: 'b', mode: 'develop', cwd: 'C:/data/worktrees/site-x', worktree: true, updatedAt: 9 }),
      summary({ id: 'c', mode: 'develop', cwd: 'D:/code/api', updatedAt: 7 }),
      summary({ id: 'd', mode: 'develop', cwd: 'D:/code/gone', updatedAt: 8 }),
      summary({ id: 'e', mode: 'chat', updatedAt: 99 })
    ])
    const more = {
      ...api,
      'project.worktrees': async () => [{ path: 'C:/data/worktrees/site-x', name: 'site-x', branch: 'x', repo: 'D:/code/site', changed: 0, ahead: 0 }],
      'project.inspect': async (p: string) => ({ exists: p !== 'D:/code/gone', branch: p.endsWith('site') ? 'main' : null })
    }
    const list = (await phoneCalls(() => more, () => 'PC')('phone.projects', [])) as { path: string; branch: string | null; lastUsed: number }[]
    expect(list.map((p) => [p.path, p.branch, p.lastUsed])).toEqual([
      ['D:/code/site', 'main', 9],
      ['D:/code/api', null, 7]
    ])
  })

  it('starts Develop only in one of those projects, in a separate copy when asked', async () => {
    const { api, created, sent } = fakeApi([summary({ id: 'a', mode: 'develop', cwd: 'D:/code/site', vendor: 'claude', model: 'claude-opus', updatedAt: 5 })])
    const copies: string[] = []
    const more = {
      ...api,
      'project.inspect': async () => ({ exists: true, branch: 'main' }),
      'project.createWorktree': async (repo: string, hint: string) => {
        copies.push(`${repo}|${hint}`)
        return { path: 'C:/data/worktrees/site-fix', branch: 'celeste/fix' }
      }
    }
    const call = phoneCalls(() => more, () => 'PC')
    await call('phone.newChat', ['Fix the footer', { mode: 'develop', project: 'D:/code/site' }])
    expect(created[0]).toMatchObject({ mode: 'develop', cwd: 'D:/code/site', branch: 'main', vendor: 'claude', model: 'claude-opus' })
    await call('phone.newChat', ['Try a new layout', { mode: 'develop', project: 'D:/code/site', copy: true }])
    expect(created[1]).toMatchObject({ mode: 'develop', cwd: 'C:/data/worktrees/site-fix', branch: 'celeste/fix' })
    expect(copies).toEqual(['D:/code/site|Try a new layout'])
    await expect(call('phone.newChat', ['Delete everything', { mode: 'develop', project: 'C:/Windows' }])).rejects.toThrow(/Choose one of your projects/)
    expect(created).toHaveLength(2)
    expect(sent.map((s) => s.input.text)).toEqual(['Fix the footer', 'Try a new layout'])
  })

  describe('models', () => {
    const claudeModels: ModelInfo[] = [
      { id: 'claude:opus', vendor: 'claude', label: 'Opus', efforts: ['low', 'high'], defaultEffort: 'high', images: true },
      { id: 'claude:haiku', vendor: 'claude', label: 'Haiku', efforts: [], images: true }
    ]
    const copilotModels: ModelInfo[] = [{ id: 'auto', vendor: 'copilot', label: 'Auto', efforts: [], images: true }]
    function withModels(sessions: SessionSummary[], vendors: VendorRecords) {
      const f = fakeApi(sessions)
      const asked: string[] = []
      const updates: [string, SessionPatch][] = []
      const api = {
        ...f.api,
        'app.bootstrap': () => ({ ...f.api['app.bootstrap'](), vendors, settings: { ...f.api['app.bootstrap']().settings, pinnedModels: ['claude:haiku'] } }),
        'vendor.models': async (v: VendorId) => {
          asked.push(v)
          return v === 'claude' ? claudeModels : v === 'copilot' ? copilotModels : []
        },
        'sessions.update': (id: string, patch: SessionPatch) => {
          updates.push([id, patch])
          return summary({ id, ...patch })
        }
      }
      return { ...f, api, asked, updates }
    }

    it('lists only the connected assistants’ models, and the pinned ones', async () => {
      const { api, asked } = withModels([], { claude: { account: 'API key', method: 'key' } })
      const r = (await phoneCalls(() => api, () => 'PC')('phone.models', [])) as PhoneModels
      expect(r.models.map((m) => m.id)).toEqual(['claude:opus', 'claude:haiku'])
      expect(r.pinned).toEqual(['claude:haiku'])
      expect(asked).toEqual(['claude'])
    })

    it('a new chat uses the model the phone picked, with an effort that model takes', async () => {
      const { api, created } = withModels([summary({ id: 'a', vendor: 'copilot', model: 'auto' })], { claude: { account: 'k', method: 'key' }, copilot: { account: 'me', method: 'browser' } })
      const call = phoneCalls(() => api, () => 'PC')
      await call('phone.newChat', ['hi', { mode: 'chat', model: 'claude:opus', effort: 'low' }])
      expect(created[0]).toMatchObject({ vendor: 'claude', model: 'claude:opus', effort: 'low' })
      await call('phone.newChat', ['hi', { mode: 'chat', model: 'claude:opus', effort: 'max' }])
      expect(created[1]).toMatchObject({ effort: 'high' })
      await call('phone.newChat', ['hi', { mode: 'chat', model: 'claude:haiku', effort: 'high' }])
      expect(created[2]).toMatchObject({ effort: null })
    })

    it('refuses a model that is not offered, before making anything', async () => {
      const { api, created, sent } = withModels([], { claude: { account: 'k', method: 'key' } })
      await expect(phoneCalls(() => api, () => 'PC')('phone.newChat', ['hi', { mode: 'chat', model: 'auto' }])).rejects.toThrow(/not available/)
      expect(created).toHaveLength(0)
      expect(sent).toHaveLength(0)
    })

    it('changes a chat’s model within its own assistant only', async () => {
      const { api, updates } = withModels([summary({ id: 'c1', vendor: 'claude', model: 'claude:haiku' })], { claude: { account: 'k', method: 'key' }, copilot: { account: 'me', method: 'browser' } })
      const call = phoneCalls(() => api, () => 'PC')
      await call('phone.setModel', ['c1', { model: 'claude:opus' }])
      expect(updates).toEqual([['c1', { model: 'claude:opus', effort: 'high' }]])
      await expect(call('phone.setModel', ['c1', { model: 'auto' }])).rejects.toThrow(/cannot use that model/)
      await expect(call('phone.setModel', ['gone', { model: 'claude:opus' }])).rejects.toThrow(/no longer on the computer/)
      expect(updates).toHaveLength(1)
    })
  })

  it('makes short titles', () => {
    expect(titleFromText('  hello   there ')).toBe('hello there')
    expect(titleFromText('')).toBe('New chat')
    expect(titleFromText('x'.repeat(80))).toHaveLength(60)
  })
})
