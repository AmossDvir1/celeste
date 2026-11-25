import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEvent } from '@shared/api'
import { DIFF_CHARS } from '@shared/moons'
import { MemoryStore } from '../testing/memory-store'
import { ScriptedSnapshots, block, diff, flush, settle, world, type World } from '../testing/moons-world'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const review = (say: string, findings: { text: string; file?: string; line?: number; code?: string }[] = []) => block({ say, findings })
const fix = (say: string, answers: { n: number; fixed: boolean; say?: string }[] = []) => block({ say, answers })
const plan = (say: string, steps: string[]) => block({ say, steps })
const test = (say: string, failed: boolean, where: { file?: string; line?: number; code?: string } = {}) => block({ say, failed, ...where })

/** A build chat that has got as far as the Reviewer being asked. */
async function reviewing(w: World, request = 'Add a check for empty names') {
  const chat = w.make('build')
  w.say(chat.id, request)
  await w.penWorks(chat.id, 'I added the check.', diff('src/names.ts'))
  return chat
}

/** One build chat that has got as far as the Builder fixing two notes (one of them it will not follow). */
async function fixing(w: World) {
  const chat = await reviewing(w)
  await w.childAnswers(
    chat.childId,
    review('Two problems.', [
      { text: 'No check on empty input', file: 'src/names.ts', line: 2, code: 'const x = 1' },
      { text: 'Rename x', file: 'src/names.ts', line: 9 }
    ])
  )
  return chat
}

describe('making a chat with two moons', () => {
  it('makes the Reviewer a session of its own in plan mode, held there for good, in the chat’s folder', () => {
    const w = world()
    const chat = w.make('build', { mode: 'develop', cwd: '/proj', branch: 'main' })
    expect(chat.summary.moons).toEqual({ pattern: 'build', childId: chat.childId })
    const child = w.store.getSession(chat.childId)
    expect(child).toMatchObject({ title: 'Reviewer', vendor: 'openai', model: 'openai:gpt', mode: 'develop', cwd: '/proj', branch: 'main', approval: 'plan', parentId: chat.id })
    expect(child?.spawn).toEqual({ parentId: chat.id, folder: 'same', ceiling: 'plan', moon: true })
    // The chat's own agent keeps the chat's approval; the Reviewer cannot be loosened.
    expect(chat.summary.approval).toBe('auto')
    expect(() => w.api['sessions.update'](chat.childId, { approval: 'auto' })).toThrow('A helper cannot be looser than the chat that started it (plan).')
  })

  it('names the other moon for the pattern: Planner, Tester, Reviewer 2', () => {
    const w = world()
    expect(w.store.getSession(w.make('plan').childId)?.title).toBe('Planner')
    expect(w.store.getSession(w.make('bug').childId)?.title).toBe('Tester')
    expect(w.store.getSession(w.make('reviews').childId)?.title).toBe('Reviewer 2')
  })

  it('gives a Tester the chat’s own approval mode, because it must run commands', () => {
    const w = world()
    const chat = w.make('bug', { approval: 'edits' })
    expect(w.store.getSession(chat.childId)).toMatchObject({ approval: 'edits', spawn: { ceiling: 'edits', moon: true } })
  })

  it('puts a chat of two reviews in plan mode whatever was asked, and keeps it there', () => {
    const w = world()
    const chat = w.make('reviews', { approval: 'auto' })
    expect(chat.summary.approval).toBe('plan')
    expect(() => w.api['sessions.update'](chat.id, { approval: 'auto' })).toThrow('Two reviews only look, so this chat stays in plan mode.')
    expect(() => w.api['sessions.update'](chat.id, { approval: 'edits' })).toThrow('Two reviews only look')
    expect(w.api['sessions.update'](chat.id, { approval: 'plan' }).approval).toBe('plan')
    // Another pattern may change its mode.
    const build = w.make('build')
    expect(w.api['sessions.update'](build.id, { approval: 'ask' }).approval).toBe('ask')
  })

  it('refuses a pattern that is not one of the four, and makes nothing', () => {
    const w = world()
    expect(() => w.make('build', { moons: { pattern: 'nope' as 'build', vendor: 'openai', model: 'm', effort: null } })).toThrow('Invalid pattern')
    expect(() => w.make('build', { moons: { pattern: 'build', vendor: 'nobody' as 'openai', model: 'm', effort: null } })).toThrow('Invalid vendor')
    expect(w.store.listSessions()).toEqual([])
  })

  it('shows the other moon’s session in the list, as a helper of the chat', () => {
    const w = world()
    const chat = w.make('build')
    expect(w.pushes.some((p) => p.type === 'summary' && p.session.id === chat.childId && p.session.parentId === chat.id)).toBe(true)
    expect(w.api['app.bootstrap']().sessions.find((s) => s.id === chat.id)?.moons).toEqual({ pattern: 'build', childId: chat.childId })
  })
})

