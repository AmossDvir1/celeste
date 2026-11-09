import { z } from 'zod'
import { blockedKeys, DESKTOP_LIMITS, describeAction, parseKeys, type DesktopAction, type DesktopBarState, type DesktopResult, type DesktopShot } from '@shared/desktop'
import type { ExtraTool, ExtraTools, ToolResult } from '../workflows/tools'

/*
 * The assistant's use of this computer's mouse and keyboard, after asking. The rules are in docs/DESKTOP_CONTROL_PLAN.md, section 3:
 * off until switched on in Settings, a consent card of Celeste's own, one chat at a time, a time limit, a stop the assistant cannot press,
 * a record of everything done, and a limit on how fast and how much. The tools are on Celeste's own tool server, so every vendor has
 * them, and each call is checked here when it is made.
 */

/** What the real computer does. The main process has the real one; the tests have a fake. */
export interface DesktopHost {
  /** Why control cannot work on this computer, or null when it can. */
  unsupported(): Promise<string | null>
  /** A picture of the screen. Later actions are aimed in its pixels. */
  screenshot(): Promise<DesktopShot>
  /** Does one action. Refuses it, with the reason, if it would touch one of Celeste's own windows. */
  act(action: DesktopAction): Promise<DesktopResult>
  /** The control bar, the border and the stop key: shown with a state, taken away with null. Fails if they cannot be shown. */
  bar(state: DesktopBarState | null): Promise<void>
}

export type DesktopLogEvent =
  | { type: 'desktop.started'; grantId: string; reason: string; until: number }
  | { type: 'desktop.action'; grantId: string; text: string; ok: boolean; until?: number }
  | { type: 'desktop.ended'; grantId: string; why: string; actions: number }

export interface DesktopDeps {
  /** The master switch in Settings. */
  enabled(): boolean
  host: DesktopHost
  /** Celeste's own card in the conversation. Resolves true only when the person pressed Allow. */
  askConsent(sessionId: string, request: { title: string; detail: string }): Promise<boolean>
  record(sessionId: string, event: DesktopLogEvent): void
  now?: () => number
  /** Where the assistant is told the control ends, as a clock time. */
  clock?: (ms: number) => string
}

interface Grant {
  id: string
  sessionId: string
  until: number
  lastAt: number
  actions: number
  lines: string[]
  /** Aborted when control ends, so a wait or a queued action stops at once. */
  stop: AbortController
  timer: ReturnType<typeof setTimeout>
}

const SHAPES = {
  request: { reason: z.string().min(1).max(300).describe('Why you need to use the screen, in one sentence the user will read on a card') },
  at: { x: z.number().describe('Pixels from the left edge of the screenshot'), y: z.number().describe('Pixels from the top edge of the screenshot') },
  button: z.enum(['left', 'right', 'middle']).optional().describe('Default left')
}

const TOOLS: (ExtraTool & { shape: z.ZodRawShape })[] = [
  {
    name: 'desktop_request_control',
    title: 'Ask to use this computer’s screen, mouse and keyboard',
    description:
      'Asks the user whether you may see and use this computer: take screenshots, move the mouse, click, scroll, type and press keys. Use it only for a task that cannot be done by a command, a file or another tool, for example clicking through a settings page or using an app that has no automation. The user is shown a card and decides; if they say no, do not ask again unless they ask you to. Control lasts a few minutes and the user can stop it at any time. Returns what you may do and how.',
    shape: SHAPES.request,
    readOnly: false
  },
  {
    name: 'desktop_release_control',
    title: 'Give the screen, mouse and keyboard back',
    description: 'Ends desktop control. Call it as soon as the task is done.',
    shape: {},
    readOnly: false
  },
  {
    name: 'desktop_screenshot',
    title: 'Take a screenshot of the screen',
    description: 'A picture of the main screen. Every x and y you give to the other desktop tools is in this picture’s pixels, so take a new one after anything changes. Celeste’s own windows are not in it.',
    shape: {},
    readOnly: false
  },
  { name: 'desktop_move', title: 'Move the mouse', description: 'Moves the mouse pointer.', shape: SHAPES.at, readOnly: false },
  { name: 'desktop_click', title: 'Click', description: 'Moves the mouse and clicks.', shape: { ...SHAPES.at, button: SHAPES.button }, readOnly: false },
  { name: 'desktop_double_click', title: 'Double-click', description: 'Moves the mouse and double-clicks with the left button.', shape: SHAPES.at, readOnly: false },
  {
    name: 'desktop_drag',
    title: 'Drag',
    description: 'Presses the left button at one point, moves to another and lets go.',
    shape: {
      from_x: z.number(),
      from_y: z.number(),
      to_x: z.number(),
      to_y: z.number()
    },
    readOnly: false
  },
  {
    name: 'desktop_scroll',
    title: 'Scroll',
    description: 'Moves the mouse to the point and turns the wheel.',
    shape: { ...SHAPES.at, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(20).optional().describe('Wheel clicks, default 3') },
    readOnly: false
  },
  {
    name: 'desktop_type',
    title: 'Type text',
    description: `Types text into whatever has the keyboard, so click the field first. Never type a password, a key or any secret: if something needs one, stop and ask the user to type it. At most ${DESKTOP_LIMITS.maxTextLength} characters.`,
    shape: { text: z.string().min(1) },
    readOnly: false
  },
  {
    name: 'desktop_key',
    title: 'Press a key',
    description: 'Presses a key or a combination, such as “enter”, “tab”, “escape”, “ctrl+c”, “alt+tab” or “ctrl+shift+t”. Letters, digits, f1 to f24, enter, tab, space, backspace, delete, escape, home, end, pageup, pagedown, the arrows and insert.',
    shape: { keys: z.string().min(1) },
    readOnly: false
  },
  {
    name: 'desktop_wait',
    title: 'Wait',
    description: `Waits for something to appear, up to ${DESKTOP_LIMITS.maxWaitSeconds} seconds.`,
    shape: { seconds: z.number().min(0.1).max(DESKTOP_LIMITS.maxWaitSeconds) },
    readOnly: false
  }
]

