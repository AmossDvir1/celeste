import { useEffect, useState } from 'react'
import { ErrorNote } from './ErrorNote'
import { themeColor, useThemeName } from './chat'
import { hashOf, prepareMermaid } from './spec'

/** The library's colours from the theme's own, so a diagram looks like the rest of the window in both themes. Solid colours only. */
function mermaidTheme(): Record<string, string> {
  const ink = themeColor('--c-ink')
  const edge = themeColor('--c-edge-strong')
  const box = themeColor('--c-raised-2')
  return {
    primaryColor: box,
    primaryTextColor: ink,
    primaryBorderColor: themeColor('--c-accent'),
    secondaryColor: themeColor('--c-raised'),
    secondaryTextColor: ink,
    tertiaryColor: themeColor('--c-field'),
    tertiaryTextColor: ink,
    lineColor: themeColor('--c-ink-muted'),
    textColor: ink,
    background: themeColor('--c-panel'),
    mainBkg: box,
    nodeBorder: themeColor('--c-accent'),
    clusterBkg: themeColor('--c-field'),
    clusterBorder: edge,
    edgeLabelBackground: themeColor('--c-panel'),
    noteBkgColor: themeColor('--c-raised'),
    noteTextColor: ink,
    noteBorderColor: edge,
    actorBkg: box,
    actorBorder: themeColor('--c-accent'),
    actorTextColor: ink,
    actorLineColor: themeColor('--c-ink-faint'),
    signalColor: themeColor('--c-ink-muted'),
    signalTextColor: ink,
    labelBoxBkgColor: themeColor('--c-raised'),
    labelTextColor: ink,
    fontFamily: 'inherit'
  }
}

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
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', themeVariables: mermaidTheme() })
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
