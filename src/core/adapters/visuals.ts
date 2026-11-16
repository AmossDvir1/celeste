/*
 * What an assistant is told so that it draws a picture when one helps, without being asked (docs/plans/CHAT_DISPLAY_PLAN.md, 11a step 6).
 * Celeste draws a fenced `mermaid`, `chart`, `steps` or `excalidraw` block in an answer (src/renderer/features/visuals). Without this, a model writes a
 * Mermaid block only when asked for a diagram, and knows nothing of the other two. The examples are built from objects the tests check against
 * the same parsers the window uses, so the text cannot teach a format the window refuses.
 */

import type { AdapterContext } from './types'

const fence = (lang: string, body: string): string => '```' + lang + '\n' + body + '\n```'

export const MERMAID_EXAMPLE = '%% summary: A request goes from the browser to the server and then to the database.\nflowchart TD\n  A[Browser] --> B[Server]\n  B --> C[(Database)]'

export const CHART_EXAMPLE = {
  type: 'bar',
  title: 'Units sold',
  labels: ['Q1', 'Q2', 'Q3'],
  series: [{ name: 'Units', data: [3, 5, 8] }],
  summary: 'Sales grew every quarter, from 3 to 8 units.'
}

export const STEPS_EXAMPLE = {
  title: 'Turn on two-step sign-in',
  summary: 'Three steps in the account settings.',
  steps: [
    { title: 'Open the security settings', text: 'Click your picture, then Settings, then Security.', link: { label: 'Account settings', url: 'https://example.com/settings' } },
    { title: 'Choose an authenticator app', copy: 'Security > Two-step sign-in' },
    { title: 'Save the backup codes' }
  ]
}

/** A hand-drawn style sketch the person can edit. The assistant gives shapes and which are joined; Celeste places everything and works out the arrows. */
export const DRAWING_EXAMPLE = {
  title: 'Sign-in',
  summary: 'The browser asks the server, which asks the database.',
  shapes: [
    { id: 'browser', text: 'Browser' },
    { id: 'server', text: 'Server', color: 'blue' },
    { id: 'db', text: 'Database', kind: 'ellipse' }
  ],
  arrows: [{ from: 'browser', to: 'server', text: 'request' }, { from: 'server', to: 'db' }]
}

/** The instruction, as one text. About 500 words of guidance and four small examples. */
export const VISUALS_INSTRUCTION = [
  'Celeste can draw some code blocks as pictures in your answer. Use one only when it clearly makes the answer easier to understand, and otherwise answer in plain text. A short or factual answer never needs one. At most one or two pictures in an answer.',
  '',
  '1. A process with three or more steps, an architecture, or how requests or messages move between parts: a Mermaid flowchart or sequence diagram. The first line is a comment that says in one sentence what it shows. Keep it under about 20 boxes. Avoid gantt charts and mind maps.',
  fence('mermaid', MERMAID_EXAMPLE),
  '',
  '2. A comparison of three or more numbers, or a trend over time: a chart. The block holds JSON only: type is "bar", "line" or "pie" (a pie has one series), at most 50 labels and 6 series, and a summary sentence. Never put colours or code in it.',
  fence('chart', JSON.stringify(CHART_EXAMPLE, null, 2)),
  '',
  '3. How to do something outside Celeste in three or more steps (sign up for a service, change a setting in another program): a list of steps instead of a long numbered list. The block holds JSON only: at most 20 steps, each with a title and optionally text, a value to copy, and an https link. Celeste never runs anything in it.',
  fence('steps', JSON.stringify(STEPS_EXAMPLE, null, 2)),
  '',
  '4. Only when the person asks for a sketch, a wireframe or a drawing they can change, or sends you a drawing (a picture, and a file drawing.excalidraw) and asks for a different one: a drawing, in a hand-drawn style that they can edit in Celeste. The block holds JSON only: shapes (an id, text, a kind of box, ellipse, diamond or text, and optionally a colour of default, blue, green, orange, red or purple) and arrows between shape ids (from, to, optional text). Do not give coordinates or sizes: Celeste places everything. At most 40 shapes. To change a drawing, send a whole new block. For a process or a flow, prefer a Mermaid diagram.',
  fence('excalidraw', JSON.stringify(DRAWING_EXAMPLE, null, 2)),
  '',
  'Write the answer in words as well, so it makes sense without the picture. If you are told a picture could not be drawn, fix it and send the block again.'
].join('\n')

/**
 * The instruction for a session, or nothing where it does not belong: a step of a workflow answers for the workflow, and its words
 * go to a later step or into a file, so no picture is wanted there.
 */
export function visualsFor(ctx: Pick<AdapterContext, 'sessionId'>): string | undefined {
  return ctx.sessionId.startsWith('wf-') ? undefined : VISUALS_INSTRUCTION
}
