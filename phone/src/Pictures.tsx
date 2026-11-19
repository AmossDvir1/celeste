import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChartConfiguration } from 'chart.js'
import { Check, CircleAlert, Copy, ExternalLink, Maximize2, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { layoutDrawing, parseDrawing } from '@/features/visuals/drawing'
import { chartColors, chartConfig, drawingPalette, mermaidThemeVariables } from '@/features/visuals/colors'
import { drawingSvg } from '@/features/visuals/drawingSvg'
import { MAX_RETRIES, hashOf, noteRetry, parseChart, parseSteps, prepareMermaid, retriesOf, retryMessage, type VisualKind } from '@/features/visuals/spec'
import { useApp } from './store'
import { Shimmer, buzz } from './ui'

/*
 * The diagrams, charts, steps and drawings an assistant puts in an answer, drawn on the phone as on the computer (docs/plans/CHAT_DISPLAY_PLAN.md).
 * The same checks run on the text first (`spec.ts`), the same colours come from the theme (`colors.ts`), and the heavy libraries (Mermaid,
 * Chart.js) are loaded only when a picture of that kind appears. A drawing is plain SVG (the drawing board's library is not on the phone).
 * Nothing in a picture can run or open anything by itself: Mermaid is always in its strict mode, and the SVG of a drawing is written here from
 * checked shapes with every piece of text escaped.
 */

const NAME: Record<VisualKind, string> = { mermaid: 'diagram', chart: 'chart', steps: 'steps', excalidraw: 'drawing' }

/** The theme in use ('dark' or 'light'), so a picture is drawn again in the other colours when it changes. */
function useTheme(): string {
  const read = () => document.documentElement.dataset['theme'] ?? 'dark'
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watch.disconnect()
  }, [])
  return theme
}

/** A fenced block that is a picture: drawn when it is whole, and while the answer is still arriving a quiet "Drawing…" in its place. */
export function Picture({ kind, source, sessionId, open }: { kind: VisualKind; source: string; sessionId: string; open: string | null }) {
  const working = useApp((s) => (s.sessions[sessionId]?.status ?? 'idle') !== 'idle')
  if (open !== null && working && open.trim() === source.trim()) {
    return (
      <div className="pic" role="status" aria-label={`Drawing the ${NAME[kind]}`}>
        <Shimmer>Drawing…</Shimmer>
      </div>
    )
  }
  return kind === 'mermaid' ? <MermaidPic source={source} sessionId={sessionId} /> : kind === 'chart' ? <ChartPic source={source} sessionId={sessionId} /> : kind === 'excalidraw' ? <DrawingPic source={source} sessionId={sessionId} /> : <StepsPic source={source} sessionId={sessionId} />
}

/** What a picture shows when it cannot be drawn: a sentence, Try again (the error goes back to the assistant, at most twice), and nothing of the source. */
function PicError({ kind, error, source, sessionId }: { kind: VisualKind; error: string; source: string; sessionId: string }) {
  const [, again] = useState(0)
  const hash = hashOf(source)
  const left = MAX_RETRIES - retriesOf(sessionId, hash)
  return (
    <div className="pic pic-error" role="group" aria-label={`The ${NAME[kind]} could not be drawn`}>
      <CircleAlert size={18} className="faint" />
      <div className="grow">
        <div className="t">Couldn’t draw this {NAME[kind]}</div>
        <div className="small faint">{left > 0 ? 'The assistant can be asked to fix it.' : 'It was sent back twice and still did not work.'}</div>
        {left > 0 && (
          <button
            type="button"
            className="btn tonal"
            style={{ height: 38, marginTop: 8 }}
            onClick={() => {
              buzz(8)
              noteRetry(sessionId, hash)
              void useApp.getState().send(sessionId, retryMessage(kind, error), [], [], 'queue').catch(() => undefined)
              again((n) => n + 1)
            }}
          >
            <RotateCcw size={15} /> Try again
          </button>
        )}
      </div>
    </div>
  )
}

