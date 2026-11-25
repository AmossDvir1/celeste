import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import type { Scene, SceneLine } from './sky-model'

/*
 * The scenes of the sky: one small card for what a moon is doing at this moment, made of the real things (the file, the lines, the command,
 * the question). DOM and CSS, not canvas: the motion is CSS animation, so nothing here is redrawn from React while it plays. Anything that
 * the agent did not give us (a tool with no lines) is left out, never made up.
 */

export interface SceneActions {
  /** Answers an approval of a session: the same as the buttons of the card in the thread. */
  onAnswer: (sessionId: string, requestId: string, allow: boolean) => void
  /** Opens a session, where the full card (or the question) is. */
  onOpen: (sessionId: string) => void
}

type Vars = CSSProperties & Record<`--${string}`, string | number>

const Header = ({ left, right }: { left: string; right?: React.ReactNode }) => (
  <div className="moons-f">
    {left}
    {right !== undefined && <em>{right}</em>}
  </div>
)

const SEC = (n: number): string => `${n.toFixed(2)}s`

/** The added lines are typed in over 1.4 seconds, in order, each in proportion to its length. A deleted one is struck and dimmed at once. */
function EditScene({ scene }: { scene: Extract<Scene, { kind: 'edit' }> }) {
  const total = scene.lines.reduce((n, l) => n + (l.k === 'add' ? Math.max(1, l.text.length) : 0), 0) || 1
  let before = 0
  return (
    <>
      <Header
        left={scene.file || 'a file'}
        right={
          scene.lines.length > 0 ? (
            <>
              <span className="text-success">+{scene.added}</span> <span className="text-danger">−{scene.removed}</span>
            </>
          ) : undefined
        }
      />
      {scene.lines.map((l, i) => {
        if (l.k === 'add') {
          const n = Math.max(1, l.text.length)
          const style: Vars = { '--n': n, '--dur': SEC((n / total) * 1.4), '--delay': SEC(0.2 + (before / total) * 1.4) }
          before += n
          return (
            <div key={i} className="moons-ln add">
              <span className="moons-type" style={style}>
                {l.text}
              </span>
            </div>
          )
        }
        return (
          <div key={i} className={cn('moons-ln', l.k, l.k === 'del' && 'moons-del-fade')}>
            {l.text}
          </div>
        )
      })}
      {scene.lines.length === 0 && (
        <div className="moons-ln">
          <span className="moons-caret" />
        </div>
      )}
    </>
  )
}

function ReadScene({ scene }: { scene: Extract<Scene, { kind: 'read' }> }) {
  return (
    <>
      <Header left={scene.title} right="reading" />
      {scene.lines.map((l, i) => (
        <div key={i} className="moons-ln moons-hot" style={{ '--delay': SEC(i * 0.45) } as Vars}>
          {l}
        </div>
      ))}
      {scene.lines.length === 0 && (
        <div className="moons-ln">
          <span className="moons-caret" />
        </div>
      )}
    </>
  )
}

const kindOfOutput = (line: string): string => (/\b(fail(ed|ing|s)?|error|✗|×)\b/i.test(line) || /^(error|fatal)/i.test(line) ? 'bad' : /(✓|✔|\bpass(ed|ing)?\b)/i.test(line) ? 'good' : '')

function RunScene({ scene }: { scene: Extract<Scene, { kind: 'run' }> }) {
  return (
    <>
      <Header left="Terminal" />
      <div className="moons-ln cmd">
        $ {scene.command}
        {scene.output.length === 0 && <span className="moons-caret" />}
      </div>
      {scene.output.map((l, i) => (
        <div key={i} className={cn('moons-ln out', kindOfOutput(l))}>
          {l}
        </div>
      ))}
    </>
  )
}

const rowClass = (l: SceneLine): string => (l.k === 'add' ? 'add' : l.k === 'del' ? 'del' : 'ctx')

function LensScene({ scene }: { scene: Extract<Scene, { kind: 'lens' }> }) {
  const rows = Math.max(1, scene.lines.length)
  // The lens drifts from the first row to the last; the top of the first row is 32 px down, each row 17 px, and the lens is 64 px wide.
  const vars: Vars = { '--y0': `${32 - 24}px`, '--y1': `${32 + (rows - 1) * 17 - 24}px` }
  return (
    <>
      <Header left={scene.file || 'The change'} right="checking" />
      {scene.lines.map((l, i) => (
        <div key={i} className={cn('moons-ln', rowClass(l))}>
          {l.text}
        </div>
      ))}
      {scene.marks.map((m) => (
        <span key={m.row} className="moons-mark" style={{ top: 31 + m.row * 17, '--delay': SEC(0.5 + m.row * 0.45) } as Vars}>
          {m.text}
        </span>
      ))}
      <div className="moons-lens-y" style={vars}>
        <div className="moons-lens-x" />
      </div>
    </>
  )
}

/** How far each speck is from its row, in percent of the card's height, so the shape does not look like a saw. */
const WOBBLE = [2, -4, -3, 3, 4, -2]