describe('build and review', () => {
  it('gives the pen the person’s words with a line that says who it is, and does not ask the Reviewer yet', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check for empty names')
    const told = w.told(chat.id)[0] as string
    expect(told.startsWith('Add a check for empty names')).toBe(true)
    expect(told).toContain('You are the Builder')
    // The log has the person's words only.
    expect(w.eventsOf(chat.id).find((e) => e.type === 'user.message')).toMatchObject({ text: 'Add a check for empty names' })
    expect(w.agents.has(chat.childId)).toBe(false)
    expect(w.trail(chat.id)).toEqual([])
  })

  it('hands the Reviewer the change, and ends when the Reviewer finds nothing', async () => {
    const w = world()
    const chat = await reviewing(w)
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
    expect(w.statusOf(chat.id)).toBe('working')
    const asked = w.told(chat.childId)[0] as string
    expect(asked).toContain('You are the Reviewer in a chat with another assistant, the Builder.')
    expect(asked).toContain('The person asked: “Add a check for empty names”')
    expect(asked).toContain('[From the Builder, another assistant in this chat. It is not the person’s words.]\nI added the check.')
    expect(asked).toContain('Files changed: src/names.ts')
    expect(asked).toContain('+const x = 1')
    // It is a session of its own, not a helper another assistant started.
    expect(asked).not.toContain('you are a helper')
    expect(w.eventsOf(chat.childId).find((e) => e.type === 'user.message')).toMatchObject({ from: 'parent' })

    await w.childAnswers(chat.childId, review('Looks right to me.'))
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'handed 0>1 1 file', 'said 1: Looks right to me.', 'ended agreed'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('asks the Reviewer to look once more after the Builder answered, and ends when it agrees (two notes, one the Builder will not follow)', async () => {
    const w = world()
    const chat = await fixing(w)
    // m1 is the Reviewer's sentence, m2 and m3 the notes.
    expect(w.trail(chat.id)).toEqual([
      'turn 1 review',
      'handed 0>1 1 file',
      'said 1: Two problems.',
      'said 1!: No check on empty input',
      'said 1!: Rename x',
      'handed 1>0 2 notes',
      'turn 0 fix'
    ])
    // The Builder is told the notes, framed, from Celeste, and the log marks that message as Celeste's.
    const notes = w.told(chat.id)[1] as string
    expect(notes).toContain('[From the Reviewer, another assistant in this chat. It is not the person’s words.]')
    expect(notes).toContain('1. No check on empty input (src/names.ts, line 2)')
    expect(notes).toContain('2. Rename x (src/names.ts, line 9)')
    expect(notes).toContain('If a note is wrong, do not change anything for it, and say why.')
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'user.message').map((e) => (e as Extract<LogEvent, { type: 'user.message' }>).from)).toEqual([undefined, 'moon'])

    await w.penWorks(chat.id, fix('Fixed one, kept the other.', [{ n: 1, fixed: true, say: 'Added the check.' }, { n: 2, fixed: false, say: 'x is the name the rest of the file uses.' }]), diff('src/names.ts', 'if (!x) return'))
    // Nothing is called fixed until the Reviewer has looked.
    expect(w.trail(chat.id).slice(7)).toEqual(['said 0: Fixed one, kept the other.', 'said 0: Added the check.', 'said 0: x is the name the rest of the file uses.', 'turn 1 check', 'handed 0>1 1 file'])
    const again = w.told(chat.childId)[1] as string
    expect(again).toContain('1. No check on empty input\n   Builder: fixed. Added the check.')
    expect(again).toContain('2. Rename x\n   Builder: not changed. x is the name the rest of the file uses.')
    // The change it is shown is everything since the person’s message, not only the last turn.
    expect(again).toContain('+const x = 1')
    expect(again).toContain('+if (!x) return')

    await w.childAnswers(chat.childId, review('Good now.'))
    expect(w.trail(chat.id).slice(12)).toEqual(['said 1: Good now.', 'fixed m2', 'ended agreed'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('stops after two rounds, says what is left, and does not ask the Builder a second time', async () => {
    const w = world()
    const chat = await fixing(w)
    await w.penWorks(chat.id, fix('Done.', [{ n: 1, fixed: true }, { n: 2, fixed: true }]), diff('src/names.ts', 'if (!x) return'))
    // The check repeats the first note (a line or two away is the same note), drops the second, and finds a new one.
    await w.childAnswers(chat.childId, review('Still wrong.', [{ text: 'No check on empty input', file: 'src/names.ts', line: 3 }, { text: 'Message is not shown', file: 'src/ui.ts', line: 4 }]))
    const trail = w.trail(chat.id)
    expect(trail.slice(10)).toEqual(['said 1: Still wrong.', 'said 1!: Message is not shown', 'fixed m3', 'ended rounds left 2'])
    // The repeated note is not said again, and the Builder is not asked a third time.
    expect(trail.filter((t) => t.startsWith('said 1!')).length).toBe(3)
    expect(w.told(chat.id)).toHaveLength(2)
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('ends with no review when the pen changed nothing, and never asks the Reviewer', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'What does this function do?')
    await w.penWorks(chat.id, 'It adds two numbers.')
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'ended nothing'])
    expect(w.agents.has(chat.childId)).toBe(false)
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('shows the Reviewer’s words as they are and ends when its block cannot be read', async () => {
    const w = world()
    const chat = await reviewing(w)
    await w.childAnswers(chat.childId, 'I think this is fine, but I have not run it.')
    expect(w.trail(chat.id).slice(2)).toEqual(['said 1 to person: I think this is fine, but I have not run it.', 'ended unread (Reviewer did not answer in the form Celeste needs, so the run stopped.)'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('does not take a block with the wrong shape for "no findings"', async () => {
    const w = world()
    const chat = await reviewing(w)
    await w.childAnswers(chat.childId, 'Fine.\n\n```moons\n{"say": "ok", "findings": "none"}\n```')
    expect(w.endedOf(chat.id)[0]).toMatchObject({ why: 'unread' })
    expect(w.trail(chat.id)).toContain('said 1 to person: Fine.')
  })

  it('goes on without answers when the Builder’s reply has no block', async () => {
    const w = world()
    const chat = await fixing(w)
    await w.penWorks(chat.id, 'I fixed what I could.', diff('src/names.ts', 'if (!x) return'))
    expect(w.trail(chat.id).slice(7)).toEqual(['turn 1 check', 'handed 0>1 1 file'])
    const again = w.told(chat.childId)[1] as string
    expect(again).toContain('Builder: no answer')
    await w.childAnswers(chat.childId, review('Good.'))
    // With no answers the notes the Reviewer did not repeat are settled.
    expect(w.trail(chat.id).slice(9)).toEqual(['said 1: Good.', 'fixed m2,m3', 'ended agreed'])
  })

  it('tells the Reviewer when the change was cut', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Generate the table')
    const lines = Array.from({ length: 5000 }, (_, i) => ({ type: 'add' as const, text: `row ${i} of the generated table that is long` }))
    await w.penWorks(chat.id, 'Done.', { path: 'table.ts', status: 'added', added: 5000, removed: 0, hunks: [{ header: '@@ -0,0 +1,5000 @@', lines }] })
    const asked = w.told(chat.childId)[0] as string
    expect(asked).toContain('the change below is cut')
    expect(asked).toMatch(/The last \d+ characters of it are left out/)
    expect(asked.length).toBeLessThan(DIFF_CHARS + 4000)
  })

  it('ends as failed with the vendor’s own sentence when the Reviewer cannot answer, and keeps the work', async () => {
    const w = world()
    const chat = await reviewing(w)
    await w.childAnswers(chat.childId, 'You have reached your limit. It comes back at 3 pm.', 'turn.failed')
    expect(w.trail(chat.id).slice(2)).toEqual(['ended failed (You have reached your limit. It comes back at 3 pm.)'])
    expect(w.statusOf(chat.id)).toBe('idle')
    // The change is still there in the chat's log.
    expect(w.eventsOf(chat.id).some((e) => e.type === 'tool.completed')).toBe(true)
  })

  it('ends as failed when the Builder’s own turn fails, and the chat is idle', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    await w.penBegins(chat.id)
    await w.penFails(chat.id, 'The service is unavailable.')
    expect(w.trail(chat.id)).toEqual(['ended failed (The service is unavailable.)'])
    expect(w.statusOf(chat.id)).toBe('idle')
    expect(w.agents.has(chat.childId)).toBe(false)
  })

  it('ends as failed when the Builder fails while fixing, and the Reviewer is not asked again', async () => {
    const w = world()
    const chat = await fixing(w)
    await w.penBegins(chat.id)
    await w.penFails(chat.id, 'Out of messages.', 'rate_limit')
    expect(w.trail(chat.id).slice(7)).toEqual(['ended failed (Out of messages.)'])
    expect(w.told(chat.childId)).toHaveLength(1)
  })

  it('ends as stopped when the pen’s turn is stopped by something other than the person', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    await w.penBegins(chat.id)
    await w.penEnds(chat.id, '', 'turn.interrupted')
    expect(w.trail(chat.id)).toEqual(['ended stopped'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('tells the service that the run goes on after the pen’s turn when the other moon takes over, so nothing that waits is sent', async () => {
    const w = world()
    const chat = await reviewing(w)
    expect(w.penDoneAnswers).toEqual([true])
    await w.childAnswers(chat.childId, review('One note.', [{ text: 'Check it' }]))
    await w.penWorks(chat.id, fix('Done.', [{ n: 1, fixed: true }]), diff('src/names.ts', 'more'))
    expect(w.penDoneAnswers).toEqual([true, true])
    // Not when the chat has no run (a plain turn), nor when the pen's turn was the end of the run.
    const plan = w.make('plan')
    w.say(plan.id, 'Add a dark mode')
    await w.childAnswers(plan.childId, block({ say: 'Plan.', steps: ['One', 'Two'] }))
    const card = w.eventsOf(plan.id).find((e) => e.type === 'approval.requested') as { requestId: string }
    w.api['sessions.respondApproval'](plan.id, card.requestId, { allow: true, always: false })
    await settle()
    await w.penWorks(plan.id, 'Built.')
    expect(w.penDoneAnswers).toEqual([true, true, false])
  })

  it('tells the service that two reviews go on when the pen is done first, and that they do not when the pen is done last', async () => {
    const w = world()
    const first = w.make('reviews')
    w.say(first.id, 'Review the login')
    await flush()
    await w.penWorks(first.id, review('Fine.'))
    expect(w.penDoneAnswers).toEqual([true])
    const second = w.make('reviews')
    w.say(second.id, 'Review the logout')
    await flush()
    await w.childAnswers(second.childId, review('Fine.'))
    await w.penWorks(second.id, review('Fine.'))
    expect(w.penDoneAnswers).toEqual([true, false])
  })

  it('starts a new run for the next message, with its own Reviewer turn', async () => {
    const w = world()
    const chat = await reviewing(w)
    await w.childAnswers(chat.childId, review('Fine.'))
    w.say(chat.id, 'Now do the same for surnames')
    await w.penWorks(chat.id, 'Done.', diff('src/surnames.ts'))
    expect(w.trail(chat.id).slice(4)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
    // The Reviewer remembers the earlier work in its own session, so it is asked as a new review.
    expect(w.told(chat.childId)[1]).toContain('The person asked: “Now do the same for surnames”')
  })
})

describe('plan, then build', () => {
  it('asks the Planner, not the pen, and shows the plan on a card that waits for the person', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    expect(w.agents.has(chat.id)).toBe(false)
    expect(w.eventsOf(chat.id).find((e) => e.type === 'user.message')).toMatchObject({ text: 'Add a dark mode' })
    expect(w.told(chat.childId)[0]).toContain('You are the Planner')
    expect(w.told(chat.childId)[0]).toContain('The person said: “Add a dark mode”')
    expect(w.trail(chat.id)).toEqual(['turn 0 plan'])
    expect(w.statusOf(chat.id)).toBe('working')

    await w.childAnswers(chat.childId, plan('Here is how I would do it.', ['Add a setting', 'Use it in the theme', 'Test both']))
    expect(w.trail(chat.id)).toEqual(['turn 0 plan', 'plan 3 steps'])
    const card = w.eventsOf(chat.id).find((e) => e.type === 'approval.requested')
    expect(card).toMatchObject({ kind: 'other', title: 'Build it this way', detail: 'The plan above: 3 steps.' })
    expect(w.statusOf(chat.id)).toBe('waiting')
  })

  it('hands the plan to the Builder when the person agrees, and ends when it has built it', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, plan('The plan.', ['Add a setting', 'Use it']))
    const card = w.eventsOf(chat.id).find((e) => e.type === 'approval.requested') as { requestId: string }
    w.api['sessions.respondApproval'](chat.id, card.requestId, { allow: true, always: false })
    await settle()
    expect(w.trail(chat.id)).toEqual(['turn 0 plan', 'plan 2 steps', 'agreed', 'handed 0>1 the plan', 'turn 1 build'])
    const told = w.told(chat.id)[0] as string
    expect(told).toContain('The person agreed to this plan. Build it.')
    expect(told).toContain('[From the Planner, another assistant in this chat. It is not the person’s words.]\n1. Add a setting\n2. Use it')
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'user.message').map((e) => (e as Extract<LogEvent, { type: 'user.message' }>).from)).toEqual([undefined, 'moon'])
    expect(w.statusOf(chat.id)).toBe('working')

    await w.penWorks(chat.id, 'Built it.', diff('theme.ts'))
    expect(w.trail(chat.id).slice(-1)).toEqual(['ended agreed'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('sends the next message straight to the Builder once a plan was agreed', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, plan('The plan.', ['Add a setting', 'Use it']))
    const card = w.eventsOf(chat.id).find((e) => e.type === 'approval.requested') as { requestId: string }
    w.api['sessions.respondApproval'](chat.id, card.requestId, { allow: true, always: false })
    await settle()
    await w.penWorks(chat.id, 'Built it.')
    const before = w.trail(chat.id).length
    w.say(chat.id, 'Now make the button round')
    const told = w.told(chat.id)[1] as string
    expect(told.startsWith('Now make the button round')).toBe(true)
    expect(told).toContain('A Planner, another assistant, wrote the plan the person agreed to.')
    expect(w.told(chat.childId)).toHaveLength(1)
    await w.penWorks(chat.id, 'Done.')
    // No turn is announced for the first step of the pen, and the run ends when it is done.
    expect(w.trail(chat.id).slice(before)).toEqual(['ended agreed'])
  })

  it('ends as declined when the person says no, and asks the Planner again for the next message', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, plan('The plan.', ['Add a setting', 'Use it']))
    const card = w.eventsOf(chat.id).find((e) => e.type === 'approval.requested') as { requestId: string }
    w.api['sessions.respondApproval'](chat.id, card.requestId, { allow: false, always: false })
    await settle()
    expect(w.trail(chat.id)).toEqual(['turn 0 plan', 'plan 2 steps', 'ended declined'])
    expect(w.statusOf(chat.id)).toBe('idle')
    expect(w.agents.has(chat.id)).toBe(false)

    w.say(chat.id, 'Make it smaller')
    expect(w.told(chat.childId)).toHaveLength(2)
    expect(w.told(chat.childId)[1]).toContain('The person said: “Make it smaller”')
    expect(w.agents.has(chat.id)).toBe(false)
    expect(w.trail(chat.id).slice(3)).toEqual(['turn 0 plan'])
  })

  it('goes to the Planner with a question typed while the plan waits, lets the card go, and does not call that a no', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, plan('The plan.', ['Add a setting', 'Use it']))
    w.say(chat.id, 'Why do we need step 2?', 'queue')
    await settle()
    const trail = w.trail(chat.id)
    expect(trail).toEqual(['turn 0 plan', 'plan 2 steps', 'ended stopped', 'turn 0 plan'])
    expect(trail).not.toContain('ended declined')
    expect(w.service.pendingApprovals(chat.id)).toBe(0)
    expect(w.told(chat.childId)[1]).toContain('The person said: “Why do we need step 2?”')
    // The pen was not given the question (its agent exists, because a waiting message is sent through it, but it was told nothing).
    expect(w.told(chat.id)).toEqual([])
    // The message is in the log as the person's, once, and nothing waits.
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'user.message')).toHaveLength(2)
    expect(w.queued(chat.id)).toBe(0)
    expect(w.statusOf(chat.id)).toBe('working')
  })

  it('shows the Planner’s words and ends when there is no plan to read', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, 'Step one is a setting. Then use it.')
    expect(w.trail(chat.id).slice(1)).toEqual(['said 0 to person: Step one is a setting. Then use it.', 'ended unread (Planner did not answer in the form Celeste needs, so the run stopped.)'])
    expect(w.eventsOf(chat.id).some((e) => e.type === 'approval.requested')).toBe(false)
  })

  it('does not ask for a yes to a plan with no steps', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, plan('Nothing to do.', []))
    expect(w.endedOf(chat.id)[0]).toMatchObject({ why: 'unread' })
    expect(w.eventsOf(chat.id).some((e) => e.type === 'approval.requested')).toBe(false)
  })

  it('ends as failed when the Planner cannot answer, and as failed when the Builder cannot be asked to build', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    await w.childAnswers(chat.childId, 'Quota used up.', 'turn.failed')
    expect(w.trail(chat.id).slice(1)).toEqual(['ended failed (Quota used up.)'])
  })
})