/** A picture made of SVG, shown at the width of the screen; a tap opens it large, to look at the small parts. */
function Art({ html, label, caption }: { html: string; label: string; caption?: string }) {
  const [big, setBig] = useState(false)
  return (
    <figure className="pic">
      <button type="button" className="pic-art" aria-label={`Enlarge: ${label}`} onClick={() => setBig(true)}>
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <span className="pic-zoom" aria-hidden>
          <Maximize2 size={14} />
        </span>
      </button>
      {caption && <figcaption>{caption}</figcaption>}
      {big && <Viewer title={label} html={html} onClose={() => setBig(false)} />}
    </figure>
  )
}

const ZOOMS = [1, 1.5, 2, 3, 4]

/** The picture over the whole screen, with Zoom in and out; the page scrolls both ways when it is larger than the screen. */
function Viewer({ title, html, onClose }: { title: string; html: string; onClose: () => void }) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="pv" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pv-head">
        <button type="button" className="iconbtn" aria-label="Close the picture" onClick={onClose}>
          <X size={22} />
        </button>
        <h1 className="h-l" style={{ fontSize: 16, flex: 1 }}>
          {title}
        </h1>
        <button type="button" className="iconbtn" aria-label="Zoom out" disabled={step === 0} onClick={() => setStep((n) => Math.max(0, n - 1))}>
          <Minus size={20} />
        </button>
        <button type="button" className="iconbtn" aria-label="Zoom in" disabled={step === ZOOMS.length - 1} onClick={() => setStep((n) => Math.min(ZOOMS.length - 1, n + 1))}>
          <Plus size={20} />
        </button>
      </div>
      <div className="pv-body">
        <div className="pv-art" style={{ width: `${(ZOOMS[step] as number) * 100}%` }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>,
    document.body
  )
}

// --- Mermaid -----------------------------------------------------------------------------------------

let counter = 0

function MermaidPic({ source, sessionId }: { source: string; sessionId: string }) {
  const theme = useTheme()
  const [drawn, setDrawn] = useState<{ svg: string } | { error: string } | null>(null)
  const checked = prepareMermaid(source)

  useEffect(() => {
    if (!checked.ok) {
      setDrawn({ error: checked.error })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        // 'strict' always: the text of an answer never changes the library's settings, and what it draws is cleaned by the library.
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', themeVariables: mermaidThemeVariables() })
        const { svg } = await mermaid.render(`mermaid-${hashOf(checked.value.source)}-${++counter}`, checked.value.source)
        if (!cancelled) setDrawn({ svg })
      } catch (err) {
        if (!cancelled) setDrawn({ error: err instanceof Error ? err.message.split('\n')[0]?.slice(0, 300) || 'It is not a diagram the library understands.' : 'It is not a diagram the library understands.' })
      }
    })()
    return () => {
      cancelled = true
    }
    // Drawn again when the text or the theme changes.
  }, [source, theme]) // eslint-disable-line react-hooks/exhaustive-deps

  if (drawn && 'error' in drawn) return <PicError kind="mermaid" error={drawn.error} source={source} sessionId={sessionId} />
  const summary = checked.ok ? checked.value.summary : undefined
  if (!drawn) {
    return (
      <div className="pic" aria-busy="true" aria-label="Drawing the diagram">
        <div className="pic-wait" />
      </div>
    )
  }
  return <Art html={drawn.svg} label={summary ?? 'Diagram'} caption={summary} />
}

// --- Chart -------------------------------------------------------------------------------------------

