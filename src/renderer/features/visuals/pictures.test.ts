import { describe, expect, it } from 'vitest'
import { chartConfig, type ChartColors } from './colors'
import { layoutDrawing, parseDrawing, type DrawingSpec } from './drawing'
import { drawingSvg, type DrawingPalette } from './drawingSvg'
import { parseChart } from './spec'

/*
 * The parts of a picture that are not about a screen: a drawing as SVG (what the phone draws, with no drawing library) and a chart as Chart.js
 * is configured for it (shared by the computer and the phone).
 */

const palette: DrawingPalette = { ink: '#111111', paper: '#ffffff', colors: { default: '#111111', blue: '#0000ff', green: '#00aa00', orange: '#ff8800', red: '#ff0000', purple: '#8800ff' } }
const spec = (v: unknown): DrawingSpec => {
  const r = parseDrawing(JSON.stringify(v))
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const draw = (v: unknown) => drawingSvg(layoutDrawing(spec(v)), palette, 'A drawing')

describe('a drawing as SVG', () => {
  const flow = { shapes: [{ id: 'a', text: 'Browser' }, { id: 'b', text: 'Database', kind: 'ellipse', color: 'blue' }, { id: 'c', text: 'Choice', kind: 'diamond' }], arrows: [{ from: 'a', to: 'b', text: 'request' }, { from: 'b', to: 'c' }] }

  it('has a shape for each kind, the words in them, an arrowhead and the label of an arrow', () => {
    const { svg } = draw(flow)
    expect(svg).toMatch(/^<svg [^>]*viewBox="[-\d. ]+"/)
    expect(svg).toContain('<rect')
    expect(svg).toContain('<ellipse')
    expect(svg).toContain('<polygon')
    for (const w of ['Browser', 'Database', 'Choice', 'request']) expect(svg).toContain(w)
    // Two arrows: a line and a head each.
    expect(svg.match(/<line /g)).toHaveLength(2)
  })

  it('names the picture for a screen reader, and takes colours from the palette by name only', () => {
    const { svg } = draw(flow)
    expect(svg).toContain('aria-label="A drawing"')
    expect(svg).toContain('role="img"')
    expect(svg).toContain('#0000ff')
    // Every colour in it is one of the palette's.
    const allowed = new Set([...Object.values(palette.colors), palette.ink, palette.paper])
    for (const c of svg.match(/#[0-9a-f]{6}/gi) ?? []) expect(allowed.has(c)).toBe(true)
  })

  it('gives every line of a shape’s text its own line', () => {
    const { svg } = draw({ shapes: [{ id: 'a', text: 'one\ntwo\nthree' }] })
    expect(svg.match(/<tspan /g)).toHaveLength(3)
  })

  it('escapes everything, so nothing in a drawing can become markup or script', () => {
    const evil = `</text><script>alert(1)</script><img src=x onerror="alert(2)"> & "q" 'q'`
    const { svg } = draw({ title: evil, shapes: [{ id: 'a', text: evil }, { id: 'b', text: 'ok' }], arrows: [{ from: 'a', to: 'b', text: evil }] })
    // The only tags are the drawing's own, and none has an attribute that runs anything: the evil words are text, escaped.
    const tags = svg.match(/<[^>]*>/g) ?? []
    for (const t of tags) {
      expect(t).toMatch(/^<\/?(svg|g|rect|ellipse|polygon|text|tspan|line)[\s/>]/)
      expect(t).not.toMatch(/\son\w+\s*=/i)
    }
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&quot;q&quot;')
    expect(svg).toContain('&#39;q&#39;')
    expect(svg).toContain('&amp;')
  })

  it('writes no attribute the assistant could choose: a colour outside the list is refused before this', () => {
    expect(parseDrawing(JSON.stringify({ shapes: [{ id: 'a', text: 'x', color: 'red" onload="x' }] })).ok).toBe(false)
    const { svg } = draw({ shapes: [{ id: 'a', text: 'x', color: 'red' }] })
    expect(svg).toContain('#ff0000')
    expect(svg).not.toMatch(/\son[a-z]+=/i)
  })

  it('has a viewBox that holds every shape, with room round them', () => {
    const l = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A', x: -100, y: 40 }, { id: 'b', text: 'B', x: 600, y: 300 }], arrows: [{ from: 'a', to: 'b' }] }))
    const { svg, width, height } = drawingSvg(l, palette, 'x')
    const [x, y, w, h] = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)!.slice(1).map(Number) as [number, number, number, number]
    for (const s of l.shapes) {
      expect(s.x).toBeGreaterThan(x)
      expect(s.y).toBeGreaterThan(y)
      expect(s.x + s.width).toBeLessThan(x + w)
      expect(s.y + s.height).toBeLessThan(y + h)
    }
    expect(width).toBeCloseTo(w)
    expect(height).toBeCloseTo(h)
  })

  it('draws one shape alone, and no arrow for shapes that touch', () => {
    expect(draw({ shapes: [{ id: 'a', text: 'Only' }] }).svg).toContain('Only')
    expect(draw({ shapes: [{ id: 'a', text: 'A', x: 0, y: 0 }, { id: 'b', text: 'B', x: 5, y: 0 }], arrows: [{ from: 'a', to: 'b' }] }).svg).not.toContain('<line')
  })

  it('draws a text shape as words alone, with no outline', () => {
    const { svg } = draw({ shapes: [{ id: 'a', kind: 'text', text: 'Just words' }] })
    expect(svg).toContain('Just words')
    expect(svg).not.toMatch(/<rect|<ellipse|<polygon/)
  })
})

describe('a chart as Chart.js is configured for it', () => {
  const colors: ChartColors = { series: ['#111', '#222', '#333'], text: '#aaa', grid: '#bbb', ink: '#ccc', panel: '#ddd' }
  const chart = (v: unknown) => {
    const r = parseChart(JSON.stringify(v))
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('gives a bar chart one colour for each series, no animation, and axes in the theme’s colours', () => {
    const c = chartConfig(chart({ type: 'bar', labels: ['a', 'b'], series: [{ name: 'x', data: [1, 2] }, { name: 'y', data: [3, 4] }] }), colors)
    expect(c.type).toBe('bar')
    expect(c.data.datasets.map((d) => d.backgroundColor)).toEqual(['#111', '#222'])
    expect(c.options.animation).toBe(false)
    expect(c.options.scales).toMatchObject({ x: { ticks: { color: '#aaa' }, grid: { color: '#bbb' } } })
    expect(c.options.plugins.legend.display).toBe(true)
  })

  it('hides the legend for one series, and gives a pie one colour for each slice, with no axes', () => {
    expect(chartConfig(chart({ type: 'line', labels: ['a'], series: [{ name: 'x', data: [1] }] }), colors).options.plugins.legend.display).toBe(false)
    const pie = chartConfig(chart({ type: 'pie', labels: ['a', 'b', 'c', 'd'], series: [{ name: 'x', data: [1, 2, 3, 4] }] }), colors)
    expect(pie.data.datasets[0]?.backgroundColor).toEqual(['#111', '#222', '#333', '#111'])
    expect(pie.options).not.toHaveProperty('scales')
    expect(pie.options.plugins.legend.display).toBe(true)
  })

  it('shows a title only when there is one, and never takes a colour from the spec', () => {
    expect(chartConfig(chart({ type: 'bar', labels: ['a'], series: [{ name: 'x', data: [1] }], title: 'Sales' }), colors).options.plugins.title).toMatchObject({ display: true, text: 'Sales' })
    expect(chartConfig(chart({ type: 'bar', labels: ['a'], series: [{ name: 'x', data: [1] }] }), colors).options.plugins.title.display).toBe(false)
    expect(JSON.stringify(chartConfig(chart({ type: 'bar', labels: ['a'], series: [{ name: 'x', data: [1], color: 'red' }] }), colors))).not.toContain('red')
  })
})
