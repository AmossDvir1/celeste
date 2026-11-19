import { useEffect, useState } from 'react'
import { ErrorNote } from './ErrorNote'
import { useThemeName } from './chat'
import { mermaidThemeVariables } from './colors'
import { hashOf, prepareMermaid } from './spec'

let counter = 0

/**
 * A Mermaid diagram, drawn by the library when it is first needed (a separate chunk). `securityLevel: 'strict'` always: the text of the
 * answer never changes the library's settings, and what it draws is cleaned by the library before it reaches the page.
 */
export function MermaidBlock({ source }: { source: string }) {
  const theme = useThemeName()
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

  if (drawn && 'error' in drawn) return <ErrorNote kind="mermaid" error={drawn.error} source={source} />
  const summary = checked.ok ? checked.value.summary : undefined
  return (
    <figure role="img" aria-label={summary ?? 'Diagram'} className="my-3 max-w-[760px] overflow-x-auto rounded-xl border border-edge bg-field p-3">
      {drawn && 'svg' in drawn ? (
        <div className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      ) : (
        <div className="h-16 animate-pulse rounded-lg bg-raised/60" aria-hidden />
      )}
      {summary && <figcaption className="mt-2 text-center text-[12.5px] text-ink-muted">{summary}</figcaption>}
    </figure>
  )
}