function ChartPic({ source, sessionId }: { source: string; sessionId: string }) {
  const theme = useTheme()
  const canvas = useRef<HTMLCanvasElement>(null)
  const parsed = parseChart(source)

  useEffect(() => {
    if (!parsed.ok || !canvas.current) return
    const spec = parsed.value
    let chart: { destroy(): void } | undefined
    let cancelled = false
    void (async () => {
      const { Chart } = await import('chart.js/auto')
      if (cancelled || !canvas.current) return
      chart = new Chart(canvas.current, chartConfig(spec, chartColors()) as ChartConfiguration)
    })()
    return () => {
      cancelled = true
      chart?.destroy()
    }
  }, [source, theme]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!parsed.ok) return <PicError kind="chart" error={parsed.error} source={source} sessionId={sessionId} />
  const spec = parsed.value
  return (
    <figure className="pic">
      <div className="pic-chart">
        <canvas ref={canvas} role="img" aria-label={spec.summary ?? spec.title ?? 'Chart'} />
      </div>
      {spec.summary && <figcaption>{spec.summary}</figcaption>}
      <details className="pic-numbers">
        <summary>Show the numbers</summary>
        <div className="pic-table">
          <table>
            <thead>
              <tr>
                <th />
                {spec.series.map((s, i) => (
                  <th key={i}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.labels.map((l, row) => (
                <tr key={row}>
                  <th>{l}</th>
                  {spec.series.map((s, i) => (
                    <td key={i}>{s.data[row] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

// --- Drawing -----------------------------------------------------------------------------------------

function DrawingPic({ source, sessionId }: { source: string; sessionId: string }) {
  const theme = useTheme()
  const made = useMemo(() => {
    const parsed = parseDrawing(source)
    if (!parsed.ok) return { ok: false as const, error: parsed.error }
    const label = parsed.value.summary ?? parsed.value.title ?? 'Drawing'
    return { ok: true as const, svg: drawingSvg(layoutDrawing(parsed.value), drawingPalette(), label).svg, spec: parsed.value, label }
    // The colours are read from the theme, so it is made again when the theme changes.
  }, [source, theme]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!made.ok) return <PicError kind="excalidraw" error={made.error} source={source} sessionId={sessionId} />
  return <Art html={made.svg} label={made.label} caption={made.spec.summary} />
}

// --- Steps -------------------------------------------------------------------------------------------

/** The steps ticked off, kept on this phone per chat and per block, so they are still ticked after a restart. Never shared. */
function loadTicks(key: string): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

function StepsPic({ source, sessionId }: { source: string; sessionId: string }) {
  const parsed = parseSteps(source)
  const key = `celeste.steps.${sessionId}.${hashOf(source)}`
  const [ticks, setTicks] = useState(() => loadTicks(key))
  const [copied, setCopied] = useState<number | null>(null)
  if (!parsed.ok) return <PicError kind="steps" error={parsed.error} source={source} sessionId={sessionId} />
  const spec = parsed.value
  const done = spec.steps.filter((_, i) => ticks.includes(i)).length
  const toggle = (i: number) => {
    buzz(6)
    const next = ticks.includes(i) ? ticks.filter((t) => t !== i) : [...ticks, i]
    setTicks(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* no room, or storage is blocked: the ticks last until the screen does */
    }
  }
  return (
    <section className="pic" aria-label={spec.title}>
      <div className="pic-head">
        <h3>{spec.title}</h3>
        <span className="small faint" aria-live="polite">
          {done} of {spec.steps.length} done
        </span>
      </div>
      {spec.summary && <p className="small faint" style={{ margin: '2px 0 0' }}>{spec.summary}</p>}
      <ol className="pic-steps">
        {spec.steps.map((s, i) => {
          const on = ticks.includes(i)
          return (
            <li key={i}>
              <button type="button" role="checkbox" aria-checked={on} aria-label={`Step ${i + 1}: ${s.title}`} className={`pic-box${on ? ' on' : ''}`} onClick={() => toggle(i)}>
                {on && <Check size={14} />}
              </button>
              <div className="grow">
                <div className={`pic-step${on ? ' done' : ''}`}>
                  <span className="faint">{i + 1}.</span> {s.title}
                </div>
                {s.text && <div className="small faint pic-text">{s.text}</div>}
                {(s.copy || s.link) && (
                  <div className="pic-extras">
                    {s.copy && (
                      <span className="pic-copy">
                        <code>{s.copy}</code>
                        <button
                          type="button"
                          aria-label={`Copy: ${s.copy}`}
                          onClick={() => {
                            void navigator.clipboard?.writeText(s.copy as string)
                            buzz(8)
                            setCopied(i)
                            setTimeout(() => setCopied((c) => (c === i ? null : c)), 1400)
                          }}
                        >
                          {copied === i ? <Check size={14} /> : <Copy size={14} />}
                          {copied === i ? 'Copied' : 'Copy'}
                        </button>
                      </span>
                    )}
                    {s.link && (
                      <a href={s.link.url} target="_blank" rel="noopener noreferrer">
                        {s.link.label} <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