describe('find and fix a bug', () => {
  it('asks the Tester first, then tells the Builder what it found and which files it changed, then has the Tester try again', async () => {
    const w = world()
    const chat = w.make('bug', { approval: 'edits' })
    w.say(chat.id, 'Saving loses the title')
    expect(w.agents.has(chat.id)).toBe(false)
    expect(w.told(chat.childId)[0]).toContain('You are the Tester')
    expect(w.told(chat.childId)[0]).toContain('You may add a failing test')
    expect(w.trail(chat.id)).toEqual(['turn 0 test'])

    // The Tester adds a failing test while it works.
    await w.childBegins(chat.childId)
    w.agent(chat.childId).emit({ type: 'tool.started', id: 't', kind: 'edit', title: 'Edit' })
    w.agent(chat.childId).emit({ type: 'tool.completed', id: 't', ok: true, diff: [diff('src/save.test.ts')] })
    await w.childEnds(chat.childId, test('The title is empty after saving.', true, { file: 'src/save.ts', line: 30, code: 'doc.title = ""' }))
    expect(w.trail(chat.id)).toEqual(['turn 0 test', 'said 0!: The title is empty after saving.', 'handed 0>1 1 file', 'turn 1 fix'])
    const told = w.told(chat.id)[0] as string
    expect(told).toContain('[From the Tester, another assistant in this chat. It is not the person’s words.]')
    expect(told).toContain('File: src/save.ts, line 30')
    expect(told).toContain('Code: doc.title = ""')
    expect(told).toContain('Keep that test: src/save.test.ts')

    await w.penWorks(chat.id, fix('Fixed the reset.', [{ n: 1, fixed: true, say: 'Saving no longer clears it.' }]), diff('src/save.ts'))
    expect(w.trail(chat.id).slice(4)).toEqual(['said 1: Fixed the reset.', 'said 1: Saving no longer clears it.', 'turn 0 retest', 'handed 1>0 the fix'])
    expect(w.told(chat.childId)[1]).toContain('Try again the same way.')

    await w.childAnswers(chat.childId, test('It passes now.', false))
    expect(w.trail(chat.id).slice(8)).toEqual(['said 0 to person: It passes now.', 'fixed m1', 'ended agreed'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('ends with a sentence when the Tester could not make it fail, and never starts the Builder', async () => {
    const w = world()
    const chat = w.make('bug')
    w.say(chat.id, 'Saving loses the title')
    await w.childAnswers(chat.childId, test('It works for me.', false))
    expect(w.trail(chat.id)).toEqual(['turn 0 test', 'said 0 to person: It works for me.', 'ended agreed (It did not fail.)'])
    expect(w.agents.has(chat.id)).toBe(false)
  })

  it('gives the Builder a second try when it still fails, with what the Tester saw this time, and the same bug is what gets fixed', async () => {
    const w = world()
    const chat = w.make('bug')
    w.say(chat.id, 'Saving loses the title')
    await w.childAnswers(chat.childId, test('Empty title.', true, { file: 'src/save.ts', line: 3 }))
    await w.penWorks(chat.id, fix('Tried.', [{ n: 1, fixed: true }]), diff('src/save.ts'))
    await w.childAnswers(chat.childId, test('Empty only after a rename.', true, { file: 'src/rename.ts', line: 8 }))
    expect(w.trail(chat.id).slice(-3)).toEqual(['said 0: Empty only after a rename.', 'handed 0>1 the bug', 'turn 1 fix'])
    const second = w.told(chat.id)[1] as string
    expect(second).toContain('Empty only after a rename.')
    expect(second).toContain('File: src/rename.ts, line 8')
    await w.penWorks(chat.id, fix('Found it.', [{ n: 1, fixed: true }]), diff('src/rename.ts'))
    await w.childAnswers(chat.childId, test('It passes now.', false))
    expect(w.trail(chat.id).slice(-3)).toEqual(['said 0 to person: It passes now.', 'fixed m1', 'ended agreed'])
  })

  it('stops after the second try when it still fails, with what is left', async () => {
    const w = world()
    const chat = w.make('bug')
    w.say(chat.id, 'Saving loses the title')
    await w.childAnswers(chat.childId, test('Empty title.', true, { file: 'src/save.ts', line: 3 }))
    await w.penWorks(chat.id, fix('Tried.', [{ n: 1, fixed: true }]), diff('src/save.ts'))
    await w.childAnswers(chat.childId, test('Still empty.', true))
    await w.penWorks(chat.id, fix('Tried more.', [{ n: 1, fixed: true }]), diff('src/save.ts'))
    await w.childAnswers(chat.childId, test('Empty even so.', true))
    expect(w.trail(chat.id).slice(-2)).toEqual(['said 0 to person: Empty even so.', 'ended rounds left 1'])
    // The Builder was asked twice, and is not asked again.
    expect(w.told(chat.id)).toHaveLength(2)
  })

  it('shows the Tester’s words when its block cannot be read', async () => {
    const w = world()
    const chat = w.make('bug')
    w.say(chat.id, 'Saving loses the title')
    await w.childAnswers(chat.childId, 'I could not run anything here.')
    expect(w.trail(chat.id).slice(1)).toEqual(['said 0 to person: I could not run anything here.', 'ended unread (Tester did not answer in the form Celeste needs, so the run stopped.)'])
  })
})

describe('two reviews', () => {
  it('gives the pen the review instruction and the other reviewer the same words, and compares when both have answered', async () => {
    const w = world()
    const chat = w.make('reviews')
    expect(chat.summary.approval).toBe('plan')
    w.say(chat.id, 'Review the login')
    const told = w.told(chat.id)[0] as string
    expect(told.startsWith('Review the login')).toBe(true)
    expect(told).toContain('You are Reviewer 1')
    expect(told).toContain('```moons')
    await flush()
    expect(w.told(chat.childId)[0]).toContain('You are Reviewer 2')
    expect(w.told(chat.childId)[0]).toContain('The person asked: “Review the login”')
    expect(w.told(chat.childId)[0]).toContain('cannot see each other’s work')
    // The other reviewer is not told what the first thinks, and the first is not told what the other thinks.
    expect(w.told(chat.id)).toHaveLength(1)

    await w.childAnswers(chat.childId, review('Two issues.', [{ text: 'Tokens never expire', file: 'auth.ts', line: 10 }, { text: 'No rate limit', file: 'auth.ts', line: 50 }]))
    expect(w.statusOf(chat.id)).toBe('working')
    expect(w.endedOf(chat.id)).toEqual([])
    await w.penWorks(chat.id, review('One issue.', [{ text: 'Tokens do not expire', file: 'auth.ts', line: 11 }]))
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'said 0 to person: One issue.', 'said 1 to person: Two issues.', 'compared 1/0/1', 'ended agreed'])
    expect(w.statusOf(chat.id)).toBe('idle')
    const compared = w.eventsOf(chat.id).find((e) => e.type === 'moons.compared') as Extract<LogEvent, { type: 'moons.compared' }>
    expect(compared.both).toEqual([{ text: 'Tokens do not expire', file: 'auth.ts', line: 11 }])
    expect(compared.second).toEqual([{ text: 'No rate limit', file: 'auth.ts', line: 50 }])
  })

  it('keeps the chat at work while only one reviewer is done, whichever is first, and queues nothing meanwhile', async () => {
    const w = world()
    const chat = w.make('reviews')
    w.say(chat.id, 'Review the login')
    await flush()
    w.say(chat.id, 'And the logout too', 'queue')
    await w.penWorks(chat.id, review('Fine.'))
    // The pen is done and the other reviewer is not: the chat is working, and nothing waiting went out.
    expect(w.statusOf(chat.id)).toBe('working')
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'turn 1 review'])
    expect(w.told(chat.id)).toHaveLength(1)
    expect(w.queued(chat.id)).toBe(1)
    await w.childAnswers(chat.childId, review('Also fine.'))
    // The run ends, and then the waiting message goes to the pen and begins another run.
    expect(w.trail(chat.id).slice(2)).toEqual(['said 0 to person: Fine.', 'said 1 to person: Also fine.', 'compared 0/0/0', 'ended agreed', 'turn 1 review'])
    expect(w.told(chat.id)).toHaveLength(2)
    expect(w.told(chat.id)[1]).toContain('And the logout too')
  })

  it('lists what one reviewer found when the other’s block cannot be read', async () => {
    const w = world()
    const chat = w.make('reviews')
    w.say(chat.id, 'Review the login')
    await flush()
    await w.childAnswers(chat.childId, 'It looks odd to me, but I am not sure.')
    await w.penWorks(chat.id, review('One issue.', [{ text: 'Tokens do not expire', file: 'auth.ts', line: 11 }]))
    expect(w.trail(chat.id).slice(1)).toEqual(['said 0 to person: One issue.', 'said 1 to person: It looks odd to me, but I am not sure.', 'compared 0/1/0', 'ended unread (Reviewer 2 did not answer in the form Celeste needs.)'])
  })

  it('ends as failed with the other reviewer’s sentence, after the pen has finished, and still lists what the pen found', async () => {
    const w = world()
    const chat = w.make('reviews')
    w.say(chat.id, 'Review the login')
    await flush()
    await w.penWorks(chat.id, review('One issue.', [{ text: 'Tokens do not expire' }]))
    expect(w.statusOf(chat.id)).toBe('working')
    await w.childAnswers(chat.childId, 'Limit reached until 3 pm.', 'turn.failed')
    expect(w.trail(chat.id).slice(2)).toEqual(['said 0 to person: One issue.', 'compared 0/1/0', 'ended failed (Limit reached until 3 pm.)'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('keeps the chat at work when the pen fails first, and ends when the other reviewer has answered', async () => {
    const w = world()
    const chat = w.make('reviews')
    w.say(chat.id, 'Review the login')
    await flush()
    await w.penBegins(chat.id)
    await w.penFails(chat.id, 'The service said no.')
    expect(w.statusOf(chat.id)).toBe('working')
    expect(w.endedOf(chat.id)).toEqual([])
    await w.childAnswers(chat.childId, review('Found one.', [{ text: 'A thing' }]))
    expect(w.trail(chat.id).slice(2)).toEqual(['said 1 to person: Found one.', 'compared 0/0/1', 'ended failed (The service said no.)'])
  })

  it('sends `@Reviewer 1` to the first reviewer alone and `@Reviewer 2` to the second alone', async () => {
    const w = world()
    const chat = w.make('reviews')
    w.say(chat.id, '@Reviewer 1 what did you mean by the last point?')
    await flush()
    expect(w.agents.has(chat.childId)).toBe(false)
    expect(w.told(chat.id)[0]).toContain('what did you mean')
    // Not a review, so no review instruction and no run.
    expect(w.told(chat.id)[0]).not.toContain('```moons')
    await w.penWorks(chat.id, 'I meant the token.')
    expect(w.trail(chat.id)).toEqual([])

    w.say(chat.id, '@Reviewer 2 and you?')
    await flush()
    expect(w.told(chat.childId)[0]).toContain('The person said: “and you?”')
    expect(w.trail(chat.id)).toEqual(['turn 1 answer'])
    await w.childAnswers(chat.childId, 'I saw nothing there.')
    expect(w.trail(chat.id)).toEqual(['turn 1 answer', 'said 1 to person: I saw nothing there.', 'ended agreed'])
  })
})

describe('writing to one moon', () => {
  it('sends `@Reviewer …` to the Reviewer alone, shows its answer as said to the person, and does not wake the pen', async () => {
    const w = world()
    const chat = await reviewing(w)
    await w.childAnswers(chat.childId, review('Fine.'))
    const before = w.trail(chat.id).length
    w.say(chat.id, '@reviewer why did you not mention the tests?')
    // The person's message is in the log as written; the pen was not given it.
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'user.message').pop()).toMatchObject({ text: '@reviewer why did you not mention the tests?' })
    expect(w.told(chat.id)).toHaveLength(1)
    expect(w.told(chat.childId)[1]).toContain('The person is writing to you, not to the Builder.')
    expect(w.told(chat.childId)[1]).toContain('The person said: “why did you not mention the tests?”')
    expect(w.trail(chat.id).slice(before)).toEqual(['turn 1 answer'])
    expect(w.statusOf(chat.id)).toBe('working')
    await w.childAnswers(chat.childId, 'There were none to mention.')
    expect(w.trail(chat.id).slice(before)).toEqual(['turn 1 answer', 'said 1 to person: There were none to mention.', 'ended agreed'])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('sends `@Builder …` to the pen alone, with no one to check it', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, '@Builder rename the file')
    expect(w.told(chat.id)[0]).toBe('@Builder rename the file')
    await w.penWorks(chat.id, 'Renamed.', diff('src/new-name.ts'))
    expect(w.trail(chat.id)).toEqual([])
    expect(w.agents.has(chat.childId)).toBe(false)
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('treats a name that is not at the start, or only part of a word, as ordinary words', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Ask the @Reviewer about it')
    expect(w.told(chat.id)).toHaveLength(1)
    await w.penWorks(chat.id, 'Done.', diff('a.ts'))
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
  })

  it('ends as failed when the Reviewer cannot answer a question', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, '@Reviewer hello?')
    await w.childAnswers(chat.childId, 'Out of messages.', 'turn.failed')
    expect(w.trail(chat.id)).toEqual(['turn 1 answer', 'ended failed (Out of messages.)'])
  })

  it('waits for the Reviewer to finish what the person gave it, then asks it', async () => {
    const w = world()
    const chat = w.make('build')
    // The person talked to the Reviewer in its own chat; it is working on that.
    w.say(chat.childId, 'Hello, can you look at the readme?')
    await w.childBegins(chat.childId)
    w.say(chat.id, '@Reviewer and the changelog?')
    expect(w.told(chat.childId)).toHaveLength(1)
    await w.childEnds(chat.childId, 'The readme is fine.')
    expect(w.told(chat.childId)).toHaveLength(2)
    expect(w.told(chat.childId)[1]).toContain('and the changelog?')
    await w.childAnswers(chat.childId, 'Fine too.')
    expect(w.trail(chat.id)).toEqual(['turn 1 answer', 'said 1 to person: Fine too.', 'ended agreed'])
  })
})

describe('Stop in the chat', () => {
  type Case = { name: string; reach: (w: World) => Promise<{ id: string; childId: string }>; childWorks: boolean }
  const cases: Case[] = [
    {
      name: 'while the Builder builds',
      childWorks: false,
      reach: async (w) => {
        const chat = w.make('build')
        w.say(chat.id, 'Add a check')
        await w.penBegins(chat.id)
        return chat
      }
    },
    { name: 'while the Reviewer reviews', childWorks: true, reach: reviewing },
    { name: 'while the Builder fixes', childWorks: false, reach: async (w) => {
      const chat = await fixing(w)
      await w.penBegins(chat.id)
      return chat
    } },
    {
      name: 'while the Reviewer checks',
      childWorks: true,
      reach: async (w) => {
        const chat = await fixing(w)
        await w.penWorks(chat.id, fix('Done.', [{ n: 1, fixed: true }]), diff('src/names.ts', 'more'))
        return chat
      }
    },
    {
      name: 'while the Planner plans',
      childWorks: true,
      reach: async (w) => {
        const chat = w.make('plan')
        w.say(chat.id, 'Add a dark mode')
        return chat
      }
    },
    {
      name: 'while the plan waits for the person',
      childWorks: false,
      reach: async (w) => {
        const chat = w.make('plan')
        w.say(chat.id, 'Add a dark mode')
        await w.childAnswers(chat.childId, plan('The plan.', ['One', 'Two']))
        return chat
      }
    },
    {
      name: 'while the Tester tests',
      childWorks: true,
      reach: async (w) => {
        const chat = w.make('bug')
        w.say(chat.id, 'Saving loses the title')
        return chat
      }
    },
    {
      name: 'while the Builder fixes a bug',
      childWorks: false,
      reach: async (w) => {
        const chat = w.make('bug')
        w.say(chat.id, 'Saving loses the title')
        await w.childAnswers(chat.childId, test('Empty.', true))
        await w.penBegins(chat.id)
        return chat
      }
    },
    {
      name: 'while the Tester tries again',
      childWorks: true,
      reach: async (w) => {
        const chat = w.make('bug')
        w.say(chat.id, 'Saving loses the title')
        await w.childAnswers(chat.childId, test('Empty.', true))
        await w.penWorks(chat.id, fix('Fixed.', [{ n: 1, fixed: true }]))
        return chat
      }
    },
    {
      name: 'while both reviewers work',
      childWorks: true,
      reach: async (w) => {
        const chat = w.make('reviews')
        w.say(chat.id, 'Review the login')
        await flush()
        await w.penBegins(chat.id)
        return chat
      }
    }
  ]

  for (const c of cases) {
    it(`ends the run as stopped, ignores what the two agents do late, and leaves the chat idle: ${c.name}`, async () => {
      const w = world()
      const chat = await c.reach(w)
      const childAgent = w.agents.get(chat.childId)
      const stoppedBefore = childAgent?.interrupted ?? 0
      w.api['sessions.interrupt'](chat.id)
      await settle()
      const trail = w.trail(chat.id)
      expect(trail.filter((t) => t.startsWith('ended'))).toEqual(['ended stopped'])
      expect(trail[trail.length - 1]).toBe('ended stopped')
      expect(w.statusOf(chat.id)).toBe('idle')
      // A pen that never ran has no turn to end, so the log does not claim one was stopped.
      if (!w.agents.has(chat.id)) expect(w.types(chat.id)).not.toContain('turn.interrupted')
      // The other moon was stopped if it was working.
      if (c.childWorks) expect((w.agents.get(chat.childId)?.interrupted ?? 0) - stoppedBefore).toBe(1)
      else expect((w.agents.get(chat.childId)?.interrupted ?? 0) - stoppedBefore).toBe(0)

      // Whatever the two agents still say or finish now changes nothing.
      const length = w.eventsOf(chat.id).length
      const sentToPen = w.agents.get(chat.id)?.sent.length ?? 0
      const sentToChild = w.agents.get(chat.childId)?.sent.length ?? 0
      if (w.agents.has(chat.id)) await w.penEnds(chat.id, review('Late.'), 'turn.interrupted')
      if (w.agents.has(chat.childId)) await w.childEnds(chat.childId, review('Late.', [{ text: 'Too late' }]), 'turn.interrupted')
      expect(w.trail(chat.id)).toEqual(trail)
      expect(w.agents.get(chat.id)?.sent.length ?? 0).toBe(sentToPen)
      expect(w.agents.get(chat.childId)?.sent.length ?? 0).toBe(sentToChild)
      expect(w.statusOf(chat.id)).toBe('idle')
      expect(w.eventsOf(chat.id).slice(length).filter((e) => e.type.startsWith('moons.'))).toEqual([])
    })
  }

  it('ignores a late answer of a stopped Reviewer, even a good one', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.api['sessions.interrupt'](chat.id)
    await settle()
    const trail = w.trail(chat.id)
    await w.childEnds(chat.childId, review('Looks right to me.'))
    expect(w.trail(chat.id)).toEqual(trail)
    expect(w.told(chat.id)).toHaveLength(1)
  })

  it('holds what waits in the queue, and does not send it', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.say(chat.id, 'Also add a test', 'queue')
    expect(w.queued(chat.id)).toBe(1)
    w.api['sessions.interrupt'](chat.id)
    await settle()
    expect(w.eventsOf(chat.id).some((e) => e.type === 'queue.paused')).toBe(true)
    expect(w.queued(chat.id)).toBe(1)
    expect(w.told(chat.id)).toHaveLength(1)
  })
})

