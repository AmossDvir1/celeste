import { useEffect, useRef } from 'react'
import { ErrorNote } from './ErrorNote'
import { themeColor, useThemeName } from './chat'
import { parseChart } from './spec'

/** The colours a chart's series take, from the theme and never from the spec. */
const SERIES = ['--c-accent', '--c-info', '--c-success', '--c-warning', '--c-accent-text', '--c-danger']

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
      const colors = SERIES.map((c) => themeColor(c))
      const text = themeColor('--c-ink-muted')
      const grid = themeColor('--c-edge')
      chart = new Chart(canvas.current, {
        type: spec.type,
        data: {
          labels: spec.labels,
          datasets: spec.series.map((s, i) => ({
            label: s.name,
            data: s.data,
            backgroundColor: spec.type === 'pie' ? spec.labels.map((_, j) => colors[j % colors.length] as string) : (colors[i % colors.length] as string),
            borderColor: spec.type === 'line' ? (colors[i % colors.length] as string) : themeColor('--c-panel'),
            borderWidth: spec.type === 'pie' ? 2 : spec.type === 'line' ? 2 : 0
          }))
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: spec.series.length > 1 || spec.type === 'pie', labels: { color: text } },
            title: { display: !!spec.title, text: spec.title ?? '', color: themeColor('--c-ink') }
          },
          ...(spec.type === 'pie' ? {} : { scales: { x: { ticks: { color: text }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid } } } })
        }
      })
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
