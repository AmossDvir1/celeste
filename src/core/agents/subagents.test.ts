import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import { MAX_RUNNING_PER_PARENT, MAX_STARTS_PER_MESSAGE, NOTE_BATCH_MS, WAIT_CAP_MS } from '@shared/subagents'
import type { FakeAgent } from '../testing/fake-agent'
import { MemoryStore } from '../testing/memory-store'
import { FakeSnapshots, flush, settle, world } from '../testing/subagents-world'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('starting a helper', () => {
  it('makes a session of its own under the parent, with its task as the first message from the parent', async () => {
    const w = world()
    const parent = w.make({ title: 'Plan the launch' })
    const r = await w.start(parent.id, { task: 'Read the logs', title: 'Log reader' })
    const id = w.idOf(r.text)
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Started the helper “Log reader”')

    const child = w.api['sessions.get'](id)
    expect(child?.summary).toMatchObject({ parentId: parent.id, title: 'Log reader', vendor: 'claude', model: 'claude:sonnet', mode: 'chat' })
    expect(child?.summary).not.toHaveProperty('spawn')
    // Its log begins with whose helper it is, and its first message says who wrote it.
    const events = w.eventsOf(id)
    expect(events[0]).toEqual({ type: 'child.spawned', parentId: parent.id, parentTitle: 'Plan the launch' })
    expect(events[1]).toMatchObject({ type: 'user.message', text: 'Read the logs', from: 'parent' })
    // What the helper is told has Celeste's line at the end; the log does not.
    const told = (w.agents.get(id)?.sent[0] as { text: string }).text
    expect(told.startsWith('Read the logs')).toBe(true)
    expect(told).toContain('you are a helper started by another assistant in "Plan the launch"')
    expect(JSON.stringify(events)).not.toContain('you are a helper')
    // The parent's log has the card's first event.
    expect(w.startedEvents(parent.id)).toEqual([{ type: 'child.started', childId: id, title: 'Log reader', vendor: 'claude', model: 'claude:sonnet', task: 'Read the logs', folder: 'same', wait: false }])
    // It shows up in the summaries the window gets, with the parent.
    expect(w.pushes.some((p) => p.type === 'summary' && p.session.id === id && p.session.parentId === parent.id)).toBe(true)
  })

  it('starts with the devices attached to its parent', async () => {
    const w = world()
    const parent = w.make()
    w.store.setAttached(parent.id, 'dev-1', true)
    const id = w.idOf((await w.start(parent.id)).text)
    expect(w.store.attachedDevices(id)).toEqual(['dev-1'])
  })

  it('refuses an assistant that is not connected, and says what can be used (case 1, 35)', async () => {
    const w = world()
    const parent = w.make()
    const r = await w.start(parent.id, { vendor: 'gemini' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Gemini is not connected. You can use: claude (Claude): claude:sonnet, claude:haiku; openai (OpenAI): openai:gpt.')
    expect(w.store.listChildren(parent.id)).toEqual([])
  })

  it('refuses a model the vendor does not have, and drops an effort the model does not offer (case 2)', async () => {
    const w = world()
    const parent = w.make()
    const bad = await w.start(parent.id, { model: 'claude:nope' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('claude:nope is not a model of Claude. You can use: claude:sonnet, claude:haiku.')
    const dropped = await w.start(parent.id, { model: 'claude:haiku', effort: 'high', approval: 'plan' })
    expect(dropped.isError).toBe(false)
    expect(w.api['sessions.get'](w.idOf(dropped.text))?.summary.effort).toBeNull()
    const kept = await w.start(parent.id, { model: 'claude:sonnet', effort: 'high', approval: 'plan' })
    expect(w.api['sessions.get'](w.idOf(kept.text))?.summary.effort).toBe('high')
  })

  it('takes the person’s default model for another vendor, and the parent’s model for its own', async () => {
    const w = world()
    const parent = w.make()
    const other = await w.start(parent.id, { vendor: 'openai' })
    expect(w.api['sessions.get'](w.idOf(other.text))?.summary).toMatchObject({ vendor: 'openai', model: 'openai:gpt' })
    const same = await w.start(parent.id, { approval: 'plan' })
    expect(w.api['sessions.get'](w.idOf(same.text))?.summary).toMatchObject({ vendor: 'claude', model: 'claude:sonnet' })
  })

  it('never gives a helper a looser mode than its chat (case 3)', async () => {
    const w = world()
    const parent = w.make({ approval: 'ask' })
    const r = await w.start(parent.id, { approval: 'edits' })
    expect(r).toEqual({ text: 'A helper cannot have a looser approval mode than this chat (ask).', isError: true })
    const edits = w.make({ approval: 'edits' })
    expect((await w.start(edits.id, { approval: 'ask' })).isError).toBe(false)
  })

  it('gives a chat that only plans helpers that only plan, whatever was asked (case 4)', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    const id = w.idOf((await w.start(parent.id, { approval: 'ask' })).text)
    expect(w.api['sessions.get'](id)?.summary.approval).toBe('plan')
    const sameAsked = w.idOf((await w.start(parent.id)).text)
    expect(w.api['sessions.get'](sameAsked)?.summary.approval).toBe('plan')
  })

  it('asks first in ask mode, and starts nothing when the person says no (case 5)', async () => {
    const w = world()
    const parent = w.make({ approval: 'ask' })
    const pending = w.start(parent.id, { title: 'Reviewer', task: 'Review the change' })
    await flush()
    const card = w.eventsOf(parent.id).find((e) => e.type === 'approval.requested')
    expect(card).toMatchObject({ type: 'approval.requested', kind: 'agent', title: 'Start a helper?' })
    expect((card as { detail: string }).detail).toContain('Reviewer')
    expect((card as { detail: string }).detail).toContain('Review the change')
    expect(w.store.listChildren(parent.id)).toEqual([])
    w.api['sessions.respondApproval'](parent.id, (card as { requestId: string }).requestId, { allow: false, always: false })
    expect(await pending).toEqual({ text: 'The person said no to starting this helper. Do not try again unless they ask.', isError: true })
    expect(w.store.listChildren(parent.id)).toEqual([])

    const second = w.start(parent.id)
    await flush()
    const again = w.eventsOf(parent.id).filter((e) => e.type === 'approval.requested')[1] as { requestId: string }
    w.api['sessions.respondApproval'](parent.id, again.requestId, { allow: true, always: false })
    expect((await second).isError).toBe(false)
    expect(w.store.listChildren(parent.id)).toHaveLength(1)
  })

  it('does nothing for a call that began before the person pressed Stop (the card was left open)', async () => {
    const w = world()
    const parent = w.make({ approval: 'ask' })
    await w.parentBegins(parent.id)
    const pending = w.start(parent.id)
    await flush()
    w.api['sessions.interrupt'](parent.id)
    expect((await pending).isError).toBe(true)
    expect(w.store.listChildren(parent.id)).toEqual([])
  })

  it('keeps a chat helper in its parent’s private folder (section 9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'celeste-subs-'))
    try {
      const w = world({ dataDir: dir })
      const parent = w.make()
      const id = w.idOf((await w.start(parent.id)).text)
      expect(w.contexts.get(id)?.options().cwd).toBe(join(dir, 'chats', parent.id))
      expect(w.service.chatFolderOf(id)).toBe(join(dir, 'chats', parent.id))
      // Deleting and purging the helper leaves the parent's folder alone.
      w.api['sessions.remove'](id)
      vi.advanceTimersByTime(6000)
      expect(w.store.getSession(id)).toBeUndefined()
      expect(w.service.chatFolderOf(parent.id)).toBe(join(dir, 'chats', parent.id))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not save checkpoints for a helper that works in its parent’s project, and does for a separate copy', async () => {
    const snapshots = new FakeSnapshots()
    const w = world({ snapshots })
    const parent = w.make({ mode: 'develop', cwd: '/work/shop', branch: 'main' })
    const same = w.idOf((await w.start(parent.id, { approval: 'plan' })).text)
    await flush()
    expect(w.api['sessions.get'](same)?.summary).toMatchObject({ cwd: '/work/shop', branch: 'main', mode: 'develop' })
    expect(snapshots.taken).toEqual([])
    const copy = w.idOf((await w.start(parent.id, { folder: 'copy' })).text)
    await flush()
    expect(w.api['sessions.get'](copy)?.summary).toMatchObject({ cwd: '/data/worktrees/shop-1', branch: 'celeste/helper-1' })
    expect(snapshots.taken).toHaveLength(1)
  })

  it('allows one helper that can change files in a folder at a time, unless it plans or has a copy (cases 26, 27)', async () => {
    const w = world()
    const chat = w.make()
    await w.working(chat.id)
    const clash = await w.start(chat.id)
    expect(clash).toEqual({ text: 'Another helper is changing files in this folder. Use folder: "copy", or approval: "plan", or wait for it.', isError: true })
    expect((await w.start(chat.id, { approval: 'plan' })).isError).toBe(false)
    expect(await w.start(chat.id, { folder: 'copy' })).toEqual({ text: 'A separate copy is only for a project (Develop).', isError: true })

    const dev = w.make({ mode: 'develop', cwd: 'D:\\Work\\Shop' })
    await w.working(dev.id)
    expect((await w.start(dev.id)).isError).toBe(true)
    expect((await w.start(dev.id, { folder: 'copy' })).isError).toBe(false)
    // The same folder written another way is the same folder (Windows).
    const same = w.make({ mode: 'develop', cwd: 'D:\\Work\\Shop' })
    if (process.platform === 'win32') {
      expect((await w.start(same.id)).isError).toBe(true)
    }
  })

  it('refuses a copy that cannot be made, with the sentence it was refused with', async () => {
    const w = world({
      worktree: async () => {
        throw new Error('A separate copy needs a git project. This folder is not one.')
      }
    })
    const dev = w.make({ mode: 'develop', cwd: '/work/not-git' })
    expect(await w.start(dev.id, { folder: 'copy' })).toEqual({ text: 'A separate copy needs a git project. This folder is not one.', isError: true })
    expect(w.store.listChildren(dev.id)).toEqual([])
  })

  it('ends a helper’s answer with where its separate copy is', async () => {
    const w = world()
    const dev = w.make({ mode: 'develop', cwd: '/work/shop' })
    const p = w.start(dev.id, { folder: 'copy', wait: true })
    await flush()
    const id = w.store.listChildren(dev.id)[0]?.id as string
    await w.run(id, 'Changed three files.')
    const r = await p
    expect(r.text).toContain('Changed three files.')
    expect(r.text).toContain('[It worked in a separate copy at /data/worktrees/shop-1, on branch celeste/helper-1. Its changes are not in your folder: merge the branch, or ask the person.]')
  })
})

describe('the limits (cases 23, 24, 25, 49)', () => {
  it('lets four helpers work for a chat at once, and refuses the fifth', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    for (let i = 0; i < MAX_RUNNING_PER_PARENT; i++) await w.working(parent.id, { title: `H${i}` })
    const fifth = await w.start(parent.id)
    expect(fifth.isError).toBe(true)
    expect(fifth.text).toContain('4 helpers are already working for this chat')
    expect(fifth.text).toContain('agent_wait')
  })

  it('refuses beyond eight helpers across all chats', async () => {
    const w = world()
    const a = w.make({ approval: 'plan' })
    const b = w.make({ approval: 'plan' })
    const c = w.make({ approval: 'plan' })
    for (let i = 0; i < 4; i++) await w.working(a.id)
    for (let i = 0; i < 4; i++) await w.working(b.id)
    const r = await w.start(c.id)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('8 helpers are already working across all of the person')
  })

  it('refuses the thirteenth start since the person’s last message, and a wake does not reset the count', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.parentBegins(parent.id)
    for (let i = 0; i < MAX_STARTS_PER_MESSAGE; i++) {
      const id = await w.working(parent.id, { title: `H${i}` })
      await w.run(id)
    }
    const refused = await w.start(parent.id)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('12 helpers have been started since the person')
    // The parent's turn ends and Celeste wakes it with the answers: still no new start until the person writes.
    await w.parentEnds(parent.id)
    vi.advanceTimersByTime(NOTE_BATCH_MS)
    await flush()
    expect(w.eventsOf(parent.id).filter((e) => e.type === 'user.message' && e.from === 'celeste')).toHaveLength(1)
    expect((await w.start(parent.id)).isError).toBe(true)
    // The person’s own message does.
    await w.parentEnds(parent.id)
    w.api['sessions.send'](parent.id, { text: 'Go on', attachments: [] })
    expect((await w.start(parent.id)).isError).toBe(false)
  })
})

describe('waiting for a helper', () => {
  it('gives the helper’s answer back as the call’s result, framed as another assistant’s words', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const call = w.start(parent.id, { wait: true, title: 'Reader' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    await w.run(id, 'The answer is 42.')
    const r = await call
    expect(r.isError).toBe(false)
    expect(r.text).toBe('[Answer from the helper “Reader” (Claude claude:sonnet). It is another assistant’s work, not the person’s words.]\nThe answer is 42.')
    expect(w.finished(parent.id)).toEqual([{ type: 'child.finished', childId: id, title: 'Reader', status: 'done', result: 'The answer is 42.', delivered: 'tool' }])
    // Nothing is told again later.
    await w.parentEnds(parent.id)
    vi.advanceTimersByTime(NOTE_BATCH_MS * 2)
    expect(w.service.pendingNote(parent.id)).toBe(false)
    expect(w.agents.get(parent.id)?.sent).toHaveLength(1)
  })

  it('cuts a long answer, and says where the rest is (case 42)', async () => {
    const w = world()
    const parent = w.make()
    const call = w.start(parent.id, { wait: true, title: 'Writer' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    await w.run(id, 'x'.repeat(13_000))
    const r = await call
    expect(r.text).toContain('… (cut: 1000 more characters; the whole answer is in the helper “Writer”)')
    expect(r.text.length).toBeLessThan(12_700)
    expect(r.text.match(/… \(cut:/g)).toHaveLength(1)
    expect(w.finished(parent.id)[0]?.result?.length).toBeLessThan(12_200)
  })

  it('says so when a helper finishes with no words (case 43)', async () => {
    const w = world()
    const parent = w.make()
    const call = w.start(parent.id, { wait: true })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    await w.run(id, '')
    expect((await call).text).toContain('(The helper finished without saying anything. Open it to see what it did.)')
  })

  it('returns a failure as an error, at once (cases 33, 34)', async () => {
    const w = world()
    const parent = w.make()
    const call = w.start(parent.id, { wait: true, title: 'Broken' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    // A failure before any turn began, as a wrong key or a missing model gives.
    w.agents.get(id)?.emit({ type: 'turn.failed', turnId: 'c', error: { code: 'auth', message: 'The key was not accepted.', retryable: false } })
    await settle()
    const r = await call
    expect(r).toEqual({ text: 'The helper “Broken” failed: The key was not accepted.', isError: true })
    expect(w.finished(parent.id)[0]).toMatchObject({ status: 'failed', error: 'The key was not accepted.', delivered: 'tool' })

    const limited = w.start(parent.id, { wait: true, title: 'Limited', approval: 'plan' })
    await flush()
    const id2 = w.store.listChildren(parent.id)[1]?.id as string
    w.agents.get(id2)?.emit({ type: 'turn.started', turnId: 'c' })
    w.agents.get(id2)?.emit({ type: 'turn.failed', turnId: 'c', error: { code: 'rate_limit', message: 'Too many requests', retryable: true } })
    await settle()
    expect((await limited).text).toBe('The helper “Limited” failed: Too many requests')
  })

  it('returns "stopped" when the person stops the helper the parent waits on (case 8)', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const call = w.start(parent.id, { wait: true, title: 'Slow' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    w.agents.get(id)?.emit({ type: 'turn.started', turnId: 'c' })
    await settle()
    w.api['sessions.interrupt'](id)
    await run(w, id)
    expect(await call).toEqual({ text: 'The helper “Slow” was stopped before it finished.', isError: true })
    expect(w.finished(parent.id)[0]).toMatchObject({ status: 'stopped', delivered: 'tool' })
  })

  async function run(w: ReturnType<typeof world>, id: string) {
    w.agents.get(id)?.emit({ type: 'turn.interrupted', turnId: 'c' })
    await settle()
  }

  it('says the helper was deleted when the person deletes it while the parent waits (case 29)', async () => {
    const w = world()
    const parent = w.make()
    const call = w.start(parent.id, { wait: true, title: 'Doomed' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    w.api['sessions.remove'](id)
    expect(await call).toEqual({ text: 'The person deleted the helper “Doomed”.', isError: true })
    expect(w.finished(parent.id)[0]).toMatchObject({ status: 'deleted', delivered: 'tool' })
  })

  it('keeps waiting while the helper asks the person a question, and gives up waiting at the cap (cases 9, 10)', async () => {
    const w = world()
    const parent = w.make({ approval: 'auto' })
    await w.parentBegins(parent.id)
    const call = w.start(parent.id, { wait: true, title: 'Asker' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    w.agents.get(id)?.emit({ type: 'turn.started', turnId: 'c' })
    w.agents.get(id)?.emit({ type: 'approval.requested', requestId: 'r1', kind: 'shell', title: 'Run a command' })
    await settle()
    expect(w.api['sessions.get'](id)?.summary.status).toBe('waiting')
    expect(w.sub.views(parent.id)[0]?.state).toBe('waiting')
    vi.advanceTimersByTime(WAIT_CAP_MS - 1000)
    let done = false
    void call.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    vi.advanceTimersByTime(1000)
    const r = await call
    expect(r.isError).toBe(false)
    expect(r.text).toContain('is still working, and waits for the person to answer a question it asked. Use agent_wait to keep waiting')

    // It went on in the background: when the person answers and it ends, the parent is told with a note.
    await w.parentEnds(parent.id)
    w.api['sessions.respondApproval'](id, 'r1', { allow: true, always: false })
    await w.run(id, 'Done after all.')
    expect(w.finished(parent.id)[0]).toMatchObject({ status: 'done', delivered: 'note' })
    vi.advanceTimersByTime(NOTE_BATCH_MS)
    await flush()
    const woke = (w.agents.get(parent.id)?.sent.at(-1) as { text: string }).text
    expect(woke).toContain('The helper “Asker”')
    expect(woke).toContain('Done after all.')
  })

  it('gives the cap of the parent’s vendor, and never waits for a vendor that cannot (Gemini)', async () => {
    const w = world({ caps: (v) => (v === 'claude' ? 120_000 : 0) })
    const parent = w.make()
    const call = w.start(parent.id, { wait: true })
    await flush()
    vi.advanceTimersByTime(120_000)
    expect((await call).text).toContain('is still working')

    const gem = w.make({ vendor: 'gemini', model: 'gemini:flash' })
    w.ready.add('gemini')
    const r = await w.start(gem.id, { wait: true, title: 'Bg' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('cannot wait for a helper: it works in the background')
    expect(w.startedEvents(gem.id)[0]?.wait).toBe(false)
  })
})

describe('agent_wait (cases 17, 18)', () => {
  it('waits for every helper that is working, or the first to end', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.parentBegins(parent.id)
    const a = await w.working(parent.id, { title: 'A' })
    const b = await w.working(parent.id, { title: 'B' })
    const all = w.sub.wait(parent.id, undefined, false)
    await w.run(a, 'Answer A')
    let done = false
    void all.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    await w.run(b, 'Answer B')
    const r = await all
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Helper “A” (id ' + a + ')')
    expect(r.text).toContain('Answer A')
    expect(r.text).toContain('Answer B')
    expect(w.finished(parent.id).map((f) => f.delivered)).toEqual(['tool', 'tool'])

    const c = await w.working(parent.id, { title: 'C' })
    const d = await w.working(parent.id, { title: 'D' })
    const first = w.sub.wait(parent.id, [c, d], true)
    await w.run(d, 'D first')
    const f = await first
    expect(f.text).toContain('D first')
    expect(f.text).toContain('still working')
  })

  it('refuses an id that is not one of this chat’s helpers (case 22)', async () => {
    const w = world()
    const one = w.make()
    const two = w.make()
    const mine = w.idOf((await w.start(one.id, { approval: 'plan' })).text)
    expect(await w.sub.wait(two.id, [mine], false)).toEqual({ text: 'There is no helper with that id here.', isError: true })
    expect(await w.sub.send(two.id, mine, 'More', false)).toEqual({ text: 'There is no helper with that id here.', isError: true })
    expect(w.sub.stopHelper(two.id, mine)).toEqual({ text: 'There is no helper with that id here.', isError: true })
    expect(await w.sub.send(one.id, one.id, 'Me?', false)).toEqual({ text: 'There is no helper with that id here.', isError: true })
  })

  it('hands over, once, an answer that ended while the parent was busy and was not told yet', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const id = await w.working(parent.id, { title: 'Early' })
    await w.run(id, 'Early answer')
    expect(w.service.pendingNote(parent.id)).toBe(true)
    const r = await w.sub.wait(parent.id, [id], false)
    expect(r.text).toContain('Early answer')
    // The tool gave it: the note no longer waits, and no turn is started for it.
    expect(w.service.pendingNote(parent.id)).toBe(false)
    expect(w.finished(parent.id).map((f) => f.delivered)).toEqual(['note', 'tool'])
    await w.parentEnds(parent.id)
    vi.advanceTimersByTime(NOTE_BATCH_MS * 2)
    await flush()
    expect(w.agents.get(parent.id)?.sent).toHaveLength(1)
  })

  it('says an answer was already told, and does not repeat it', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const id = await w.working(parent.id, { title: 'Told' })
    await w.parentEnds(parent.id)
    await w.run(id, 'The old answer')
    vi.advanceTimersByTime(NOTE_BATCH_MS)
    await flush()
    // The wake told the parent, with the answer.
    expect((w.agents.get(parent.id)?.sent.at(-1) as { text: string }).text).toContain('The old answer')
    const r = await w.sub.wait(parent.id, [id], false)
    expect(r.text).toContain('already given to you')
    expect(r.text).not.toContain('The old answer')
  })

  it('answers once when the end and agent_wait arrive together', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const id = await w.working(parent.id)
    const waiting = w.sub.wait(parent.id, [id], false)
    await w.run(id, 'Both at once')
    expect((await waiting).text).toContain('Both at once')
    expect(w.finished(parent.id)).toHaveLength(1)
    expect(w.finished(parent.id)[0]?.delivered).toBe('tool')
    expect(w.service.pendingNote(parent.id)).toBe(false)
  })

  it('answers at once, saying nothing is running, when no helper works', async () => {
    const w = world()
    const parent = w.make()
    expect((await w.sub.wait(parent.id, undefined, false)).text).toContain('No helper is working now')
  })
})

describe('more work, and stopping (cases 20, 21)', () => {
  it('refuses more work for a helper that is still working, and gives an idle one a new assignment', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const id = await w.working(parent.id, { title: 'Busy' })
    expect(await w.sub.send(parent.id, id, 'More', false)).toEqual({ text: 'It is still working. Use agent_wait.', isError: true })
    await w.run(id, 'First answer')
    await w.parentEnds(parent.id)
    const again = w.sub.send(parent.id, id, 'And now this', true)
    await flush()
    expect(w.startedEvents(parent.id).at(-1)).toMatchObject({ childId: id, again: true, task: 'And now this', wait: true })
    await w.run(id, 'Second answer')
    expect((await again).text).toContain('Second answer')
    const messages = w.eventsOf(id).filter((e) => e.type === 'user.message')
    expect(messages.map((m) => m.from)).toEqual(['parent', 'parent'])
  })

  it('tells the parent nothing when the person talks to a helper after it finished', async () => {
    const w = world()
    const parent = w.make()
    const id = await w.working(parent.id)
    await w.run(id, 'Done')
    const before = w.finished(parent.id).length
    w.api['sessions.send'](id, { text: 'One more thing', attachments: [] })
    await w.run(id, 'Done again')
    expect(w.finished(parent.id)).toHaveLength(before)
  })

  it('ends when the helper is idle with nothing queued, and says the person talked to it (case 19)', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const call = w.start(parent.id, { wait: true, title: 'Chatty' })
    await flush()
    const id = w.store.listChildren(parent.id)[0]?.id as string
    w.agents.get(id)?.emit({ type: 'turn.started', turnId: 'c' })
    await settle()
    // The person types into the helper while it works: the message waits its turn.
    w.api['sessions.send'](id, { text: 'Also check the cache', attachments: [] }, 'queue')
    w.agents.get(id)?.emit({ type: 'message.delta', text: 'First part.' })
    w.agents.get(id)?.emit({ type: 'turn.completed', turnId: 'c' })
    await settle()
    // It is busy again with the person's message, so the assignment goes on.
    expect(w.finished(parent.id)).toHaveLength(0)
    await w.run(id, 'Cache checked too.')
    const r = await call
    expect(r.text).toContain('[The person also talked to this helper while it worked.]\nCache checked too.')
  })

  it('stops a helper for agent_stop, as the person’s Stop would', async () => {
    const w = world()
    const parent = w.make()
    const id = await w.working(parent.id)
    expect(w.sub.stopHelper(parent.id, id)).toEqual({ text: 'Stopped “Looker”.', isError: false })
    expect(w.agents.get(id)?.interrupted).toBe(1)
    await w.run(id, '', 'turn.interrupted')
    expect(w.finished(parent.id)[0]).toMatchObject({ status: 'stopped', delivered: 'note' })
    expect(w.sub.stopHelper(parent.id, id).text).toContain('is not working now')
  })
})

describe('Stop and delete in the parent (cases 7, 28, 30, 31)', () => {
  it('stops waited and background helpers with it, answers the waiting call, and wakes nobody (case 7)', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.parentBegins(parent.id)
    const waited = w.start(parent.id, { wait: true, title: 'Waited' })
    await flush()
    const bg = await w.working(parent.id, { title: 'Background' })
    const waitedId = w.store.listChildren(parent.id)[0]?.id as string
    w.api['sessions.interrupt'](parent.id)
    expect(await waited).toEqual({ text: 'The person stopped this chat, so the helper “Waited” was stopped.', isError: true })
    expect(w.agents.get(waitedId)?.interrupted).toBe(1)
    expect(w.agents.get(bg)?.interrupted).toBe(1)
    expect(w.finished(parent.id).map((f) => [f.title, f.status, f.delivered])).toEqual([
      ['Waited', 'stopped', 'none'],
      ['Background', 'stopped', 'none']
    ])
    // The helpers' own ends arrive later and change nothing; the parent is not woken.
    await w.run(waitedId, '', 'turn.interrupted')
    await w.run(bg, '', 'turn.interrupted')
    await w.parentEnds(parent.id, 'turn.interrupted')
    vi.advanceTimersByTime(NOTE_BATCH_MS * 3)
    await flush()
    expect(w.finished(parent.id)).toHaveLength(2)
    expect(w.agents.get(parent.id)?.sent).toHaveLength(1)
    // They stay in the list and can be given more work.
    expect(w.store.listChildren(parent.id)).toHaveLength(2)
    expect(w.sub.views(parent.id).map((v) => v.state)).toEqual(['stopped', 'stopped'])
  })

  it('deletes its helpers with it, and Undo brings back the ones that went with it only (cases 28, 30)', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.parentBegins(parent.id)
    const early = await w.working(parent.id, { title: 'Early' })
    const a = await w.working(parent.id, { title: 'A' })
    const b = await w.working(parent.id, { title: 'B' })
    // The person deletes one helper on its own first.
    w.api['sessions.remove'](early)
    expect(w.sub.views(parent.id).map((v) => v.title)).toEqual(['A', 'B'])
    w.api['sessions.remove'](parent.id)
    expect(w.service.sessionRow(parent.id)).toBeUndefined()
    expect(w.service.sessionRow(a)).toBeUndefined()
    expect(w.service.sessionRow(b)).toBeUndefined()
    expect(w.pushes.filter((p) => p.type === 'removed').map((p) => (p as { id: string }).id)).toEqual(expect.arrayContaining([early, a, b, parent.id]))

    const restored = w.api['sessions.restore'](parent.id)
    expect(restored?.id).toBe(parent.id)
    expect(w.service.sessionRow(a)?.status).toBe('idle')
    expect(w.service.sessionRow(b)).toBeDefined()
    expect(w.service.sessionRow(early)).toBeUndefined()
    // Their cards say they were stopped.
    expect(w.finished(parent.id).filter((f) => f.title !== 'Early').map((f) => f.status)).toEqual(['stopped', 'stopped'])
    // Left alone, the one the person deleted goes for good.
    vi.advanceTimersByTime(6000)
    expect(w.store.getSession(early)).toBeUndefined()
    expect(w.store.getSession(a)).toBeDefined()
  })

  it('purges the helpers with the parent when the time to undo is over', async () => {
    const w = world()
    const parent = w.make()
    const id = w.idOf((await w.start(parent.id)).text)
    w.api['sessions.remove'](parent.id)
    vi.advanceTimersByTime(6000)
    expect(w.store.getSession(parent.id)).toBeUndefined()
    expect(w.store.getSession(id)).toBeUndefined()
  })

  it('writes in the parent that work in progress was not finished when Celeste was closed (case 31)', async () => {
    const store = new MemoryStore()
    const w = world({ store })
    const parent = w.make()
    const id = await w.working(parent.id, { title: 'Interrupted' })
    // Celeste starts again on the same data.
    const again = world({ store })
    expect(again.finished(parent.id)).toEqual([{ type: 'child.finished', childId: id, title: 'Interrupted', status: 'abandoned', delivered: 'none' }])
    expect(again.eventsOf(id).some((e) => e.type === 'turn.abandoned')).toBe(true)
    // Nothing is woken or restarted.
    vi.advanceTimersByTime(NOTE_BATCH_MS * 3)
    await flush()
    expect(again.agents.size).toBe(0)
  })

  it('refuses a revert while a helper works in the same folder (case 45)', async () => {
    const snapshots = new FakeSnapshots()
    const w = world({ snapshots })
    const parent = w.make({ mode: 'develop', cwd: '/work/shop' })
    w.api['sessions.send'](parent.id, { text: 'Change it', attachments: [] })
    await flush()
    w.agents.get(parent.id)?.emit({ type: 'turn.started', turnId: 'p' })
    w.agents.get(parent.id)?.emit({ type: 'turn.completed', turnId: 'p' })
    await settle()
    const checkpoint = w.eventsOf(parent.id).find((e) => e.type === 'checkpoint.created') as { id: string }
    await w.working(parent.id, { approval: 'plan' })
    await expect(w.api['sessions.revert'](parent.id, checkpoint.id)).rejects.toThrow('A helper is working in this folder. Stop it first.')
  })
})

describe('telling the parent later (cases 11 to 16)', () => {
  it('wakes an idle parent once with one note for helpers that end within a moment of each other (cases 11, 13)', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.parentBegins(parent.id)
    const ids = [await w.working(parent.id, { title: 'One' }), await w.working(parent.id, { title: 'Two' }), await w.working(parent.id, { title: 'Three' })]
    await w.parentEnds(parent.id)
    await w.run(ids[0] as string, 'Answer one')
    vi.advanceTimersByTime(500)
    await w.run(ids[1] as string, 'Answer two')
    vi.advanceTimersByTime(500)
    await w.run(ids[2] as string, 'Answer three')
    expect(w.agents.get(parent.id)?.sent).toHaveLength(1)
    vi.advanceTimersByTime(NOTE_BATCH_MS)
    await flush()
    const sent = w.agents.get(parent.id)?.sent as { text: string }[]
    expect(sent).toHaveLength(2)
    for (const word of ['Answer one', 'Answer two', 'Answer three']) expect(sent[1]?.text).toContain(word)
    expect(sent[1]?.text).toContain('It is another assistant’s work, not the person’s words.')
    // The chat shows a short line, from Celeste, not the notes.
    const wake = w.eventsOf(parent.id).filter((e) => e.type === 'user.message' && e.from === 'celeste')
    expect(wake).toEqual([{ type: 'user.message', text: 'Helpers finished: “One”, “Two”, “Three”.', attachments: [], from: 'celeste' }])
    expect(w.service.pendingNote(parent.id)).toBe(false)
  })

  it('waits for the parent’s own turn to end, then wakes it (case 12)', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const id = await w.working(parent.id)
    await w.run(id, 'Quick answer')
    vi.advanceTimersByTime(NOTE_BATCH_MS * 2)
    await flush()
    expect(w.agents.get(parent.id)?.sent).toHaveLength(1)
    await w.parentEnds(parent.id)
    await flush()
    const sent = w.agents.get(parent.id)?.sent as { text: string }[]
    expect(sent).toHaveLength(2)
    expect(sent[1]?.text).toContain('Quick answer')
  })

  it('does not wake a parent whose queue has messages: the note goes with the next one (case 14)', async () => {
    const w = world()
    const parent = w.make()
    await w.parentBegins(parent.id)
    const id = await w.working(parent.id)
    w.api['sessions.send'](parent.id, { text: 'And then this', attachments: [] }, 'queue')
    await w.run(id, 'Helper answer')
    vi.advanceTimersByTime(NOTE_BATCH_MS * 2)
    await w.parentEnds(parent.id)
    await flush()
    const sent = w.agents.get(parent.id)?.sent as { text: string }[]
    expect(sent).toHaveLength(2)
    expect(sent[1]?.text.startsWith('And then this')).toBe(true)
    expect(sent[1]?.text).toContain('Helper answer')
    expect(w.eventsOf(parent.id).some((e) => e.type === 'user.message' && e.from === 'celeste')).toBe(false)
  })

  it('does not wake a parent whose queue is paused, or whose turn failed at a limit (cases 15, 16)', async () => {
    const w = world()
    const paused = w.make()
    await w.parentBegins(paused.id)
    const id = await w.working(paused.id)
    w.api['sessions.send'](paused.id, { text: 'Waiting message', attachments: [] }, 'queue')
    await w.run(id, 'Answer while paused')
    w.api['sessions.interrupt'](paused.id)
    await w.parentEnds(paused.id, 'turn.interrupted')
    vi.advanceTimersByTime(NOTE_BATCH_MS * 2)
    await flush()
    expect(w.agents.get(paused.id)?.sent).toHaveLength(1)
    expect(w.service.pendingNote(paused.id)).toBe(true)
    // The person's next message carries it.
    w.api['sessions.send'](paused.id, { text: 'Carry on', attachments: [] })
    await flush()
    expect((w.agents.get(paused.id)?.sent.at(-1) as { text: string }).text).toContain('Answer while paused')
    expect(w.service.pendingNote(paused.id)).toBe(false)

    const limited = w.make()
    await w.parentBegins(limited.id)
    const id2 = await w.working(limited.id)
    w.agents.get(limited.id)?.emit({ type: 'turn.failed', turnId: 'p', error: { code: 'rate_limit', message: 'Too many requests', retryable: true } })
    await settle()
    await w.run(id2, 'Answer at the limit')
    vi.advanceTimersByTime(NOTE_BATCH_MS * 2)
    await flush()
    expect(w.agents.get(limited.id)?.sent).toHaveLength(1)
    expect(w.service.pendingNote(limited.id)).toBe(true)
  })

  it('tells of a failed, stopped or deleted helper in the note, framed the same way', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.parentBegins(parent.id)
    const f = await w.working(parent.id, { title: 'Fails' })
    const s = await w.working(parent.id, { title: 'Stops' })
    await w.parentEnds(parent.id)
    w.agents.get(f)?.emit({ type: 'turn.failed', turnId: 'c', error: { code: 'network', message: 'Offline', retryable: true } })
    await settle()
    w.api['sessions.interrupt'](s)
    await w.run(s, '', 'turn.interrupted')
    vi.advanceTimersByTime(NOTE_BATCH_MS)
    await flush()
    const text = (w.agents.get(parent.id)?.sent.at(-1) as { text: string }).text
    expect(text).toContain('“Fails”')
    expect(text).toContain('failed: Offline')
    expect(text).toContain('was stopped before it finished')
  })
})

/** Starts a helper in a chat that asks first, and says yes to the card. */
async function allowed(w: ReturnType<typeof world>, parentId: string) {
  const call = w.start(parentId)
  await flush()
  const card = w.eventsOf(parentId).filter((e) => e.type === 'approval.requested').at(-1) as { requestId: string }
  w.api['sessions.respondApproval'](parentId, card.requestId, { allow: true, always: false })
  return call
}

describe('what a helper may not do', () => {
  it('refuses to loosen a helper past its ceiling, and sets the ceiling for "don’t ask again" (case 39)', async () => {
    const w = world()
    const parent = w.make({ approval: 'ask' })
    const id = w.idOf((await allowed(w, parent.id)).text)
    expect(() => w.api['sessions.update'](id, { approval: 'auto' })).toThrow('A helper cannot be looser than the chat that started it (ask).')
    expect(() => w.api['sessions.update'](id, { approval: 'edits' })).toThrow('A helper cannot be looser than the chat that started it (ask).')
    expect(w.api['sessions.update'](id, { approval: 'plan' }).approval).toBe('plan')
    w.api['sessions.update'](id, { approval: 'ask' })

    const agent = w.agents.get(id) as FakeAgent
    agent.emit({ type: 'turn.started', turnId: 'c' })
    agent.emit({ type: 'approval.requested', requestId: 'q1', kind: 'shell', title: 'Run it' } as AgentEvent)
    await settle()
    w.api['sessions.respondApproval'](id, 'q1', { allow: true, always: true })
    expect(w.api['sessions.get'](id)?.summary.approval).toBe('ask')

    const loose = w.make({ approval: 'edits' })
    const id2 = w.idOf((await w.start(loose.id)).text)
    const agent2 = w.agents.get(id2) as FakeAgent
    agent2.emit({ type: 'turn.started', turnId: 'c' })
    agent2.emit({ type: 'approval.requested', requestId: 'q2', kind: 'shell', title: 'Run it' } as AgentEvent)
    await settle()
    w.api['sessions.respondApproval'](id2, 'q2', { allow: true, always: true })
    expect(w.api['sessions.get'](id2)?.summary.approval).toBe('edits')
  })

  it('knows a helper from a session the person started', async () => {
    const w = world()
    const parent = w.make()
    const id = w.idOf((await w.start(parent.id)).text)
    expect(w.sub.isHelper(id)).toBe(true)
    expect(w.sub.isHelper(parent.id)).toBe(false)
    expect(w.sub.isHelper('s-nobody')).toBe(false)
  })

  it('lists the helpers, what can be used, and the limits left', async () => {
    const w = world()
    const parent = w.make({ approval: 'plan' })
    await w.working(parent.id, { title: 'Listed' })
    const r = await w.sub.list(parent.id)
    expect(r.text).toContain('“Listed” (id ')
    expect(r.text).toContain('working, Claude claude:sonnet')
    expect(r.text).toContain('claude (Claude): claude:sonnet, claude:haiku')
    expect(r.text).toContain('1 of 4 helpers are working for this chat (1 of 8 across all chats); 11 more may be started')
    expect((await w.sub.list(w.make().id)).text).toContain('This chat has no helpers yet.')
  })
})

describe('the other moon of a Two Moons chat (docs/plans/TWO_MOONS_PLAN.md)', () => {
  const moons = { moons: { pattern: 'build' as const, vendor: 'openai' as const, model: 'openai:gpt', effort: null } }
  const madeWithMoon = () => {
    const w = world()
    const parent = w.make(moons)
    return { w, parent, moonId: parent.moons?.childId as string }
  }

  it('is a helper as far as what it may not do (no helpers of its own, no desktop), but not one of the assistant’s helpers', () => {
    const { w, parent, moonId } = madeWithMoon()
    expect(w.sub.isHelper(moonId)).toBe(true)
    expect(w.sub.isHelper(parent.id)).toBe(false)
    expect(w.store.getSession(moonId)?.spawn?.moon).toBe(true)
  })

  it('is left out of the helpers that are listed for the assistant, and of its list', async () => {
    const { w, parent } = madeWithMoon()
    expect(w.sub.views(parent.id)).toEqual([])
    expect((await w.sub.list(parent.id)).text).toContain('This chat has no helpers yet.')
    // A helper the assistant starts is listed, and the moon is still not.
    const id = w.idOf((await w.start(parent.id, { approval: 'plan', title: 'Looker' })).text)
    expect(w.sub.views(parent.id).map((v) => v.id)).toEqual([id])
    expect((await w.sub.list(parent.id)).text).not.toContain('Reviewer')
  })

  it('cannot be reached with agent_send, agent_wait or agent_stop', async () => {
    const { w, parent, moonId } = madeWithMoon()
    const none = { text: 'There is no helper with that id here.', isError: true }
    expect(await w.sub.send(parent.id, moonId, 'Look at this', false)).toEqual(none)
    expect(await w.sub.wait(parent.id, [moonId], false)).toEqual(none)
    expect(w.sub.stopHelper(parent.id, moonId)).toEqual(none)
    expect(w.agents.has(moonId)).toBe(false)
  })

  it('does not count against the helpers an assistant may run', async () => {
    const { w, parent } = madeWithMoon()
    for (let i = 0; i < MAX_RUNNING_PER_PARENT; i++) expect((await w.start(parent.id, { approval: 'plan', title: 'H' + i })).isError).toBe(false)
    expect((await w.start(parent.id, { approval: 'plan', title: 'One more' })).isError).toBe(true)
    expect((await w.sub.list(parent.id)).text).toContain('4 of 4 helpers are working')
  })
})
