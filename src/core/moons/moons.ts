import type { UserInput } from '@shared/agent'
import type { CorePush, LogEvent } from '@shared/api'
import { MAX_ROUNDS, PATTERNS, matchFindings, mention, moonName, otherSeat, readFix, readPlan, readReview, readTest, withoutBlock, type Finding, type FixReply, type MoonPattern, type MoonStep, type ReviewReply, type Seat } from '@shared/moons'
import type { Lent, MoonsEvent, SessionService } from '../service'
import type { Store } from '../store'
import * as words from './words'

/*
 * Two Moons (docs/plans/TWO_MOONS_PLAN.md, sections 7 and 8): Celeste, not a model, gives the two agents of a chat their turns. The pen is the
 * chat's own agent; the other moon is a session of its own. Everything that happens is written into the chat's log as `moons.*` events, so the
 * window can draw it and a replay shows the same. What Core keeps in memory is one `Run` for each chat that is being worked on: after a restart
 * there is nothing to restore, because `turn.abandoned` already ended it.
 */

/** The part of the session service the engine uses. A test gives the real service, on a memory store. */
export type MoonsHost = Pick<SessionService, 'sessionRow' | 'isBusy' | 'stop' | 'sendFrom' | 'lastAnswer' | 'recordMoons' | 'tellPen' | 'personSaid' | 'turnChanges' | 'continueQueue' | 'requestApproval'>

export interface MoonsDeps {
  service: MoonsHost
  /** Read only: the logs of the chat and of the other moon. */
  store: Pick<Store, 'events'>
  /** Makes the id of something said. */
  newId?: () => string
}

type TurnEnd = 'turn.completed' | 'turn.interrupted' | 'turn.failed' | 'turn.abandoned'
const TURN_ENDS = new Set<string>(['turn.completed', 'turn.interrupted', 'turn.failed', 'turn.abandoned'])

/** Who the run is waiting for. 'none': Celeste is working something out. 'person': a plan waits for a yes. */
type Waiting = 'pen' | 'child' | 'both' | 'person' | 'none'

interface Open {
  id: string
  finding: Finding
}

/** What one reviewer's reply came to, in Two reviews. */
type Part = { kind: 'ok'; reply: ReviewReply } | { kind: 'unread'; words: string } | { kind: 'failed'; note: string }

interface Run {
  /** Counts the runs, so a continuation that began in an earlier run does nothing in a later one. */
  n: number
  id: string
  pattern: MoonPattern
  childId: string
  pen: Seat
  other: Seat
  step: MoonStep
  /** How many times the other moon looked at what the pen did (a review, a check, a retest). */
  round: number
  /** The person's words that began the run. */
  request: string
  /** What the person added to them, for each agent that has not been given it yet. It goes with the first thing that agent is told. */
  lend: { pen?: Lent; child?: Lent }
  waiting: Waiting
  /** The turn this run asked of the other moon: where its log stood before, and whether its end was taken. */
  ask?: { startSeq: number; done: boolean }
  /** An ask that waits because the other moon was busy with something the person gave it. */
  queued?: string
  /** Findings that were said and are not fixed. */
  open: Open[]
  /** The notes the Builder was given last, numbered. */
  noted: { n: number; id: string }[]
  notes: Finding[]
  /** What the Builder answered about each note, by the note's id: kept, and logged as fixed only when the other moon agrees. */
  answers: Map<string, boolean>
  fixReply?: FixReply
  builderSaid: string
  parts: Partial<Record<Seat, Part>>
}

const MOON_WORDS_MAX = 1500

const clip = (text: string): string => (text.length > MOON_WORDS_MAX ? `${text.slice(0, MOON_WORDS_MAX).trimEnd()}…` : text)

export class Moons {
  private readonly runs = new Map<string, Run>()
  private readonly byChild = new Map<string, Run>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private count = 0
  private readonly newId: () => string

