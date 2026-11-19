import type { DrawingPalette } from './drawingSvg'
import type { ChartSpec } from './spec'

/*
 * What the pictures in an answer take from the theme, kept apart from any screen so the computer and the phone draw them alike: the value of a
 * theme colour, the library's colours for Mermaid, and the whole configuration of a chart. No store and no window of the app is imported here.
 */

/** The value of one of the theme's colours (a token such as `--c-ink`), for a library that cannot read a CSS variable. */
export function themeColor(name: string, fallback = '#888888'): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** The library's colours from the theme's own, so a diagram looks like the rest of the screen in both themes. Solid colours only. */
export function mermaidThemeVariables(): Record<string, string> {
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

/** The colours a chart's series take, from the theme and never from the spec. */
const SERIES_TOKENS = ['--c-accent', '--c-info', '--c-success', '--c-warning', '--c-accent-text', '--c-danger']

export interface ChartColors {
  series: string[]
  text: string
  grid: string
  ink: string
  panel: string
}

export function chartColors(): ChartColors {
  return { series: SERIES_TOKENS.map((c) => themeColor(c)), text: themeColor('--c-ink-muted'), grid: themeColor('--c-edge'), ink: themeColor('--c-ink'), panel: themeColor('--c-panel') }
}

/** A bar, line or pie chart as Chart.js is configured for it: no animation, no script, the colours given. */
export function chartConfig(spec: ChartSpec, c: ChartColors, opts: { responsive?: boolean } = {}) {
  const color = (i: number) => c.series[i % c.series.length] as string
  return {
    type: spec.type,
    data: {
      labels: spec.labels,
      datasets: spec.series.map((s, i) => ({
        label: s.name,
        data: s.data,
        backgroundColor: spec.type === 'pie' ? spec.labels.map((_, j) => color(j)) : color(i),
        borderColor: spec.type === 'line' ? color(i) : c.panel,
        borderWidth: spec.type === 'pie' ? 2 : spec.type === 'line' ? 2 : 0
      }))
    },
    options: {
      animation: false,
      responsive: opts.responsive ?? true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: spec.series.length > 1 || spec.type === 'pie', labels: { color: c.text } },
        title: { display: !!spec.title, text: spec.title ?? '', color: c.ink }
      },
      ...(spec.type === 'pie' ? {} : { scales: { x: { ticks: { color: c.text }, grid: { color: c.grid } }, y: { ticks: { color: c.text }, grid: { color: c.grid } } } })
    }
  }
}

/** What a drawing's named colours are in the theme now (the same names the assistant may use, never a colour it chose). */
export function drawingPalette(): DrawingPalette {
  const ink = themeColor('--c-ink')
  return {
    ink,
    paper: themeColor('--c-panel'),
    colors: { default: ink, blue: themeColor('--c-info'), green: themeColor('--c-success'), orange: themeColor('--c-warning'), red: themeColor('--c-danger'), purple: themeColor('--c-accent-text') }
  }
}