describe('Stop in the other moon’s own chat', () => {
  it('ends the run as failed when the Reviewer is stopped while it works for the run, and ignores its late end', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.api['sessions.interrupt'](chat.childId)
    await settle()
    expect(w.trail(chat.id).slice(2)).toEqual(['ended failed (Reviewer was stopped.)'])
    expect(w.statusOf(chat.id)).toBe('idle')
    const trail = w.trail(chat.id)
    await w.childEnds(chat.childId, review('Late.'), 'turn.interrupted')
    expect(w.trail(chat.id)).toEqual(trail)
  })

  it('does not end the run when the Reviewer is stopped while it works on something the person gave it', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    await w.penBegins(chat.id)
    w.say(chat.childId, 'Please read the readme')
    await w.childBegins(chat.childId)
    w.api['sessions.interrupt'](chat.childId)
    await w.childEnds(chat.childId, '', 'turn.interrupted')
    expect(w.trail(chat.id)).toEqual([])
    expect(w.statusOf(chat.id)).toBe('working')
    w.penEdits(chat.id, diff('a.ts'))
    await w.penEnds(chat.id, 'Added.')
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
  })
})

describe('deleting', () => {
  it('ends the run when the chat is deleted, and stops the other moon', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.api['sessions.remove'](chat.id)
    await settle()
    const events = w.store.events(chat.id).map((e) => e.event)
    expect(events.filter((e) => e.type === 'moons.ended')).toEqual([{ type: 'moons.ended', why: 'stopped' }])
    expect(w.agents.get(chat.childId)?.closed).toBe(true)
    // A late answer is ignored, and bringing the chat back shows it idle.
    await w.childEnds(chat.childId, review('Late.'))
    expect(w.store.events(chat.id).filter((e) => e.event.type === 'moons.ended')).toHaveLength(1)
    w.api['sessions.restore'](chat.id)
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('fails the run when the other moon is deleted, and the chat goes on alone', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.api['sessions.remove'](chat.childId)
    await settle()
    expect(w.trail(chat.id).slice(2)).toEqual(['ended failed (Reviewer was deleted.)'])
    expect(w.statusOf(chat.id)).toBe('idle')
    // The chat works with one agent now: no review follows its turn.
    w.say(chat.id, 'Add another check')
    await w.penWorks(chat.id, 'Added.', diff('src/other.ts'))
    expect(w.trail(chat.id).slice(3)).toEqual([])
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('fails the run when the other moon is deleted while the pen works, and carries on with what the pen does', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    await w.penBegins(chat.id)
    w.api['sessions.remove'](chat.childId)
    await settle()
    // The run waits for the pen, not the Reviewer: a deleted Reviewer is found out when it is needed.
    await w.penEnds(chat.id, 'Added.')
    expect(w.trail(chat.id).every((t) => !t.startsWith('said'))).toBe(true)
    expect(w.statusOf(chat.id)).toBe('idle')
  })
})

describe('stop and send, and a message that waits', () => {
  it('sends a waiting message after the run, and not before', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.say(chat.id, 'Next, rename the file', 'queue')
    expect(w.queued(chat.id)).toBe(1)
    expect(w.told(chat.id)).toHaveLength(1)
    await w.childAnswers(chat.childId, review('Fine.'))
    const types = w.types(chat.id)
    expect(types.indexOf('queue.sent')).toBeGreaterThan(types.indexOf('moons.ended'))
    expect(w.told(chat.id)).toHaveLength(2)
    expect(w.told(chat.id)[1]).toContain('Next, rename the file')
    // It began a run of its own: the Builder's line is with it.
    expect(w.told(chat.id)[1]).toContain('You are the Builder')
    expect(w.queued(chat.id)).toBe(0)
  })

  it('never sends a waiting message while the other moon works, though the pen’s turn has ended (no moment of idle)', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    w.say(chat.id, 'And a test', 'queue')
    await w.penWorks(chat.id, 'Added.', diff('a.ts'))
    const types = w.types(chat.id)
    const completed = types.lastIndexOf('turn.completed')
    // The very next thing in the log after the pen's turn is the other moon's turn.
    expect(types[completed + 1]).toBe('moons.turn')
    expect(types.includes('queue.sent')).toBe(false)
    expect(w.statusOf(chat.id)).toBe('working')
  })

  it('stops and sends while the other moon works and the pen is live and idle: the run ends and the message starts a new one', async () => {
    const w = world()
    const chat = await reviewing(w)
    expect(w.agents.has(chat.id)).toBe(true)
    w.say(chat.id, 'Forget that, do it another way', 'stop')
    await settle()
    expect(w.trail(chat.id).slice(2)).toEqual(['ended stopped'])
    expect(w.agents.get(chat.childId)?.interrupted).toBe(1)
    expect(w.told(chat.id)).toHaveLength(2)
    expect(w.told(chat.id)[1]).toContain('Forget that, do it another way')
    expect(w.told(chat.id)[1]).toContain('You are the Builder')
    expect(w.queued(chat.id)).toBe(0)
    // The new run goes on as any other.
    await w.penWorks(chat.id, 'Done another way.', diff('b.ts'))
    expect(w.trail(chat.id).slice(3)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
  })

  it('stops and sends while the other moon works and no pen has ever run: the message goes to the Planner', async () => {
    const w = world()
    const chat = w.make('plan')
    w.say(chat.id, 'Add a dark mode')
    expect(w.agents.has(chat.id)).toBe(false)
    w.say(chat.id, 'Actually, make it a switch', 'stop')
    await settle()
    expect(w.trail(chat.id)).toEqual(['turn 0 plan', 'ended stopped', 'turn 0 plan'])
    expect(w.agents.get(chat.childId)?.interrupted).toBe(1)
    expect(w.statusOf(chat.id)).toBe('working')
    // The Planner still ends the turn that was stopped; that end is not the answer to the new message.
    expect(w.told(chat.childId)).toHaveLength(1)
    await w.childEnds(chat.childId, plan('The old plan.', ['Old']), 'turn.interrupted')
    expect(w.told(chat.childId)).toHaveLength(2)
    expect(w.told(chat.childId)[1]).toContain('Actually, make it a switch')
    expect(w.eventsOf(chat.id).some((e) => e.type === 'moons.plan')).toBe(false)
    await w.childAnswers(chat.childId, plan('The new plan.', ['Add a switch', 'Use it']))
    expect(w.trail(chat.id).slice(-1)).toEqual(['plan 2 steps'])
  })

  it('ends a run that is still open when a message comes with no mode, before it begins the next, so there are never two at once', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.say(chat.id, 'Something for later', 'queue')
    w.say(chat.id, 'Never mind, rename it')
    const trail = w.trail(chat.id)
    expect(trail.slice(2)).toEqual(['ended stopped'])
    expect(w.agents.get(chat.childId)?.interrupted).toBe(1)
    expect(w.told(chat.id)).toHaveLength(2)
    // The old review's end, when it comes, is not an answer to anything.
    await w.childEnds(chat.childId, review('Old.', [{ text: 'Too late' }]), 'turn.interrupted')
    expect(w.trail(chat.id)).toEqual(trail)
    await w.penWorks(chat.id, 'Renamed.', diff('b.ts'))
    expect(w.trail(chat.id).slice(3)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
    // A second run does not pause what was waiting: stopping here was not the person's Stop.
    expect(w.eventsOf(chat.id).some((e) => e.type === 'queue.paused')).toBe(false)
  })

  it('does not pause the rest of the queue when a message is sent now', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.say(chat.id, 'Later one', 'queue')
    w.say(chat.id, 'Right now', 'stop')
    await settle()
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'queue.paused')).toHaveLength(1)
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'queue.resumed')).toHaveLength(1)
    expect(w.queued(chat.id)).toBe(1)
    // The run that the message began ends, and then the one that waited goes.
    await w.penWorks(chat.id, 'Done.')
    expect(w.told(chat.id).some((t) => t.startsWith('Later one'))).toBe(true)
  })

  it('treats steering as waiting while the other moon works, and as steering while the pen itself works', async () => {
    const w = world({ steer: true })
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    await w.penBegins(chat.id)
    w.say(chat.id, 'Use a regex', 'steer')
    expect(w.agent(chat.id).sent).toHaveLength(1)
    expect((w.agent(chat.id) as unknown as { steered: unknown[] }).steered).toHaveLength(1)
    expect(w.queued(chat.id)).toBe(0)
    w.penEdits(chat.id, diff('a.ts'))
    await w.penEnds(chat.id, 'Added.')
    // Now the Reviewer works and the pen does not: there is nothing to steer.
    w.say(chat.id, 'Also the readme', 'steer')
    expect((w.agent(chat.id) as unknown as { steered: unknown[] }).steered).toHaveLength(1)
    expect(w.queued(chat.id)).toBe(1)
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(w.told(chat.id)).toHaveLength(2)
    expect(w.told(chat.id)[1]).toContain('Also the readme')
  })
})