const fail = (text: string): ToolResult => ({ text, isError: true })
const ok = (text: string): ToolResult => ({ text, isError: false })

const parse = <S extends z.ZodRawShape>(shape: S, args: unknown): { ok: true; data: z.infer<z.ZodObject<S>> } | { ok: false; error: ToolResult } => {
  const r = z.object(shape).safeParse(args ?? {})
  return r.success ? { ok: true, data: r.data } : { ok: false, error: fail(`Invalid arguments: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`) }
}

export class DesktopControl implements ExtraTools {
  private grant: Grant | null = null
  /** A card is on screen. Nothing else may ask while it is. */
  private asking: string | null = null
  /** Chats where the person said no. The assistant cannot keep asking. */
  private readonly refused = new Set<string>()
  /** Actions go one after another, never over each other. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly clock: (ms: number) => string

  constructor(private readonly deps: DesktopDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.clock = deps.clock ?? ((ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  }

  list(): ExtraTool[] {
    return TOOLS
  }

  /** Whether this chat has control right now (for the window to show). */
  active(sessionId?: string): boolean {
    return !!this.grant && (sessionId === undefined || this.grant.sessionId === sessionId)
  }

  // --- ending ----------------------------------------------------------------------------------------

  /** Ends control, whatever the reason: the person pressed Stop, the time ran out, the chat ended, Celeste is closing. */
  stop(why: string): void {
    const g = this.grant
    if (!g) return
    this.grant = null
    clearTimeout(g.timer)
    g.stop.abort()
    // The bar going wrong must never keep control on: it is already over.
    void this.deps.host.bar(null).catch(() => undefined)
    this.deps.record(g.sessionId, { type: 'desktop.ended', grantId: g.id, why, actions: g.actions })
  }

  /** A chat was stopped or deleted: its control ends with it, and a refusal is forgotten. */
  sessionGone(sessionId: string): void {
    if (this.grant?.sessionId === sessionId) this.stop('You stopped the chat.')
  }

  forget(sessionId: string): void {
    this.refused.delete(sessionId)
  }

  /** Adds another stretch of time. From the control bar. */
  extend(): void {
    const g = this.grant
    if (!g) return
    g.until = this.now() + DESKTOP_LIMITS.grantMs
    this.arm(g)
    this.deps.record(g.sessionId, { type: 'desktop.action', grantId: g.id, text: 'Added 15 minutes', ok: true, until: g.until })
    void this.showBar(g).catch(() => undefined)
  }

  private arm(g: Grant): void {
    clearTimeout(g.timer)
    g.timer = setTimeout(() => {
      if (this.grant === g) this.stop('The time ran out.')
    }, Math.max(0, g.until - this.now()))
    g.timer.unref?.()
  }

  private showBar(g: Grant): Promise<void> {
    return this.deps.host.bar({ sessionId: g.sessionId, until: g.until, lines: g.lines.slice(-DESKTOP_LIMITS.barLines) })
  }

  // --- the tools -------------------------------------------------------------------------------------

