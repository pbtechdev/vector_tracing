import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS } from '../constants/defaults'
import { settings, shapeRaster } from '../test/helpers'
import type { SubPath } from '../types/vectorTrace'
import { buildSvg, computeOutputSize, formatNumber, subpathToPathData, svgFileName } from './svgExporter'
import { traceRaster } from './vectorization'

const ring = shapeRaster(200, 100, (x, y) => {
  const d = Math.hypot(x - 100, y - 50)
  return d < 40 && d > 20
})
const traced = traceRaster({ raster: ring, sourceWidth: 200, sourceHeight: 100, settings: settings() })

describe('formatNumber', () => {
  it('trims trailing zeros and negative zero', () => {
    expect(formatNumber(1.5, 2)).toBe('1.5')
    expect(formatNumber(2, 2)).toBe('2')
    expect(formatNumber(-0.0001, 2)).toBe('0')
    expect(formatNumber(3.14159, 3)).toBe('3.142')
    expect(formatNumber(Number.NaN, 2)).toBe('0')
  })
})

describe('subpathToPathData', () => {
  it('serializes lines and cubic curves and closes paths', () => {
    const path: SubPath = {
      start: { x: 0, y: 0 },
      closed: true,
      segments: [
        { type: 'L', to: { x: 10, y: 0 } },
        { type: 'C', c1: { x: 12, y: 2 }, c2: { x: 12, y: 8 }, to: { x: 10, y: 10 } },
        { type: 'L', to: { x: 0, y: 0 } },
      ],
    }
    expect(subpathToPathData(path, 2)).toBe('M0 0L10 0C12 2 12 8 10 10Z')
  })
})

describe('buildSvg', () => {
  const svg = buildSvg(traced, DEFAULT_EXPORT_SETTINGS)

  it('is a standalone SVG with matching viewBox and dimensions', () => {
    expect(svg.startsWith('<?xml')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('viewBox="0 0 200 100"')
    expect(svg).toContain('width="200"')
    expect(svg).toContain('height="100"')
    expect(svg.trim().endsWith('</svg>')).toBe(true)
  })

  it('contains vector paths and never embeds the bitmap', () => {
    expect(svg).toMatch(/<path d="M[^"]+Z/)
    expect(svg).not.toMatch(/<image/i)
    expect(svg).not.toMatch(/data:/i)
    expect(svg).not.toMatch(/base64/i)
  })

  it('preserves holes with an even-odd fill rule in a single compound path', () => {
    expect(svg).toContain('fill-rule="evenodd"')
    const pathCount = (svg.match(/<path /g) ?? []).length
    expect(pathCount).toBe(1)
    const d = /<path d="([^"]+)"/.exec(svg)?.[1] ?? ''
    expect((d.match(/M/g) ?? []).length).toBe(2)
  })

  it('applies the chosen style', () => {
    const outline = buildSvg(traced, { ...DEFAULT_EXPORT_SETTINGS, style: 'stroke', strokeColor: '#ff0000', strokeWidth: 2 })
    expect(outline).toContain('fill="none"')
    expect(outline).toContain('stroke="#ff0000"')
    expect(outline).toContain('stroke-width="2"')
  })

  it('converts to physical units while keeping the aspect ratio', () => {
    const mm = buildSvg(traced, { ...DEFAULT_EXPORT_SETTINGS, unit: 'mm', dpi: 300 })
    const w = Number(/width="([\d.]+)mm"/.exec(mm)?.[1])
    const h = Number(/height="([\d.]+)mm"/.exec(mm)?.[1])
    expect(w).toBeCloseTo((200 / 300) * 25.4, 2)
    expect(w / h).toBeCloseTo(2, 2)
    expect(mm).toContain('viewBox="0 0 200 100"')
  })

  it('respects coordinate precision', () => {
    const coarse = buildSvg(traced, { ...DEFAULT_EXPORT_SETTINGS, precision: 0 })
    const d = /<path d="([^"]+)"/.exec(coarse)?.[1] ?? ''
    expect(d).not.toContain('.')
    expect(coarse.length).toBeLessThan(svg.length)
  })

  it('exports an empty but valid document when nothing was traced', () => {
    const empty = buildSvg({ width: 10, height: 10, shapes: [], mode: 'outline' }, DEFAULT_EXPORT_SETTINGS)
    expect(empty).toContain('<svg')
    expect(empty).not.toContain('<path')
  })

  it('rejects empty dimensions and sanitises colours and titles', () => {
    expect(() => buildSvg({ width: 0, height: 10, shapes: [], mode: 'outline' }, DEFAULT_EXPORT_SETTINGS)).toThrow()
    const odd = buildSvg(traced, { ...DEFAULT_EXPORT_SETTINGS, style: 'fill', fillColor: 'url(javascript:x)' }, '<b>&')
    expect(odd).toContain('fill="#000000"')
    expect(odd).toContain('<title>&lt;b&gt;&amp;</title>')
  })

  it('writes centerline strokes without fill', () => {
    const line = shapeRaster(80, 30, (x, y) => x > 5 && x < 75 && y > 10 && y < 20)
    const center = traceRaster({ raster: line, sourceWidth: 80, sourceHeight: 30, settings: settings({ mode: 'centerline' }) })
    const out = buildSvg(center, DEFAULT_EXPORT_SETTINGS)
    expect(out).toContain('id="traced-centerlines" fill="none"')
    expect(out).toMatch(/<path d="M[^"Z]+"\/>/)
  })
})

describe('centerline stroke widths', () => {
  const twoLines = shapeRaster(200, 120, (x, y) => (x > 20 && x < 180 && Math.abs(y - 30) < 3) || (x > 20 && x < 180 && Math.abs(y - 90) < 8))
  const center = traceRaster({ raster: twoLines, sourceWidth: 200, sourceHeight: 120, settings: settings({ mode: 'centerline' }) })

  it('uses the detected median width on the group by default', () => {
    const out = buildSvg(center, DEFAULT_EXPORT_SETTINGS)
    const w = Number(/id="traced-centerlines"[^>]*stroke-width="([\d.]+)"/.exec(out)?.[1])
    expect(w).toBeCloseTo(center.estimatedStrokeWidth, 2)
  })

  it('writes each stroke with its own width in per-path mode', () => {
    const out = buildSvg(center, { ...DEFAULT_EXPORT_SETTINGS, centerlineWidth: 'per-path' })
    const widths = [...out.matchAll(/<path stroke-width="([\d.]+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
    expect(widths).toHaveLength(2)
    expect(widths[0]).toBeLessThan(8)
    expect(widths[1]).toBeGreaterThan(13)
  })

  it('uses the custom width when requested', () => {
    const out = buildSvg(center, { ...DEFAULT_EXPORT_SETTINGS, centerlineWidth: 'custom', strokeWidth: 0.5 })
    expect(out).toMatch(/id="traced-centerlines"[^>]*stroke-width="0.5"/)
  })
})

describe('helpers', () => {
  it('computes output sizes', () => {
    expect(computeOutputSize(96, 48, 'in', 96)).toEqual({ width: 1, height: 0.5, unit: 'in' })
    expect(computeOutputSize(100, 50, 'px', 300)).toEqual({ width: 100, height: 50, unit: 'px' })
  })

  it('builds safe file names', () => {
    expect(svgFileName('My Logo.final.png')).toBe('My Logo.final-vectortrace.svg')
    expect(svgFileName('../../x?.jpg')).toBe('.._.._x_-vectortrace.svg')
  })
})