describe('the other moon’s own chat', () => {
  it('takes the answer of the turn the run asked, not of one the person typed meanwhile, and waits for the right end', async () => {
    const w = world()
    const chat = await reviewing(w)
    // The person types into the Reviewer's own chat while it works for the run: it waits in that chat's own queue.
    w.say(chat.childId, 'Also look at the tests', 'queue')
    expect(w.queued(chat.childId)).toBe(1)
    await w.childEnds(chat.childId, review('Looks right.'))
    expect(w.trail(chat.id).slice(2)).toEqual(['said 1: Looks right.', 'ended agreed'])
    // Its own queue sent the person's message after the run's turn, and that is not the run's business.
    expect(w.told(chat.childId)).toHaveLength(2)
    expect(w.told(chat.childId)[1]).toContain('Also look at the tests')
    await w.childEnds(chat.childId, 'The tests are fine.')
    expect(w.trail(chat.id)).toHaveLength(4)
  })

  it('takes the answer of one turn once, though the other moon ends another turn while the run waits for the pen', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.say(chat.childId, 'Also look at the tests', 'queue')
    await w.childEnds(chat.childId, review('One note.', [{ text: 'Check the empty case' }]))
    const trail = w.trail(chat.id)
    expect(trail.slice(2)).toEqual(['said 1: One note.', 'said 1!: Check the empty case', 'handed 1>0 1 note', 'turn 0 fix'])
    // The person's message goes out of the Reviewer's own queue and is answered. The run is waiting for the Builder and does not care.
    await w.childEnds(chat.childId, 'The tests are fine.')
    expect(w.trail(chat.id)).toEqual(trail)
    expect(w.told(chat.id)).toHaveLength(2)
  })

  it('does not react to a turn of the other moon that the run did not begin', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    await w.penBegins(chat.id)
    // The person talks to the Reviewer meanwhile, and it answers.
    w.say(chat.childId, 'Hello')
    await w.childAnswers(chat.childId, review('Hello! Nothing yet.'))
    expect(w.trail(chat.id)).toEqual([])
    expect(w.statusOf(chat.id)).toBe('working')
    w.penEdits(chat.id, diff('a.ts'))
    await w.penEnds(chat.id, 'Added.')
    // The run's own ask waited for the Reviewer to be free, and it was.
    expect(w.told(chat.childId)).toHaveLength(2)
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(w.trail(chat.id).slice(2)).toEqual(['said 1: Fine.', 'ended agreed'])
  })
})

