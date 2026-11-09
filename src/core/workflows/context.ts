/**
 * An assistant step runs in a session of its own, so by itself it knows nothing of the steps before it: "go to my friends list" after
 * "go to my Facebook" would ask which list. So each step is given what the earlier ones were asked to do and what they produced, ahead of
 * its own instruction. The words of the person's step are not changed; this is a note before them.
 */

export interface StepRecord {
  /** The step's name. */
  name: string
  /** What it was asked to do, with its inputs filled in. */
  task: string
  /** What it produced. Empty when it was skipped or produced nothing. */
  output: string
}

const EACH = 1500
const TOTAL = 6000

/** The start and the end of a long text, which is where the result and the reason usually are. */
function clipMiddle(text: string, limit: number): string {
  const t = text.trim()
  if (t.length <= limit) return t
  const head = Math.floor(limit * 0.6)
  return `${t.slice(0, head)}\n…\n${t.slice(-(limit - head))}`
}

/** The note that goes before a step's own instruction, or an empty text for the first step. Recent steps matter most, so the oldest go first when it is too long. */
export function stepContext(history: StepRecord[]): string {
  if (!history.length) return ''
  const lines: string[] = []
  let used = 0
  let left = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i] as StepRecord
    const block = `Step ${i + 1}, “${h.name}”: ${clipMiddle(h.task, 600)}\nResult: ${h.output.trim() ? clipMiddle(h.output, EACH) : '(nothing)'}`
    if (used + block.length > TOTAL && lines.length) {
      left = i + 1
      break
    }
    lines.unshift(block)
    used += block.length
  }
  return [
    'This is one step of a workflow that runs its steps in order. Below is what the earlier steps were asked to do and what they produced. Carry on from where they left off: when your instruction says “it”, “there”, “the list” or the like, it means what those steps were about. Do not do their work again.',
    '',
    ...(left ? [`(${left} earlier ${left === 1 ? 'step is' : 'steps are'} left out.)`, ''] : []),
    lines.join('\n\n'),
    '',
    'Your step now:'
  ].join('\n')
}