  constructor(private readonly deps: MoonsDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID().slice(0, 8))
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.runs.clear()
    this.byChild.clear()
  }

  // --- small things ------------------------------------------------------------------------------------

  private alive(run: Run): boolean {
    return this.runs.get(run.id)?.n === run.n
  }

  private nameOf(run: Run, seat: Seat): string {
    return moonName(run.pattern, seat)
  }

  /** Writes an event of a run that is still going. Nothing of a run is written after its end. */
  private rec(run: Run, event: MoonsEvent): boolean {
    if (!this.alive(run)) return false
    this.deps.service.recordMoons(run.id, event)
    return true
  }

  /** That moon's turn begins. The chat is working from now. */
  private turn(run: Run, seat: Seat, step: MoonStep): void {
    run.step = step
    this.rec(run, { type: 'moons.turn', seat, step })
  }

  private say(run: Run, seat: Seat, text: string, more: { finding?: Finding; to?: 'person' } = {}): string {
    const id = this.newId()
    const f = more.finding
    this.rec(run, {
      type: 'moons.said',
      seat,
      id,
      text,
      ...(f?.file ? { file: f.file } : {}),
      ...(f?.line !== undefined ? { line: f.line } : {}),
      ...(f?.code ? { code: f.code } : {}),
      ...(f ? { finding: true as const } : {}),
      ...(more.to ? { to: more.to } : {})
    })
    return id
  }

  private begin(id: string, pattern: MoonPattern, childId: string, step: MoonStep, waiting: Waiting, input: UserInput): Run {
    const def = PATTERNS[pattern]
    const added: Lent | undefined = input.attachments.length || input.context?.length ? { attachments: input.attachments, ...(input.context?.length ? { context: input.context } : {}) } : undefined
    const run: Run = { n: ++this.count, id, pattern, childId, pen: def.pen, other: otherSeat(pattern), step, round: 0, request: input.text, lend: added ? { child: added, ...(waiting === 'child' ? { pen: added } : {}) } : {}, waiting, open: [], noted: [], notes: [], answers: new Map(), builderSaid: '', parts: {} }
    this.runs.set(id, run)
    this.byChild.set(childId, run)
    return run
  }

  private release(run: Run): void {
    if (this.runs.get(run.id) === run) this.runs.delete(run.id)
    if (this.byChild.get(run.childId) === run) this.byChild.delete(run.childId)
  }

  /** The run is over: said in the log, the other moon stopped if it still works, and the queue goes on (or is held, after a stop or a failure). */
  private end(run: Run, why: Extract<LogEvent, { type: 'moons.ended' }>['why'], note?: string, left?: number, queue = true): void {
    if (!this.alive(run)) return
    this.release(run)
    const { service } = this.deps
    try {
      service.recordMoons(run.id, { type: 'moons.ended', why, ...(note ? { note } : {}), ...(left !== undefined ? { left } : {}) })
    } catch (err) {
      console.error('[core] Two Moons could not write the end of a run', err)
    }
    try {
      if (run.ask && !run.ask.done && service.isBusy(run.childId)) service.stop(run.childId)
    } catch {
      // The other moon is gone already.
    }
    if (queue) service.continueQueue(run.id, why === 'stopped' || why === 'failed')
  }

  /** Something went wrong inside Celeste. The run ends as failed, so that a chat is never left working. */
  private broke(run: Run | undefined, err: unknown): void {
    console.error('[core] Two Moons could not go on', err)
    if (run) this.end(run, 'failed', 'Something went wrong inside Celeste, so the two moons stopped.')
  }

  /** One step later, as the helpers' bookkeeping does: the queue may be about to send a message into a session whose turn just ended. */
  private later(run: Run | undefined, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      try {
        fn()
      } catch (err) {
        this.broke(run, err)
      }
    }, 0)
    t.unref?.()
    this.timers.add(t)
  }

  // --- the person's message ----------------------------------------------------------------------------

  /** A person's message to the chat, which is idle (or has a run that this message ends). True when the engine took it, false when the pen is to get it. */
  takes(id: string, input: UserInput): boolean {
    const { service } = this.deps
    const row = service.sessionRow(id)
    if (!row?.moons) return false
    // A run that is still open: this message ends it first, whatever state it is in. Never two at once.
    const open = this.runs.get(id)
    if (open) this.end(open, 'stopped', undefined, undefined, false)
    const { pattern, childId } = row.moons
    // The other moon is gone: the chat goes on alone.
    if (!service.sessionRow(childId)) return false
    const pen = PATTERNS[pattern].pen
    const other = otherSeat(pattern)
    const m = mention(pattern, input.text)
    // `@Builder …` goes to the pen alone, with no one to check it.
    if (m && m.seat === pen) return false
    if (m) {
      const saved = service.personSaid(id, input)
      const run = this.begin(id, pattern, childId, 'answer', 'child', input)
      this.turn(run, other, 'answer')
      this.askFirst(run, saved, words.directRequest(moonName(pattern, other), pattern, m.rest))
      return true
    }
    switch (pattern) {
      case 'build':
        this.begin(id, pattern, childId, 'build', 'pen', input)
        return false
      case 'plan': {
        if (!this.needsPlan(id)) {
          this.begin(id, pattern, childId, 'build', 'pen', input)
          return false
        }
        const saved = service.personSaid(id, input)
        const run = this.begin(id, pattern, childId, 'plan', 'child', input)
        this.turn(run, other, 'plan')
        this.askFirst(run, saved, words.planRequest(input.text))
        return true
      }
      case 'bug': {
        const saved = service.personSaid(id, input)
        const run = this.begin(id, pattern, childId, 'test', 'child', input)
        this.turn(run, other, 'test')
        this.askFirst(run, saved, words.testRequest(input.text))
        return true
      }
      case 'reviews': {
        const run = this.begin(id, pattern, childId, 'review', 'both', input)
        // After the pen has been handed the message, so the log reads in the order it happened.
        queueMicrotask(() => {
          try {
            if (!this.alive(run)) return
            this.turn(run, other, 'review')
            this.askChild(run, words.reviewBothRequest(moonName(pattern, other), input.text))
          } catch (err) {
            this.broke(run, err)
          }
        })
        return false
      }
    }
  }

  /** The message that began a run could not be given to the pen, and the person is told so: the run is not left open. */
  notSent(id: string): void {
    const run = this.runs.get(id)
    if (run) this.release(run)
  }

  /** What the pen is told besides the person's words. */
  lineFor(id: string): string {
    const run = this.runs.get(id)
    return run ? words.penLine(run.pattern) : ''
  }

  /** A plan is asked for until one was agreed, and again after the person said no to one. */
  private needsPlan(id: string): boolean {
    let agreed = false
    let lastEnd: string | undefined
    for (const { event } of this.deps.store.events(id)) {
      if (event.type === 'moons.agreed') agreed = true
      else if (event.type === 'moons.ended') lastEnd = event.why
    }
    return !agreed || lastEnd === 'declined'
  }

  // --- the pen's turn ----------------------------------------------------------------------------------

  /** The pen's turn completed. True when the run goes on (the other moon's turn has been written, so the chat stays at work and the queue waits). */
  penDone(id: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.step === 'answer') return false
    try {
      return this.penTurnEnded(run)
    } catch (err) {
      this.broke(run, err)
      return false
    }
  }

  private penTurnEnded(run: Run): boolean {
    const { service } = this.deps
    if (run.waiting !== 'pen' && run.waiting !== 'both') {
      // A turn of the pen's that this run did not begin: the chat is kept at work for whoever the run is waiting for.
      if (run.waiting === 'child') this.rec(run, { type: 'moons.turn', seat: run.other, step: run.step })
      return run.waiting !== 'person'
    }
    switch (run.pattern) {
      case 'plan':
        // The Builder is done: what was agreed is built. The queue goes on as for any turn.
        this.end(run, 'agreed', undefined, undefined, false)
        return false
      case 'build': {
        const first = run.step === 'build'
        const reply = service.lastAnswer(run.id)
        if (first) run.builderSaid = clip(withoutBlock(reply))
        else this.takeFixReply(run, reply)
        this.turn(run, run.other, first ? 'review' : 'check')
        run.waiting = 'none'
        void this.afterBuild(run).catch((err) => this.broke(run, err))
        return true
      }
      case 'bug': {
        this.takeFixReply(run, service.lastAnswer(run.id))
        this.turn(run, run.other, 'retest')
        run.waiting = 'none'
        void this.afterBugFix(run).catch((err) => this.broke(run, err))
        return true
      }
      case 'reviews': {
        run.parts[run.pen] = this.partOf(service.lastAnswer(run.id))
        if (run.parts[run.other]) {
          this.finishReviews(run, false)
          return false
        }
        run.waiting = 'child'
        // The pen's turn ended and the chat went idle: it is at work again, for the other reviewer.
        this.rec(run, { type: 'moons.turn', seat: run.other, step: 'review' })
        return true
      }
    }
  }

  /** The Builder's answer to the notes, read from its last words. Without the block there are no answers, and the run goes on. */
  private takeFixReply(run: Run, reply: string): void {
    run.builderSaid = clip(withoutBlock(reply))
    run.answers.clear()
    const fix = readFix(reply)
    run.fixReply = fix
    if (!fix) return
    if (fix.say) this.say(run, run.pen, fix.say)
    for (const a of fix.answers) {
      if (a.say) this.say(run, run.pen, a.say)
      const note = run.noted.find((x) => x.n === a.n)
      if (note) run.answers.set(note.id, a.fixed)
    }
  }

  /** Build and review: what the pen changed goes to the other moon. Nothing changed, nothing to look at. */
  private async afterBuild(run: Run): Promise<void> {
    const files = await this.deps.service.turnChanges(run.id)
    if (!this.alive(run)) return
    if (files.length === 0) {
      this.end(run, 'nothing')
      return
    }
    const reviewer = this.nameOf(run, run.other)
    const builder = this.nameOf(run, run.pen)
    this.rec(run, { type: 'moons.handed', from: run.pen, to: run.other, what: words.filesWord(files.length) })
    run.round++
    const text =
      run.round === 1
        ? words.reviewRequest({ name: reviewer, builder, request: run.request, builderSaid: run.builderSaid, files })
        : words.checkRequest({ name: reviewer, builder, notes: run.notes, answers: run.fixReply?.answers ?? [], say: run.fixReply?.say || run.builderSaid, files })
    run.waiting = 'child'
    this.askChild(run, text)
  }

  /** Find and fix a bug: the fix goes back to the Tester to try again. */
  private async afterBugFix(run: Run): Promise<void> {
    if (!this.alive(run)) return
    this.rec(run, { type: 'moons.handed', from: run.pen, to: run.other, what: 'the fix' })
    run.round++
    run.waiting = 'child'
    this.askChild(run, words.retestRequest({ builder: this.nameOf(run, run.pen), say: run.fixReply?.say || run.builderSaid || 'I changed the code.' }))
  }

  /** What the person added to their message, the first time this agent is told something. */
  private lent(run: Run, who: 'pen' | 'child'): Lent | undefined {
    const lend = run.lend[who]
    delete run.lend[who]
    return lend
  }

  /** Gives the pen something to do, for the other moon. */
  private tell(run: Run, text: string): void {
    run.waiting = 'pen'
    try {
      this.deps.service.tellPen(run.id, text, this.lent(run, 'pen'))
    } catch (err) {
      this.end(run, 'failed', `${this.nameOf(run, run.pen)} could not be asked: ${err instanceof Error ? err.message : 'it did not say why'}`)
    }
  }

  // --- the other moon's turn ---------------------------------------------------------------------------

  /** The first thing the other moon is asked, once the folder has been saved (Develop): a Tester may write, and that must be possible to undo. */
  private askFirst(run: Run, saved: Promise<void> | undefined, text: string): void {
    if (!saved) {
      this.askChild(run, text)
      return
    }
    void saved
      .then(() => {
        if (this.alive(run)) this.askChild(run, text)
      })
      .catch((err) => this.broke(run, err))
  }

  /** Asks the other moon, or waits until it has finished what the person gave it. */
  private askChild(run: Run, text: string): void {
    run.ask = undefined
    let busy = false
    try {
      busy = this.deps.service.isBusy(run.childId)
    } catch {
      this.end(run, 'failed', `${this.nameOf(run, run.other)} is gone.`)
      return
    }
    if (busy) {
      run.queued = text
      return
    }
    this.sendAsk(run, text)
  }

  private sendAsk(run: Run, text: string): void {
    const { service } = this.deps
    const row = service.sessionRow(run.childId)
    const name = this.nameOf(run, run.other)
    if (!row) {
      this.end(run, 'failed', `${name} is gone.`)
      return
    }
    run.ask = { startSeq: row.lastSeq, done: false }
    try {
      service.sendFrom(run.childId, text, 'parent', undefined, this.lent(run, 'child'))
    } catch (err) {
      run.ask = undefined
      this.end(run, 'failed', `${name} could not be asked: ${err instanceof Error ? err.message : 'it did not say why'}`)
    }
  }

  /** The turn this run asked of the other moon, from the other moon's log: its words and how it ended, or nothing while it still runs. */
  private turnOf(run: Run): { type: TurnEnd; text: string; error?: string } | undefined {
    if (!run.ask) return undefined
    let started = false
    let text = ''
    for (const { event } of this.deps.store.events(run.childId, run.ask.startSeq)) {
      // The run's own message, not one the person typed into the other moon meanwhile.
      if (!started) {
        if (event.type === 'user.message' && event.from === 'parent') started = true
        continue
      }
      if (event.type === 'message.delta') text += event.text
      else if (event.type === 'turn.failed') return { type: event.type, text, error: event.error.message }
      else if (event.type === 'turn.completed' || event.type === 'turn.interrupted' || event.type === 'turn.abandoned') return { type: event.type, text }
    }
    return undefined
  }

  /** A turn ended in the other moon's session. It matters only if it is the one this run asked for. */
  private settle(run: Run): void {
    if (!this.alive(run)) return
    if (run.queued !== undefined) {
      let busy = true
      try {
        busy = this.deps.service.isBusy(run.childId)
      } catch {
        this.end(run, 'failed', `${this.nameOf(run, run.other)} is gone.`)
        return
      }
      if (!busy) {
        const text = run.queued
        run.queued = undefined
        this.sendAsk(run, text)
      }
      return
    }
    if (!run.ask || run.ask.done) return
    const turn = this.turnOf(run)
    if (!turn) return
    run.ask.done = true
    this.childDone(run, turn)
  }

  private childDone(run: Run, turn: { type: TurnEnd; text: string; error?: string }): void {
    const name = this.nameOf(run, run.other)
    if (turn.type !== 'turn.completed') {
      const note = turn.type === 'turn.failed' ? turn.error || `${name} failed.` : turn.type === 'turn.interrupted' ? `${name} was stopped.` : `${name} was closed.`
      if (run.pattern === 'reviews' && run.step !== 'answer') {
        run.parts[run.other] = { kind: 'failed', note }
        this.afterReviewsChild(run)
        return
      }
      this.end(run, 'failed', note)
      return
    }
    if (run.step === 'answer') {
      const said = withoutBlock(turn.text).trim()
      if (said) this.say(run, run.other, said, { to: 'person' })
      this.end(run, 'agreed', said ? undefined : `${name} had nothing to say.`)
      return
    }
    switch (run.pattern) {
      case 'build':
        this.reviewed(run, turn.text)
        return
      case 'plan':
        this.planned(run, turn.text)
        return
      case 'bug':
        this.tested(run, turn.text)
        return
      case 'reviews':
        run.parts[run.other] = this.partOf(turn.text)
        this.afterReviewsChild(run)
        return
    }
  }

  /** The words of a reply that has no block that can be read, said as they are, and the run ends. */
  private unread(run: Run, text: string): void {
    const said = withoutBlock(text).trim()
    if (said) this.say(run, run.other, said, { to: 'person' })
    this.end(run, 'unread', `${this.nameOf(run, run.other)} did not answer in the form Celeste needs, so the run stopped.`)
  }

  // --- build and review --------------------------------------------------------------------------------

  private reviewed(run: Run, text: string): void {
    const reply = readReview(text)
    if (!reply) return this.unread(run, text)
    const before = run.open
    const m = matchFindings(
      before.map((o) => o.finding),
      reply.findings
    )
    // What was open and is said again is still open under its own id; what is not said again is settled.
    const kept = before.filter((o) => m.both.some((pair) => pair.a === o.finding))
    const gone = before.filter((o) => !kept.includes(o))
    if (reply.say) this.say(run, run.other, reply.say)
    const fresh = m.second.map((finding) => ({ id: this.say(run, run.other, finding.text, { finding }), finding }))
    // "Fixed" only now that the Reviewer has looked. A note the Builder did not follow and the Reviewer let go of is not called fixed.
    const fixed = gone.filter((o) => run.answers.get(o.id) !== false).map((o) => o.id)
    if (fixed.length) this.rec(run, { type: 'moons.fixed', ids: fixed })
    run.open = [...kept, ...fresh]
    if (run.open.length === 0) return this.end(run, 'agreed')
    if (run.round >= MAX_ROUNDS) return this.end(run, 'rounds', undefined, run.open.length)
    run.noted = run.open.map((o, i) => ({ n: i + 1, id: o.id }))
    run.notes = run.open.map((o) => o.finding)
    this.rec(run, { type: 'moons.handed', from: run.other, to: run.pen, what: words.notesWord(run.notes.length) })
    this.turn(run, run.pen, 'fix')
    this.tell(run, words.fixRequest(this.nameOf(run, run.other), reply.say, run.notes))
  }

  // --- plan, then build --------------------------------------------------------------------------------

  private planned(run: Run, text: string): void {
    const plan = readPlan(text)
    if (!plan || plan.steps.length === 0) return this.unread(run, text)
    const planId = this.newId()
    this.rec(run, { type: 'moons.plan', id: planId, say: plan.say, steps: plan.steps })
    run.waiting = 'person'
    const planner = this.nameOf(run, run.other)
    // The steps are on the plan's own card, right above the one that asks.
    const card = this.deps.service.requestApproval(run.id, { kind: 'other', title: 'Build it this way', detail: `The plan above: ${words.stepsWord(plan.steps.length)}.` })
    void card
      .then((yes) => {
        // The person stopped the run, or wrote something instead of answering: the card was let go of, and this is not an answer.
        if (!this.alive(run)) return
        if (!yes) {
          this.end(run, 'declined')
          return
        }
        this.rec(run, { type: 'moons.agreed', id: planId })
        this.rec(run, { type: 'moons.handed', from: run.other, to: run.pen, what: 'the plan' })
        this.turn(run, run.pen, 'build')
        this.tell(run, words.buildRequest(planner, run.request, plan.steps))
      })
      .catch((err) => this.broke(run, err))
  }

  // --- find and fix a bug ------------------------------------------------------------------------------

  private tested(run: Run, text: string): void {
    const reply = readTest(text)
    if (!reply) return this.unread(run, text)
    if (run.step === 'test') {
      if (!reply.failed) {
        if (reply.say) this.say(run, run.other, reply.say, { to: 'person' })
        return this.end(run, 'agreed', 'It did not fail.')
      }
      const finding: Finding = { text: reply.say, ...(reply.file ? { file: reply.file } : {}), ...(reply.line !== undefined ? { line: reply.line } : {}), ...(reply.code ? { code: reply.code } : {}) }
      const id = this.say(run, run.other, reply.say, { finding })
      run.open = [{ id, finding }]
      run.noted = [{ n: 1, id }]
      this.handBug(run, finding)
      return
    }
    // Tried again. It still fails, and there is a round left: the Builder is told what the Tester saw this time. It is the same bug, still open.
    const last = !reply.failed || run.round >= MAX_ROUNDS
    if (reply.say) this.say(run, run.other, reply.say, last ? { to: 'person' } : {})
    if (!reply.failed) {
      this.rec(run, { type: 'moons.fixed', ids: run.open.map((o) => o.id) })
      this.end(run, 'agreed')
      return
    }
    if (last) return this.end(run, 'rounds', undefined, run.open.length)
    this.handBug(run, { text: reply.say, ...(reply.file ? { file: reply.file } : {}), ...(reply.line !== undefined ? { line: reply.line } : {}), ...(reply.code ? { code: reply.code } : {}) })
  }

  /** The bug goes to the Builder. The Tester may have added a failing test: the Builder is told its files. */
  private handBug(run: Run, found: Finding): void {
    run.notes = [found]
    const paths = words.diffsOfTools(this.deps.store.events(run.childId, run.ask?.startSeq ?? 0)).map((f) => f.path)
    this.rec(run, { type: 'moons.handed', from: run.other, to: run.pen, what: paths.length ? words.filesWord(paths.length) : 'the bug' })
    this.turn(run, run.pen, 'fix')
    const { text: say, ...where } = found
    this.tell(run, words.fixBugRequest(this.nameOf(run, run.other), run.request, { say, ...where }, paths))
  }

  // --- two reviews -------------------------------------------------------------------------------------

  private partOf(text: string): Part {
    const reply = readReview(text)
    return reply ? { kind: 'ok', reply } : { kind: 'unread', words: withoutBlock(text).trim() }
  }

  /** The other reviewer's part is in (or failed): the run is over when the pen's is in too. */
  private afterReviewsChild(run: Run): void {
    if (run.parts[run.pen]) this.finishReviews(run, true)
    else run.waiting = 'pen'
  }

  /** Both parts are in: what each said, what both found, and the end. A part that could not be read is said as it is, and the other's findings are still listed. */
  private finishReviews(run: Run, queue: boolean): void {
    const parts: [Part, Part] = [run.parts[0] as Part, run.parts[1] as Part]
    ;([0, 1] as Seat[]).forEach((seat) => {
      const part = parts[seat]
      const said = part.kind === 'ok' ? part.reply.say : part.kind === 'unread' ? part.words : ''
      if (said) this.say(run, seat, said, { to: 'person' })
    })
    const [a, b] = parts
    if (a.kind === 'ok' && b.kind === 'ok') {
      const m = matchFindings(a.reply.findings, b.reply.findings)
      this.rec(run, { type: 'moons.compared', both: m.both.map((pair) => pair.a), first: m.first, second: m.second })
      this.end(run, 'agreed', undefined, undefined, queue)
      return
    }
    if (a.kind === 'ok' || b.kind === 'ok') this.rec(run, { type: 'moons.compared', both: [], first: a.kind === 'ok' ? a.reply.findings : [], second: b.kind === 'ok' ? b.reply.findings : [] })
    const failed = a.kind === 'failed' ? a : b.kind === 'failed' ? b : undefined
    if (failed) return this.end(run, 'failed', failed.note, undefined, queue)
    const seat: Seat = a.kind === 'unread' ? 0 : 1
    this.end(run, 'unread', `${this.nameOf(run, seat)} did not answer in the form Celeste needs.`, undefined, queue)
  }

  /** The pen's turn failed or was stopped by something other than the person. */
  private penEnded(run: Run, event: Extract<LogEvent, { type: 'turn.failed' | 'turn.interrupted' }>): void {
    if (!this.alive(run)) return
    const waitingOnPen = run.waiting === 'pen' || (run.waiting === 'both' && !run.parts[run.pen])
    if (!waitingOnPen) return
    const name = this.nameOf(run, run.pen)
    if (run.pattern === 'reviews') {
      run.parts[run.pen] = { kind: 'failed', note: event.type === 'turn.failed' ? event.error.message || `${name} failed.` : `${name} was stopped.` }
      if (run.parts[run.other]) {
        this.finishReviews(run, true)
        return
      }
      // The pen's turn ended and the chat went idle: it is at work again, for the other reviewer.
      run.waiting = 'child'
      this.rec(run, { type: 'moons.turn', seat: run.other, step: 'review' })
      return
    }
    if (event.type === 'turn.failed') this.end(run, 'failed', event.error.message || `${name} failed.`)
    else this.end(run, 'stopped')
  }

  // --- what happens around a run -----------------------------------------------------------------------

  /** The person pressed Stop in a session, or deleted it. */
  stopped(id: string): void {
    const run = this.runs.get(id)
    if (run) {
      this.end(run, 'stopped')
      return
    }
    // In the other moon's own chat, while it works for a run: the run cannot go on. One step later, to tell a stop from a delete.
    const asChild = this.byChild.get(id)
    if (asChild?.ask && !asChild.ask.done) {
      this.later(asChild, () => {
        if (!this.alive(asChild)) return
        const gone = !this.deps.service.sessionRow(id)
        this.end(asChild, 'failed', `${this.nameOf(asChild, asChild.other)} was ${gone ? 'deleted' : 'stopped'}.`)
      })
    }
  }

  /** Every push: a turn ended in one of the sessions a run waits on, or the other moon was deleted. */
  observe(p: CorePush): void {
    if (p.type === 'event') {
      const event = p.stored.event
      if (!TURN_ENDS.has(event.type)) return
      const asChild = this.byChild.get(p.sessionId)
      if (asChild) this.later(asChild, () => this.settle(asChild))
      const asPen = this.runs.get(p.sessionId)
      if (asPen && (event.type === 'turn.failed' || event.type === 'turn.interrupted')) this.later(asPen, () => this.penEnded(asPen, event))
    } else if (p.type === 'removed') {
      const run = this.byChild.get(p.id)
      if (run) this.end(run, 'failed', `${this.nameOf(run, run.other)} was deleted.`)
    }
  }
}