describe('two chats at once', () => {
  it('keeps the runs of two chats apart', async () => {
    const w = world()
    const a = w.make('build', { title: 'A' })
    const b = w.make('build', { title: 'B' })
    w.say(a.id, 'Request A')
    w.say(b.id, 'Request B')
    await w.penWorks(a.id, 'Did A.', diff('a.ts'))
    await w.penWorks(b.id, 'Did B.', diff('b.ts'))
    expect(w.told(a.childId)[0]).toContain('The person asked: “Request A”')
    expect(w.told(a.childId)[0]).toContain('File: a.ts')
    expect(w.told(b.childId)[0]).toContain('The person asked: “Request B”')
    expect(w.told(b.childId)[0]).toContain('File: b.ts')
    expect(w.told(b.childId)[0]).not.toContain('a.ts')
    // B's Reviewer answers first, with a note; only B's pen is told.
    await w.childAnswers(b.childId, review('One note.', [{ text: 'Check B' }]))
    expect(w.told(b.id)).toHaveLength(2)
    expect(w.told(a.id)).toHaveLength(1)
    expect(w.trail(a.id)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
    await w.childAnswers(a.childId, review('A is fine.'))
    expect(w.trail(a.id).slice(2)).toEqual(['said 1: A is fine.', 'ended agreed'])
    expect(w.statusOf(b.id)).toBe('working')
    // Stopping A does nothing to B.
    w.say(a.id, 'Another A')
    w.api['sessions.interrupt'](a.id)
    await settle()
    expect(w.endedOf(b.id)).toEqual([])
    expect(w.statusOf(b.id)).toBe('working')
  })

  it('does not change how a chat with one agent works, while another chat has a run', async () => {
    const w = world()
    const two = w.make('build')
    const one = w.api['sessions.create']({ vendor: 'claude', mode: 'chat', title: 'Plain', model: 'claude:sonnet', effort: null, approval: 'auto' })
    w.say(two.id, 'Add a check')
    await w.penBegins(two.id)
    expect(w.service.isBusy(one.id)).toBe(false)
    expect(w.service.isBusy(two.id)).toBe(true)
    w.say(one.id, 'Hello')
    // The words go as they are, with nothing added.
    expect(w.told(one.id)).toEqual(['Hello'])
    expect(w.service.isBusy(one.id)).toBe(true)
    await w.penBegins(one.id)
    await w.penEnds(one.id, 'Hi.')
    expect(w.trail(one.id)).toEqual([])
    expect(w.statusOf(one.id)).toBe('idle')
    expect(w.service.isBusy(one.id)).toBe(false)
  })
})

describe('what the log and the checkpoints look like', () => {
  it('is busy while the other moon works, though the pen’s own agent runs nothing, and not otherwise', async () => {
    const w = world()
    const chat = w.make('build')
    expect(w.service.isBusy(chat.id)).toBe(false)
    w.say(chat.id, 'Add a check')
    expect(w.service.isBusy(chat.id)).toBe(true)
    await w.penWorks(chat.id, 'Added.', diff('a.ts'))
    expect(w.agent(chat.id).interrupted).toBe(0)
    expect(w.service.isBusy(chat.id)).toBe(true)
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(w.service.isBusy(chat.id)).toBe(false)
  })

  it('makes one checkpoint for the person’s message, and none for what Celeste tells the pen for the other moon', async () => {
    const snaps = new ScriptedSnapshots()
    snaps.files = [diff('src/names.ts')]
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    await w.penWorks(chat.id, 'Added.', diff('src/names.ts'))
    await w.childAnswers(chat.childId, review('One note.', [{ text: 'Check more' }]))
    await settle()
    expect(w.told(chat.id)).toHaveLength(2)
    await w.penWorks(chat.id, fix('Done.', [{ n: 1, fixed: true }]), diff('src/names.ts', 'more'))
    await w.childAnswers(chat.childId, review('Good.'))
    const created = w.eventsOf(chat.id).filter((e) => e.type === 'checkpoint.created')
    expect(created).toHaveLength(1)
    // What was saved: before the person's message, and after each of the pen's turns (for the list of what the message changed).
    expect(snaps.taken).toHaveLength(3)
    // The Reviewer is shown the difference from that one checkpoint to now, both times.
    const from = (created[0] as { id: string }).id
    expect(snaps.diffCalls).toEqual([{ from, to: null }, { from, to: null }])
    expect(w.trail(chat.id).at(-1)).toBe('ended agreed')
    // The helper in the same folder saves nothing of its own.
    expect(w.eventsOf(chat.childId).some((e) => e.type === 'checkpoint.created')).toBe(false)
  })

  it('refuses to revert while the other moon works', async () => {
    const snaps = new ScriptedSnapshots()
    snaps.files = [diff('a.ts')]
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    await w.penWorks(chat.id, 'Added.', diff('a.ts'))
    const id = (w.eventsOf(chat.id).find((e) => e.type === 'checkpoint.created') as { id: string }).id
    await expect(w.api['sessions.revert'](chat.id, id)).rejects.toThrow('Wait for the answer to finish')
    await w.childAnswers(chat.childId, review('Fine.'))
    await expect(w.api['sessions.revert'](chat.id, id)).resolves.toMatchObject({ restored: 0 })
  })

  it('shows the Reviewer the difference between the folders (Develop), and not only the tools’ own account', async () => {
    const snaps = new ScriptedSnapshots()
    snaps.files = [diff('from-git.ts', 'real change')]
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    await w.penWorks(chat.id, 'Added.', diff('from-tools.ts'))
    const asked = w.told(chat.childId)[0] as string
    expect(asked).toContain('Files changed: from-git.ts')
    expect(asked).toContain('+real change')
    expect(asked).not.toContain('from-tools.ts')
  })

  it('falls back to the tools’ own account when comparing the folders fails, and does not end the run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const snaps = new ScriptedSnapshots()
    snaps.mode = 'throw'
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    await w.penWorks(chat.id, 'Added.', diff('from-tools.ts'))
    expect(w.told(chat.childId)[0]).toContain('Files changed: from-tools.ts')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[core]'), expect.anything())
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(w.trail(chat.id).at(-1)).toBe('ended agreed')
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('falls back to the tools’ own account when comparing the folders hangs, after the same wait the checkpoints allow', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const snaps = new ScriptedSnapshots()
    snaps.mode = 'hang'
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    await w.penWorks(chat.id, 'Added.', diff('from-tools.ts'))
    expect(w.statusOf(chat.id)).toBe('working')
    expect(w.agents.has(chat.childId)).toBe(false)
    await vi.advanceTimersByTimeAsync(89_000)
    expect(w.agents.has(chat.childId)).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(w.told(chat.childId)[0]).toContain('Files changed: from-tools.ts')
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(w.trail(chat.id).at(-1)).toBe('ended agreed')
    expect(w.statusOf(chat.id)).toBe('idle')
  })

  it('uses the tools’ own account when the message has no checkpoint (saving the folder failed)', async () => {
    const snaps = new ScriptedSnapshots()
    snaps.takeFails = true
    snaps.files = [diff('from-git.ts')]
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    expect(w.eventsOf(chat.id).some((e) => e.type === 'checkpoint.skipped')).toBe(true)
    await w.penWorks(chat.id, 'Added.', diff('from-tools.ts'))
    expect(w.told(chat.childId)[0]).toContain('Files changed: from-tools.ts')
    expect(snaps.diffCalls).toEqual([])
  })

  it('counts the changes since the person’s last message only, by file, with later edits added to earlier ones (a chat with no project)', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'First')
    await w.penWorks(chat.id, 'One.', diff('old.ts'))
    await w.childAnswers(chat.childId, review('Fine.'))
    w.say(chat.id, 'Second')
    await w.penBegins(chat.id)
    w.penEdits(chat.id, diff('a.ts', 'one'), diff('a.ts', 'two'), diff('b.ts'))
    await w.penEnds(chat.id, 'Two.')
    const files = await w.service.turnChanges(chat.id)
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    expect((files[0] as { added: number }).added).toBe(2)
    expect((files[0] as { hunks: unknown[] }).hunks).toHaveLength(2)
  })

  it('names the files a chat wrote with no lines to show', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Make a report')
    await w.penBegins(chat.id)
    w.store.appendEvent(chat.id, 1, { type: 'files.produced', files: [{ path: 'report.md', size: 100, status: 'added' }], more: 0 })
    const files = await w.service.turnChanges(chat.id)
    expect(files).toEqual([{ path: 'report.md', status: 'added', added: 0, removed: 0, hunks: [] }])
  })

  it('does not count what an earlier turn changed when the later turn changed nothing', async () => {
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'First')
    await w.penWorks(chat.id, 'One.', diff('old.ts'))
    await w.childAnswers(chat.childId, review('Fine.'))
    w.say(chat.id, 'Just a question')
    await w.penWorks(chat.id, 'The answer is no.')
    expect(w.trail(chat.id).at(-1)).toBe('ended nothing')
  })
})

