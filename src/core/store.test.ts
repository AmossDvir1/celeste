import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './testing/memory-store'
import { SqliteStore } from './sqlite-store'
import type { AttachmentRow, SessionRow, Store } from './store'

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 's1',
  vendor: 'copilot',
  mode: 'chat',
  title: 'Analyze WFO logs',
  model: 'copilot-auto',
  effort: null,
  approval: 'auto',
  status: 'idle',
  createdAt: 1000,
  updatedAt: 1000,
  lastSeq: 0,
  deletedAt: null,
  ...over
})

const file = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'a1',
  sessionId: null,
  name: 'shot.png',
  mime: 'image/png',
  bytes: 10,
  file: 'a1.png',
  createdAt: 1,
  ...over
})

const dirs: string[] = []
const opened: Store[] = []
afterEach(() => {
  // Windows will not delete a database file that is still open.
  while (opened.length) opened.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const track = (s: Store): Store => {
  opened.push(s)
  return s
}

const factories: [string, () => Store][] = [
  ['MemoryStore', () => track(new MemoryStore())],
  ['SqliteStore', () => track(new SqliteStore(':memory:'))],
  [
    'SqliteStore on disk',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'celeste-store-'))
      dirs.push(dir)
      return track(new SqliteStore(join(dir, 'test.db')))
    }
  ]
]

