import { useEffect, useRef } from 'react'
import type { ChartConfiguration } from 'chart.js'
import { ErrorNote } from './ErrorNote'
import { useThemeName } from './chat'
import { chartColors, chartConfig } from './colors'
import { parseChart } from './spec'

/** A bar, line or pie chart from a small JSON spec, drawn by Chart.js on a canvas when first needed (a separate chunk). No animation, no script. */
export function ChartBlock({ source }: { source: string }) {
  const theme = useThemeName()
  const canvas = useRef<HTMLCanvasElement>(null)
  const parsed = parseChart(source)
  const ok = parsed.ok

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

  if (!parsed.ok) return <ErrorNote kind="chart" error={parsed.error} source={source} />
  const spec = parsed.value
  return (
    <figure className="my-3 max-w-[760px] rounded-xl border border-edge bg-field p-3">
      <div className="h-[260px]">
        <canvas ref={canvas} role="img" aria-label={spec.summary ?? spec.title ?? 'Chart'} />
      </div>
      {spec.summary && <figcaption className="mt-2 text-center text-[12.5px] text-ink-muted">{spec.summary}</figcaption>}
      <details className="mt-2 text-[12.5px] text-ink-muted" data-ok={ok}>
        <summary className="cursor-pointer select-none hover:text-ink">Show the numbers</summary>
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="border-b border-edge px-2 py-1 font-medium" />
                {spec.series.map((s, i) => (
                  <th key={i} className="border-b border-edge px-2 py-1 font-medium">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.labels.map((l, row) => (
                <tr key={row}>
                  <th className="border-b border-edge/60 px-2 py-1 text-left font-normal text-ink">{l}</th>
                  {spec.series.map((s, i) => (
                    <td key={i} className="border-b border-edge/60 px-2 py-1 text-ink tabular-nums">
                      {s.data[row] ?? ''}
                    </td>
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