describe('restarting', () => {
  it('leaves a chat idle after a crash in the middle of a run, with nothing restarted, and the next message begins a fresh run', async () => {
    const store = new MemoryStore()
    const first = world({ store })
    const chat = await reviewing(first)
    expect(first.statusOf(chat.id)).toBe('working')

    const second = world({ store })
    expect(second.statusOf(chat.id)).toBe('idle')
    expect(second.eventsOf(chat.id).at(-1)).toEqual({ type: 'turn.abandoned' })
    expect(second.agents.size).toBe(0)
    expect(second.service.isBusy(chat.id)).toBe(false)
    second.say(chat.id, 'Try again')
    await second.penWorks(chat.id, 'Done.', diff('a.ts'))
    expect(second.trail(chat.id).slice(-2)).toEqual(['turn 1 review', 'handed 0>1 1 file'])
  })

  it('leaves a chat idle when it was waiting for a yes to a plan', async () => {
    const store = new MemoryStore()
    const first = world({ store })
    const chat = first.make('plan')
    first.say(chat.id, 'Add a dark mode')
    await first.childAnswers(chat.childId, plan('The plan.', ['One', 'Two']))
    expect(first.statusOf(chat.id)).toBe('waiting')
    const second = world({ store })
    expect(second.statusOf(chat.id)).toBe('idle')
  })
})