describe.each(factories)('%s', (_name, make) => {
  it('keeps sessions, newest first, and hides deleted ones', () => {
    const s = make()
    s.insertSession(session({ id: 'old', updatedAt: 1 }))
    s.insertSession(session({ id: 'new', updatedAt: 5, cwd: 'D:\\Work', branch: 'main', effort: 'high', mode: 'develop' }))
    expect(s.listSessions().map((x) => x.id)).toEqual(['new', 'old'])
    expect(s.getSession('new')).toMatchObject({ cwd: 'D:\\Work', branch: 'main', effort: 'high', mode: 'develop', deletedAt: null })
    expect(s.getSession('old')).not.toHaveProperty('cwd')

    s.patchSession('old', { deletedAt: 9, title: 'Renamed', status: 'working' })
    expect(s.listSessions().map((x) => x.id)).toEqual(['new'])
    expect(s.getSession('old')).toMatchObject({ title: 'Renamed', status: 'working', deletedAt: 9 })
    expect(s.listDeleted()).toEqual([{ id: 'old', deletedAt: 9 }])

    s.patchSession('old', { deletedAt: null })
    expect(s.listSessions()).toHaveLength(2)
    s.patchSession('new', { effort: null })
    expect(s.getSession('new')?.effort).toBeNull()
    expect(s.patchSession('missing', { title: 'x' })).toBeUndefined()
  })

  it('appends events with increasing numbers and returns them in order', () => {
    const s = make()
    s.insertSession(session())
    const a = s.appendEvent('s1', 10, { type: 'turn.started', turnId: 't1' })
    const b = s.appendEvent('s1', 20, { type: 'user.message', text: 'héllo “quoted”', attachments: [] })
    const c = s.appendEvent('s1', 30, { type: 'tool.completed', id: 't', ok: true })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(s.getSession('s1')).toMatchObject({ lastSeq: 3, updatedAt: 30 })

    const all = s.events('s1')
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(all[1]).toEqual({ seq: 2, at: 20, event: { type: 'user.message', text: 'héllo “quoted”', attachments: [] } })
    expect(s.events('s1', 2).map((e) => e.seq)).toEqual([3])
    expect(s.events('nobody')).toEqual([])
    expect(() => s.appendEvent('nobody', 1, { type: 'turn.completed', turnId: 'x' })).toThrow()
  })

  it('does not share objects with callers', () => {
    const s = make()
    s.insertSession(session())
    const event = { type: 'user.message' as const, text: 'one', attachments: [] }
    s.appendEvent('s1', 1, event)
    event.text = 'changed'
    const read = s.events('s1')
    ;(read[0].event as { text: string }).text = 'tampered'
    expect((s.events('s1')[0].event as { text: string }).text).toBe('one')
  })

  it('finds sessions by words in the title or the conversation, by prefix', () => {
    const s = make()
    s.insertSession(session({ id: 'a', title: 'Analyze WFO logs' }))
    s.insertSession(session({ id: 'b', title: 'Plan KB update', mode: 'develop' }))
    s.index('a', 'title', 'Analyze WFO logs')
    s.index('b', 'title', 'Plan KB update')
    s.index('b', 'user', 'Rollout of the November updates across the servers')
    s.index('b', 'assistant', 'Start with a canary of two hosts, then wave one.')

    expect(s.search('wfo', 5).map((h) => h.sessionId)).toEqual(['a'])
    expect(s.search('ANALY', 5)[0]).toMatchObject({ sessionId: 'a', title: 'Analyze WFO logs', mode: 'chat' })
    expect(s.search('analyze', 5)[0].snippet).toBeUndefined()

    const hit = s.search('canary hosts', 5)
    expect(hit.map((h) => h.sessionId)).toEqual(['b'])
    expect(hit[0].snippet).toContain('canary')
    expect(s.search('rollout nov', 5).map((h) => h.sessionId)).toEqual(['b'])

    expect(s.search('', 5)).toEqual([])
    expect(s.search('"*(', 5)).toEqual([])
    expect(s.search('zzzz', 5)).toEqual([])

    // A new title replaces the old one in the index.
    s.index('a', 'title', 'Weekly report')
    expect(s.search('wfo', 5)).toEqual([])
    expect(s.search('weekly', 5)[0].sessionId).toBe('a')

    // One result per session, even when several entries match.
    s.index('b', 'assistant', 'More about the plan and the canary')
    expect(s.search('plan', 5).filter((h) => h.sessionId === 'b')).toHaveLength(1)

    s.patchSession('b', { deletedAt: 5 })
    expect(s.search('canary', 5)).toEqual([])
  })

  it('purges a session with its log, search entries, draft and attachment rows', () => {
    const s = make()
    s.insertSession(session())
    s.appendEvent('s1', 1, { type: 'turn.started', turnId: 't' })
    s.index('s1', 'user', 'findable words')
    s.setDraft('s1', { text: 'half-written', attachments: [] })
    s.insertAttachment(file({ sessionId: 's1' }))

    const gone = s.purgeSession('s1')
    expect(gone.map((a) => a.file)).toEqual(['a1.png'])
    expect(s.getSession('s1')).toBeUndefined()
    expect(s.events('s1')).toEqual([])
    expect(s.search('findable', 5)).toEqual([])
    expect(s.drafts()).toEqual({})
    expect(s.attachment('a1')).toBeUndefined()
  })

  it('keeps settings and drafts', () => {
    const s = make()
    expect(s.settings()).toEqual({})
    s.setSetting('theme', 'light')
    s.setSetting('defaults', { model: 'x', approval: 'ask' })
    s.setSetting('theme', 'dark')
    expect(s.settings()).toEqual({ theme: 'dark', defaults: { model: 'x', approval: 'ask' } })

    s.setDraft('home:chat', { text: 'draft', attachments: [{ id: 'a', name: 'f', mime: 'text/plain', size: 1 }] })
    s.setDraft('s9', { text: 'other', attachments: [] })
    expect(s.drafts()['home:chat'].attachments[0].id).toBe('a')
    s.setDraft('s9', null)
    expect(Object.keys(s.drafts())).toEqual(['home:chat'])
  })

  it('keeps devices, what each session has attached, their folders and activity', () => {
    const s = make()
    s.insertSession(session({ id: 'one' }))
    s.insertDevice({ id: 'd1', name: 'build-vm', kind: 'ssh', host: '10.0.0.5', port: 22, username: 'dev', authMethod: 'key', keyPath: 'C:\keys\id', os: 'unknown', shell: 'posix', accessLevel: 'read', hostKeySha256: null, createdAt: 1, lastSeenAt: null })
    s.insertDevice({ id: 'd2', name: 'pixel', kind: 'adb', host: '192.168.1.9', port: 5555, username: 'shell', authMethod: 'none', os: 'android', shell: 'adb', accessLevel: 'ask', hostKeySha256: null, createdAt: 2, lastSeenAt: null })
    expect(s.listDevices().map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(s.getDevice('d1')).toMatchObject({ keyPath: 'C:\keys\id', hostKeySha256: null, lastSeenAt: null })
    expect(s.getDevice('d2')).not.toHaveProperty('keyPath')

    s.patchDevice('d1', { os: 'linux', accessLevel: 'ask', hostKeySha256: 'abc', lastSeenAt: 9 })
    expect(s.getDevice('d1')).toMatchObject({ os: 'linux', accessLevel: 'ask', hostKeySha256: 'abc', lastSeenAt: 9 })
    expect(s.patchDevice('nope', { name: 'x' })).toBeUndefined()

    s.setAttached('one', 'd1', true)
    s.setAttached('one', 'd1', true)
    s.setAttached('one', 'd2', true)
    s.setAttached('one', 'd2', false)
    expect(s.attachedDevices('one')).toEqual(['d1'])

    s.insertFolder({ id: 'f1', deviceId: 'd1', path: '/srv/app', mode: 'snapshot', snapshotPath: 'C:\cache\f1', snapshotAt: null, bytes: 0, files: 0, createdAt: 1 })
    s.patchFolder('f1', { snapshotAt: 5, bytes: 100, files: 3 })
    expect(s.listFolders()).toEqual([{ id: 'f1', deviceId: 'd1', path: '/srv/app', mode: 'snapshot', snapshotAt: 5, bytes: 100, files: 3, createdAt: 1 }])
    expect(s.getFolder('f1')?.snapshotPath).toBe('C:\cache\f1')

    s.addActivity({ deviceId: 'd1', sessionId: 'one', tool: 'device_run', summary: 'df -h', ok: true, bytes: 42, at: 10 })
    s.addActivity({ deviceId: 'd1', sessionId: null, tool: 'test', summary: 'connected', ok: false, bytes: 0, at: 20 })
    expect(s.activity('d1', 10).map((a) => a.summary)).toEqual(['connected', 'df -h'])
    expect(s.activity('d1', 1)).toHaveLength(1)

    // A session that goes takes its attachments with it; a device that goes takes its folders and activity.
    s.purgeSession('one')
    expect(s.attachedDevices('one')).toEqual([])
    expect(s.deleteDevice('d1').map((f) => f.id)).toEqual(['f1'])
    expect(s.getDevice('d1')).toBeUndefined()
    expect(s.listFolders()).toEqual([])
    expect(s.activity('d1', 10)).toEqual([])
    expect(s.listDevices().map((d) => d.id)).toEqual(['d2'])
  })

  it('links attachments to a session once and tells which are still loose', () => {
    const s = make()
    s.insertSession(session({ id: 'one' }))
    s.insertSession(session({ id: 'two' }))
    s.insertAttachment(file({ id: 'a', file: 'a.png' }))
    s.insertAttachment(file({ id: 'b', file: 'b.png', width: 640, height: 360 }))
    expect(s.unlinkedAttachments().map((a) => a.id).sort()).toEqual(['a', 'b'])
    expect(s.attachment('b')).toMatchObject({ width: 640, height: 360 })

    s.linkAttachments(['a', 'nothing'], 'one')
    s.linkAttachments(['a'], 'two') // already taken: stays with the first session
    expect(s.attachment('a')?.sessionId).toBe('one')
    expect(s.unlinkedAttachments().map((a) => a.id)).toEqual(['b'])

    expect(s.deleteAttachment('b')?.file).toBe('b.png')
    expect(s.deleteAttachment('b')).toBeUndefined()
  })
})