/**
 * Specks that join into a shape, every other one high or low. The words are what the moon touched, so there are none when it has touched nothing.
 * A high speck has its word above it and a low one below it: the words of a row are two specks apart, so each has the room of two, and what does not
 * fit in that is cut. Everything is in percent of the card, so nothing runs over its edge or into the next word at any width.
 */
function ThinkScene({ scene, room }: { scene: Extract<Scene, { kind: 'think' }>; room: number }) {
  const words = scene.words.slice(-Math.min(room, WOBBLE.length))
  const n = Math.max(4, words.length)
  const step = 100 / (n + 1)
  const pts = Array.from({ length: n }, (_, i) => ({ x: step * (i + 1), y: (i % 2 ? 36 : 64) + WOBBLE[i]! }))
  return (
    <div className="moons-think" aria-hidden="true">
      <svg>
        {pts.map((a, i) => {
          const b = pts[i + 1]
          return b && <line key={i} x1={`${a.x}%`} y1={`${a.y}%`} x2={`${b.x}%`} y2={`${b.y}%`} pathLength={1} style={{ '--delay': SEC(0.15 + i * 0.3) } as Vars} />
        })}
        {pts.map((a, i) => (
          <circle key={i} cx={`${a.x}%`} cy={`${a.y}%`} r={3.4} style={{ '--delay': SEC(i * 0.3) } as Vars} />
        ))}
      </svg>
      {words.map((word, i) => {
        const at = pts[i]!
        const style: Vars = { left: `${at.x}%`, top: `${at.y}%`, width: `calc(${2 * step}% - 14px)`, '--delay': SEC(0.1 + i * 0.3) }
        return (
          <span key={`${i}:${word}`} className={cn('moons-word', i % 2 === 1 && 'up')} style={style}>
            {word}
          </span>
        )
      })}
    </div>
  )
}

function PlanScene({ scene }: { scene: Extract<Scene, { kind: 'plan' }> }) {
  return (
    <>
      <Header left="Plan" right={`${scene.steps.length} steps`} />
      {scene.steps.map((s, i) => (
        <div key={i} className="moons-step" style={{ '--delay': SEC(0.15 + i * 0.35) } as Vars}>
          <i />
          <span>{s}</span>
        </div>
      ))}
    </>
  )
}

function WaitScene({ scene, actions }: { scene: Extract<Scene, { kind: 'wait' }>; actions: SceneActions }) {
  return (
    <div className="moons-ask" role="group" aria-label="Waiting for you">
      <span>{scene.question}</span>
      {scene.title && <code title={scene.title}>{scene.title}</code>}
      {scene.detail && <code title={scene.detail}>{scene.detail}</code>}
      <div>
        {scene.buttons === 'answer' ? (
          <>
            <button type="button" className="moons-btn p" onClick={() => actions.onAnswer(scene.sessionId, scene.requestId, true)}>
              {scene.allow}
            </button>
            <button type="button" className="moons-btn" onClick={() => actions.onAnswer(scene.sessionId, scene.requestId, false)}>
              Deny
            </button>
          </>
        ) : (
          <button type="button" className="moons-btn p" onClick={() => actions.onOpen(scene.sessionId)}>
            Open
          </button>
        )}
      </div>
    </div>
  )
}

function CompareScene({ scene, name, seat }: { scene: Extract<Scene, { kind: 'compare' }>; name: string; seat: 0 | 1 }) {
  const mine = seat === 0 ? scene.first : scene.second
  return (
    <>
      <Header left={`Only ${name}`} right={`${scene.both} found by both`} />
      {scene.rows.map((r, i) => (
        <div key={i} className="moons-row" style={{ '--delay': SEC(0.15 + i * 0.25) } as Vars}>
          {r}
        </div>
      ))}
      {mine === 0 && <div className="moons-row">Nothing that only {name} found.</div>}
    </>
  )
}

/** One scene, filling its card. `name` and `seat` are of the moon it belongs to (the comparison names it); `room` is how many words the thinking map holds. */
export function SceneBody({ scene, name, seat, room, actions }: { scene: Scene; name: string; seat: 0 | 1; room: number; actions: SceneActions }) {
  let body: React.ReactNode
  switch (scene.kind) {
    case 'think':
      body = <ThinkScene scene={scene} room={room} />
      break
    case 'read':
      body = <ReadScene scene={scene} />
      break
    case 'edit':
      // Keyed by the tool, and by whether its diff has landed: a new diff types its lines in again.
      body = <EditScene key={scene.key} scene={scene} />
      break
    case 'run':
      body = <RunScene scene={scene} />
      break
    case 'lens':
      body = <LensScene scene={scene} />
      break
    case 'wait':
      return <WaitScene scene={scene} actions={actions} />
    case 'plan':
      body = <PlanScene scene={scene} />
      break
    case 'compare':
      body = <CompareScene scene={scene} name={name} seat={seat} />
      break
    case 'done':
      return (
        <div className="moons-sum">
          <b>{scene.title}</b>
          {scene.text && <span>{scene.text}</span>}
        </div>
      )
  }
  return <>{body}</>
}