describe('what the engine writes', () => {
  it('writes nothing to the console in normal use', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const w = world()
    const chat = await fixing(w)
    await w.penWorks(chat.id, fix('Done.', [{ n: 1, fixed: true }, { n: 2, fixed: true }]), diff('src/names.ts', 'more'))
    await w.childAnswers(chat.childId, review('Good.'))
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('ends the run as failed and says so on the console when something inside breaks, so a chat is never left working', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const w = world()
    const chat = w.make('build')
    w.say(chat.id, 'Add a check')
    vi.spyOn(w.service, 'turnChanges').mockRejectedValue(new Error('boom'))
    await w.penWorks(chat.id, 'Added.', diff('a.ts'))
    await settle()
    expect(w.trail(chat.id).at(-1)).toBe('ended failed (Something went wrong inside Celeste, so the two moons stopped.)')
    expect(w.statusOf(chat.id)).toBe('idle')
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[core\]/), expect.any(Error))
  })

  it('writes its events as the other moon’s and the pen’s seats, the way the pattern says', async () => {
    const w = world()
    const chat = await fixing(w)
    const seats = w.eventsOf(chat.id).flatMap((e) => (e.type === 'moons.said' || e.type === 'moons.turn' ? [`${e.type}:${e.seat}`] : []))
    expect(seats).toEqual(['moons.turn:1', 'moons.said:1', 'moons.said:1', 'moons.said:1', 'moons.turn:0'])
  })
})

describe('what the review of the engine found', () => {
  const picture = { id: 'a1', name: 'bug.png', size: 10, mime: 'image/png' }
  const card = (w: World, id: string) => (w.eventsOf(id).findLast((e) => e.type === 'approval.requested') as { requestId: string }).requestId

  it('gives what the person attached to both moons, once each, though no message of the person’s went to either', async () => {
    const w = world()
    const chat = w.make('plan')
    w.api['sessions.send'](chat.id, { text: 'Make it look like this', attachments: [picture as never] })
    expect(w.agent(chat.childId).sent[0]?.attachments).toEqual([picture])
    await w.childAnswers(chat.childId, plan('A plan.', ['One']))
    w.api['sessions.respondApproval'](chat.id, card(w, chat.id), { allow: true, always: false })
    await settle()
    expect(w.agent(chat.id).sent[0]?.attachments).toEqual([picture])
    // In the logs it is only with the person's own message.
    const logged = (id: string) => w.eventsOf(id).flatMap((e) => (e.type === 'user.message' ? [e.attachments.length] : []))
    expect(logged(chat.id)).toEqual([1, 0])
    expect(logged(chat.childId)).toEqual([0])
  })

  it('gives the Reviewer the picture the Builder was given, with the first review and not again', async () => {
    const w = world()
    const chat = w.make('build')
    w.api['sessions.send'](chat.id, { text: 'Make it look like this', attachments: [picture as never] })
    await w.penWorks(chat.id, 'Done.', diff('a.ts'))
    expect(w.agent(chat.childId).sent[0]?.attachments).toEqual([picture])
    await w.childAnswers(chat.childId, review('One note.', [{ text: 'The colour is wrong' }]))
    expect(w.agent(chat.id).sent[1]?.attachments).toEqual([])
    await w.penWorks(chat.id, fix('Fixed.', [{ n: 1, fixed: true }]), diff('a.ts'))
    expect(w.agent(chat.childId).sent[1]?.attachments).toEqual([])
  })

  it('tells the other moon about the project files the person added', async () => {
    const w = world({ snapshots: new ScriptedSnapshots() })
    const chat = w.make('bug', { mode: 'develop', cwd: '/proj' })
    w.api['sessions.send'](chat.id, { text: 'This one is broken', attachments: [], context: [{ path: 'src/save.ts', kind: 'file' }] })
    await settle()
    expect(w.told(chat.childId)[0]).toContain('src/save.ts')
    await w.childAnswers(chat.childId, test('It fails.', true))
    await settle()
    expect(w.told(chat.id)[0]).toContain('[Files and folders from the project that the person added as context.')
  })

  it('saves the folder for a message that goes to the Tester first, before the Tester is asked, so that the message can be reverted', async () => {
    const snaps = new ScriptedSnapshots()
    const w = world({ snapshots: snaps })
    const chat = w.make('bug', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Saving loses the title')
    expect(w.agents.has(chat.childId)).toBe(false)
    await settle()
    expect(w.types(chat.id)).toEqual(['user.message', 'moons.turn', 'checkpoint.created'])
    expect(w.told(chat.childId)).toHaveLength(1)
    await w.childAnswers(chat.childId, test('It fails.', true))
    await settle()
    await w.penWorks(chat.id, fix('Fixed.', [{ n: 1, fixed: true }]), diff('a.ts'))
    await settle()
    const made = w.eventsOf(chat.id).filter((e) => e.type === 'checkpoint.created')
    expect(made).toHaveLength(1)
    expect(w.eventsOf(chat.id).filter((e) => e.type === 'checkpoint.summary')).toMatchObject([{ id: (made[0] as { id: string }).id }])
    await w.childAnswers(chat.childId, test('It passes now.', false))
    await expect(w.api['sessions.revert'](chat.id, (made[0] as { id: string }).id)).resolves.toMatchObject({ restored: 0 })
  })

  it('asks nobody when the person stops while the folder is still being saved', async () => {
    const w = world({ snapshots: new ScriptedSnapshots() })
    const chat = w.make('bug', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Saving loses the title')
    w.api['sessions.interrupt'](chat.id)
    await settle()
    expect(w.agents.has(chat.childId)).toBe(false)
    expect(w.statusOf(chat.id)).toBe('idle')
    expect(w.trail(chat.id)).toEqual(['turn 0 test', 'ended stopped'])
  })

  it('counts what a fix changed with the person’s message, not only what the first turn changed', async () => {
    const snaps = new ScriptedSnapshots()
    snaps.files = [diff('a.ts')]
    const w = world({ snapshots: snaps })
    const chat = w.make('build', { mode: 'develop', cwd: '/proj' })
    w.say(chat.id, 'Add a check')
    await settle()
    await w.penWorks(chat.id, 'Added.', diff('a.ts'))
    await settle()
    await w.childAnswers(chat.childId, review('One note.', [{ text: 'Check more' }]))
    await settle()
    await w.penWorks(chat.id, fix('Done.', [{ n: 1, fixed: true }]), diff('b.ts'))
    await settle()
    const made = w.eventsOf(chat.id).find((e) => e.type === 'checkpoint.created') as { id: string }
    expect(w.eventsOf(chat.id).flatMap((e) => (e.type === 'checkpoint.summary' ? [e.id] : []))).toEqual([made.id, made.id])
  })

  it('takes the Tester along when the chat is made stricter or looser, and nobody else', () => {
    const w = world()
    const bug = w.make('bug', { approval: 'auto' })
    w.api['sessions.update'](bug.id, { approval: 'plan' })
    expect(w.store.getSession(bug.childId)).toMatchObject({ approval: 'plan', spawn: { ceiling: 'plan', moon: true, parentId: bug.id } })
    w.api['sessions.update'](bug.id, { approval: 'edits' })
    expect(w.store.getSession(bug.childId)).toMatchObject({ approval: 'edits', spawn: { ceiling: 'edits' } })
    const build = w.make('build', { approval: 'ask' })
    w.api['sessions.update'](build.id, { approval: 'auto' })
    expect(w.store.getSession(build.childId)).toMatchObject({ approval: 'plan', spawn: { ceiling: 'plan' } })
  })

  it('keeps a chat of two reviews in plan mode when the person answers a card with “don’t ask again”', async () => {
    const w = world()
    const chat = w.make('reviews')
    w.say(chat.id, 'Review the login')
    w.agent(chat.id).emit({ type: 'approval.requested', requestId: 'r1', action: { kind: 'other', title: 'Something' } } as never)
    await settle()
    w.api['sessions.respondApproval'](chat.id, 'r1', { allow: true, always: true })
    expect(w.store.getSession(chat.id)?.approval).toBe('plan')
  })

  it('tells whoever kept an answer for the chat that it is idle, when a run ends after the other moon', async () => {
    const w = world()
    const idle = vi.spyOn(w.subs, 'onIdle')
    const chat = await reviewing(w)
    expect(idle.mock.calls.filter(([id]) => id === chat.id)).toEqual([])
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(idle.mock.calls.filter(([id]) => id === chat.id)).toEqual([[chat.id, 'turn.completed']])
  })

  it('does not interrupt an agent that runs nothing when the person stops, or sends now, while the Reviewer looks', async () => {
    const w = world()
    const chat = await reviewing(w)
    w.api['sessions.interrupt'](chat.id)
    await settle()
    expect(w.agent(chat.id).interrupted).toBe(0)
    expect(w.agent(chat.childId).interrupted).toBe(1)
    expect(w.statusOf(chat.id)).toBe('idle')
    const other = await reviewing(w)
    w.say(other.id, 'Do this instead', 'stop')
    await settle()
    expect(w.agent(other.id).interrupted).toBe(0)
    expect(w.told(other.id).at(-1)).toContain('Do this instead')
  })

  it('leaves no run open when the message that began it could not be sent', async () => {
    const w = world()
    const chat = w.make('build')
    expect(() => w.api['sessions.send'](chat.id, { text: 'Look', attachments: [], context: [{ path: 'a.ts', kind: 'file' }] })).toThrow('Only Develop sessions have project files to add.')
    expect(w.trail(chat.id)).toEqual([])
    w.say(chat.id, 'Add a check')
    await w.penWorks(chat.id, 'Added.', diff('a.ts'))
    await w.childAnswers(chat.childId, review('Fine.'))
    expect(w.trail(chat.id)).toEqual(['turn 1 review', 'handed 0>1 1 file', 'said 1: Fine.', 'ended agreed'])
  })
})