  async call(sessionId: string, name: string, args: unknown): Promise<ToolResult> {
    if (!TOOLS.some((t) => t.name === name)) return fail(`There is no tool called ${name}.`)
    if (name === 'desktop_request_control') return this.request(sessionId, args)
    if (name === 'desktop_release_control') {
      if (!this.active(sessionId)) return ok('You did not have control.')
      this.stop('The assistant said it was done.')
      return ok('Control ended. Thank you.')
    }

    const g = this.grantFor(sessionId)
    if (typeof g === 'string') return fail(g)

    if (name === 'desktop_wait') {
      const p = parse({ seconds: z.number() }, args)
      if (!p.ok) return p.error
      const seconds = Math.min(Math.max(p.data.seconds, 0.1), DESKTOP_LIMITS.maxWaitSeconds)
      await this.sleep(seconds * 1000, g.stop.signal)
      return g.stop.signal.aborted ? fail('Control ended while waiting.') : this.touch(g, ok(`Waited ${seconds} seconds.`))
    }

    if (name === 'desktop_screenshot') {
      return this.serial(g, async () => {
        try {
          const shot = await this.deps.host.screenshot()
          g.lastAt = this.now()
          return {
            text: `Screenshot, ${shot.width} by ${shot.height} pixels. Give x and y in this picture’s pixels. If anything on the screen changes, take another before you click.`,
            isError: false,
            image: { mime: shot.mime, data: shot.data }
          }
        } catch (err) {
          return fail(`The screen could not be captured: ${err instanceof Error ? err.message : String(err)}`)
        }
      })
    }

    const action = this.toAction(name, args)
    if (!('type' in action)) return action
    return this.serial(g, () => this.perform(g, action))
  }

  private async request(sessionId: string, args: unknown): Promise<ToolResult> {
    const p = parse(SHAPES.request, args)
    if (!p.ok) return p.error
    if (!this.deps.enabled()) return fail('Desktop control is switched off. The user can switch it on in Settings, Desktop control. Do not try to work around this; tell them what you needed it for.')
    if (this.grant?.sessionId === sessionId) return ok('You already have control. Take a screenshot to see the screen.')
    if (this.grant) return fail('Another chat is using the computer’s screen right now. Try again later.')
    if (this.asking) return fail('The user is already being asked. Wait for their answer.')
    if (this.refused.has(sessionId)) return fail('The user said no earlier in this chat. Do not ask again unless they ask you to use the screen.')
    const unsupported = await this.deps.host.unsupported()
    if (unsupported) return fail(unsupported)

    this.asking = sessionId
    let allowed = false
    try {
      allowed = await this.deps.askConsent(sessionId, {
        title: 'Let the assistant control this computer for 15 minutes',
        detail: [
          `Why: ${p.data.reason}`,
          '',
          'While this is on, the assistant can see everything on your screen and click and type anywhere you can. What it sees goes to your AI vendor. Close anything private first.',
          'A bar stays on screen with a Stop button, and Ctrl+Alt+Esc stops it at once. Moving to Celeste’s own windows is not possible for it. Putting a project folder back to a checkpoint cannot undo a click.'
        ].join('\n')
      })
    } finally {
      this.asking = null
    }
    if (!allowed) {
      this.refused.add(sessionId)
      return fail('The user said no. Do not ask again unless they ask you to use the screen. Tell them what you would have done, or do it another way.')
    }

    const now = this.now()
    const g: Grant = {
      id: `dc-${crypto.randomUUID()}`,
      sessionId,
      until: now + DESKTOP_LIMITS.grantMs,
      lastAt: now,
      actions: 0,
      lines: [],
      stop: new AbortController(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>
    }
    this.grant = g
    this.arm(g)
    this.deps.record(sessionId, { type: 'desktop.started', grantId: g.id, reason: p.data.reason, until: g.until })
    try {
      await this.showBar(g)
    } catch (err) {
      // Control is never on without the bar that shows it.
      this.stop('The control bar could not be shown.')
      return fail(`Control could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
    return ok(
      [
        `The user said yes. You have control until ${this.clock(g.until)}, or until they stop it.`,
        'Start with desktop_screenshot. Every x and y you give is in the screenshot’s pixels. Take a new screenshot after anything changes; do not guess what happened.',
        'Rules: never type a password, a key or any secret; if something asks for one, stop and ask the user to type it. Celeste’s own windows cannot be clicked or typed into. If a call is refused, read why and do not try to get round it. If the user presses Stop, every call is refused: stop and say what you did.',
        'Do not repeat an action that did not work more than twice. Call desktop_release_control as soon as you are done.'
      ].join('\n')
    )
  }

  /** The grant a call may use, or the message that says why there is none. */
  private grantFor(sessionId: string): Grant | string {
    const g = this.grant
    if (!g || g.sessionId !== sessionId) {
      if (!this.deps.enabled()) return 'Desktop control is switched off. The user can switch it on in Settings, Desktop control.'
      return 'You do not have control of the screen. Call desktop_request_control first, and say why you need it.'
    }
    const now = this.now()
    if (now >= g.until) {
      this.stop('The time ran out.')
      return 'Control ended because the time ran out. If the task is not finished, ask again with desktop_request_control.'
    }
    if (now - g.lastAt >= DESKTOP_LIMITS.idleMs) {
      this.stop('Nothing was done for a while.')
      return 'Control ended because nothing was done for five minutes. If the task is not finished, ask again with desktop_request_control.'
    }
    if (!this.deps.enabled()) {
      this.stop('Desktop control was switched off.')
      return 'Desktop control was switched off in Settings, so control ended.'
    }
    return g
  }

  private toAction(name: string, args: unknown): DesktopAction | ToolResult {
    switch (name) {
      case 'desktop_move': {
        const p = parse(SHAPES.at, args)
        return p.ok ? { type: 'move', at: { x: p.data.x, y: p.data.y } } : p.error
      }
      case 'desktop_click': {
        const p = parse({ ...SHAPES.at, button: SHAPES.button }, args)
        return p.ok ? { type: 'click', at: { x: p.data.x, y: p.data.y }, button: p.data.button ?? 'left', count: 1 } : p.error
      }
      case 'desktop_double_click': {
        const p = parse(SHAPES.at, args)
        return p.ok ? { type: 'click', at: { x: p.data.x, y: p.data.y }, button: 'left', count: 2 } : p.error
      }
      case 'desktop_drag': {
        const p = parse({ from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() }, args)
        return p.ok ? { type: 'drag', from: { x: p.data.from_x, y: p.data.from_y }, to: { x: p.data.to_x, y: p.data.to_y } } : p.error
      }
      case 'desktop_scroll': {
        const p = parse({ ...SHAPES.at, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(20).optional() }, args)
        if (!p.ok) return p.error
        const n = p.data.amount ?? 3
        const dy = p.data.direction === 'down' ? n : p.data.direction === 'up' ? -n : 0
        const dx = p.data.direction === 'right' ? n : p.data.direction === 'left' ? -n : 0
        return { type: 'scroll', at: { x: p.data.x, y: p.data.y }, dx, dy }
      }
      case 'desktop_type': {
        const p = parse({ text: z.string().min(1) }, args)
        if (!p.ok) return p.error
        if (p.data.text.length > DESKTOP_LIMITS.maxTextLength) return fail(`That is ${p.data.text.length} characters; the most at once is ${DESKTOP_LIMITS.maxTextLength}. Type it in parts.`)
        return { type: 'type', text: p.data.text }
      }
      case 'desktop_key': {
        const p = parse({ keys: z.string().min(1) }, args)
        if (!p.ok) return p.error
        const keys = parseKeys(p.data.keys)
        if (!keys.ok) return fail(keys.reason)
        const blocked = blockedKeys(keys)
        if (blocked) return fail(`Refused: ${blocked}`)
        return { type: 'key', keys: p.data.keys.trim() }
      }
      default:
        return fail(`There is no tool called ${name}.`)
    }
  }

  private async perform(g: Grant, action: DesktopAction): Promise<ToolResult> {
    if (this.grant !== g) return fail('Control has ended.')
    if (g.actions >= DESKTOP_LIMITS.maxActions) {
      this.stop(`It reached the limit of ${DESKTOP_LIMITS.maxActions} actions.`)
      return fail(`Control ended: the most actions in one go is ${DESKTOP_LIMITS.maxActions}. If the task is not finished, ask again.`)
    }
    // Not too fast: wait out the gap instead of refusing, so a loop is slowed and a careful agent is not troubled.
    const gap = g.lastAt + DESKTOP_LIMITS.minGapMs - this.now()
    if (gap > 0) await this.sleep(gap, g.stop.signal)
    if (this.grant !== g) return fail('Control has ended.')

    const text = describeAction(action)
    let result: DesktopResult
    try {
      result = await this.deps.host.act(action)
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    // Control may have been stopped while the action ran.
    if (this.grant !== g) return fail('Control has ended.')
    g.lastAt = this.now()
    if (result.ok) g.actions++
    g.lines.push(result.ok ? text : `Refused: ${text}`)
    this.deps.record(g.sessionId, { type: 'desktop.action', grantId: g.id, text, ok: result.ok })
    void this.showBar(g).catch(() => undefined)
    return result.ok ? ok(`Done: ${text}. Take a screenshot to see what happened.`) : fail(`Refused: ${result.reason}`)
  }

  private touch(g: Grant, result: ToolResult): ToolResult {
    g.lastAt = this.now()
    return result
  }

  /** One call at a time. A call that waits its turn is dropped if control ends first. */
  private serial(g: Grant, run: () => Promise<ToolResult>): Promise<ToolResult> {
    const next = this.queue.then(() => (g.stop.signal.aborted ? fail('Control has ended.') : run()))
    this.queue = next.catch(() => undefined)
    return next
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done)
    })
  }
}
