import { describe, expect, it } from 'vitest'
import { sampleSubPath, settings, shapeRaster } from '../test/helpers'
import type { Point, TraceSettings } from '../types/vectorTrace'
import { type CenterlineOptions, extractCenterlines } from './centerline'
import { distanceTransform } from './distanceTransform'
import { preprocess } from './imagePreprocessing'
import { zhangSuenThin } from './skeleton'
import { traceRaster } from './vectorization'

const OPTS: CenterlineOptions = { spurLength: 4, minLength: 4, lineEnds: 'cap', joinStrokes: true, joinAngle: 40, gapClosing: 0 }

function bitmapOf(w: number, h: number, inside: (x: number, y: number) => boolean) {
  return preprocess(shapeRaster(w, h, inside), settings({ mode: 'centerline', smoothing: 0 })).bitmap
}

const segDist = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

/** Thick line segment from a to b with the given width. */
const thickSegment = (a: Point, b: Point, width: number) => (x: number, y: number) => segDist({ x, y }, a, b) <= width / 2

function trace(w: number, h: number, inside: (x: number, y: number) => boolean, over: Partial<TraceSettings> = {}) {
  return traceRaster({ raster: shapeRaster(w, h, inside), sourceWidth: w, sourceHeight: h, settings: settings({ mode: 'centerline', ...over }) })
}

const ends = (pts: Point[]): [Point, Point] => [pts[0], pts[pts.length - 1]]

describe('distanceTransform', () => {
  it('measures the distance to the nearest background pixel', () => {
    const w = 9
    const data = new Uint8Array(w * w)
    for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) data[y * w + x] = 1
    const dt = distanceTransform(data, w, w)
    expect(dt[4 * w + 4]).toBeCloseTo(4, 5)
    expect(dt[1 * w + 1]).toBeCloseTo(1, 5)
    expect(dt[0]).toBe(0)
  })
})

describe('skeleton', () => {
  it('produces a strictly one-pixel-wide line (every interior pixel has two neighbours)', () => {
    const skel = zhangSuenThin(bitmapOf(120, 80, thickSegment({ x: 10, y: 10 }, { x: 110, y: 70 }, 9)))
    const { data, width, height } = skel
    let ends = 0
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (!data[y * width + x]) continue
        let n = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && data[(y + dy) * width + x + dx]) n++
        expect(n).toBeLessThanOrEqual(3)
        if (n === 1) ends++
      }
    }
    expect(ends).toBeGreaterThanOrEqual(2)
  })
})

describe('extractCenterlines', () => {
  it('returns nothing for an empty bitmap', () => {
    const r = extractCenterlines({ data: new Uint8Array(100), width: 10, height: 10 }, OPTS)
    expect(r.strokes).toHaveLength(0)
  })

  it('traces a thick line as one stroke along its centre with the measured width', () => {
    const r = extractCenterlines(bitmapOf(140, 40, thickSegment({ x: 20, y: 20 }, { x: 120, y: 20 }, 10)), OPTS)
    expect(r.strokes).toHaveLength(1)
    const s = r.strokes[0]
    expect(s.closed).toBe(false)
    for (const p of s.points) expect(Math.abs(p.y - 20)).toBeLessThan(1.5)
    expect(s.width).toBeGreaterThan(8.5)
    expect(s.width).toBeLessThan(11.5)
    expect(r.medianWidth).toBeGreaterThan(8.5)
  })

  it('restores line ends: round-cap length, full tip, or raw skeleton', () => {
    // The capsule spans x = 15..125 (centre segment 20..120 plus 5 px round caps).
    const bmp = bitmapOf(140, 40, thickSegment({ x: 20, y: 20 }, { x: 120, y: 20 }, 10))
    const xs = (mode: CenterlineOptions['lineEnds']) => {
      const [a, b] = ends(extractCenterlines(bmp, { ...OPTS, lineEnds: mode }).strokes[0].points)
      return [Math.min(a.x, b.x), Math.max(a.x, b.x)]
    }
    const cap = xs('cap')
    expect(cap[0]).toBeCloseTo(20, -0.5)
    expect(cap[1]).toBeCloseTo(120, -0.5)
    const tip = xs('tip')
    expect(Math.abs(tip[0] - 15)).toBeLessThan(1.5)
    expect(Math.abs(tip[1] - 125)).toBeLessThan(1.5)
    const raw = xs('none')
    expect(raw[1] - raw[0]).toBeLessThanOrEqual(cap[1] - cap[0] + 0.01)
  })

  it('continues strokes straight through a crossing ("+" becomes two strokes)', () => {
    const plus = (x: number, y: number) =>
      thickSegment({ x: 20, y: 80 }, { x: 140, y: 80 }, 10)(x, y) || thickSegment({ x: 80, y: 20 }, { x: 80, y: 140 }, 10)(x, y)
    const joined = extractCenterlines(bitmapOf(160, 160, plus), OPTS)
    expect(joined.strokes).toHaveLength(2)
    for (const s of joined.strokes) {
      const [a, b] = ends(s.points)
      const horizontal = Math.abs(a.y - b.y) < Math.abs(a.x - b.x)
      for (const p of s.points) expect(Math.abs((horizontal ? p.y : p.x) - 80)).toBeLessThan(2)
      expect(dist(a, b)).toBeGreaterThan(100)
    }
  })

  it('splits at junctions when joining is off, with all branches meeting at one point', () => {
    const plus = (x: number, y: number) =>
      thickSegment({ x: 20, y: 80 }, { x: 140, y: 80 }, 10)(x, y) || thickSegment({ x: 80, y: 20 }, { x: 80, y: 140 }, 10)(x, y)
    const split = extractCenterlines(bitmapOf(160, 160, plus), { ...OPTS, joinStrokes: false })
    expect(split.strokes).toHaveLength(4)
    const centerEnds = split.strokes.map((s) => {
      const [a, b] = ends(s.points)
      return dist(a, { x: 80, y: 80 }) < dist(b, { x: 80, y: 80 }) ? a : b
    })
    for (const p of centerEnds) {
      expect(dist(p, centerEnds[0])).toBeLessThan(1e-6)
      expect(dist(p, { x: 80, y: 80 })).toBeLessThan(2.5)
    }
  })

  it('traces a T as a through-stroke plus one branch ending at the junction', () => {
    const tee = (x: number, y: number) =>
      thickSegment({ x: 20, y: 30 }, { x: 140, y: 30 }, 10)(x, y) || thickSegment({ x: 80, y: 30 }, { x: 80, y: 140 }, 10)(x, y)
    const r = extractCenterlines(bitmapOf(160, 160, tee), OPTS)
    expect(r.strokes).toHaveLength(2)
    expect(r.junctionCount).toBe(1)
  })

  it('traces a ring as one closed loop', () => {
    const ring = (x: number, y: number) => {
      const d = Math.hypot(x - 60, y - 60)
      return d > 30 && d < 40
    }
    const r = extractCenterlines(bitmapOf(120, 120, ring), OPTS)
    expect(r.strokes).toHaveLength(1)
    expect(r.strokes[0].closed).toBe(true)
    for (const p of r.strokes[0].points) expect(Math.abs(Math.hypot(p.x - 60, p.y - 60) - 35)).toBeLessThan(1.5)
  })

  it('prunes spurs caused by bumps on a stroke edge', () => {
    const bumpy = (x: number, y: number) => {
      if (thickSegment({ x: 20, y: 40 }, { x: 180, y: 40 }, 14)(x, y)) return true
      // Small bumps on both edges.
      for (const bx of [50, 90, 130]) if (Math.hypot(x - bx, y - 33) < 4 || Math.hypot(x - bx - 15, y - 47) < 4) return true
      return false
    }
    const r = extractCenterlines(bitmapOf(200, 80, bumpy), OPTS)
    expect(r.strokes).toHaveLength(1)
  })

  it('bridges small gaps between aligned line ends only when gap closing is enabled', () => {
    const dashed = (x: number, y: number) =>
      thickSegment({ x: 15, y: 30 }, { x: 70, y: 30 }, 6)(x, y) || thickSegment({ x: 84, y: 30 }, { x: 140, y: 30 }, 6)(x, y)
    const bmp = bitmapOf(160, 60, dashed)
    expect(extractCenterlines(bmp, OPTS).strokes).toHaveLength(2)
    expect(extractCenterlines(bmp, { ...OPTS, gapClosing: 25 }).strokes).toHaveLength(1)
  })

  it('measures different widths per stroke', () => {
    const two = (x: number, y: number) =>
      thickSegment({ x: 20, y: 30 }, { x: 180, y: 30 }, 6)(x, y) || thickSegment({ x: 20, y: 90 }, { x: 180, y: 90 }, 16)(x, y)
    const r = extractCenterlines(bitmapOf(200, 120, two), OPTS)
    const widths = r.strokes.map((s) => s.width).sort((a, b) => a - b)
    expect(widths).toHaveLength(2)
    expect(widths[0]).toBeGreaterThan(4.5)
    expect(widths[0]).toBeLessThan(7.5)
    expect(widths[1]).toBeGreaterThan(14)
    expect(widths[1]).toBeLessThan(18)
  })

  it('drops isolated specks shorter than the minimum length', () => {
    const r = extractCenterlines(bitmapOf(60, 60, (x, y) => Math.hypot(x - 30, y - 30) < 1.5), { ...OPTS, minLength: 6 })
    expect(r.strokes).toHaveLength(0)
  })
})

describe('centerline tracing (end to end)', () => {
  it('keeps a sharp corner on an "L" and outputs the measured width', () => {
    const ell = (x: number, y: number) =>
      thickSegment({ x: 30, y: 20 }, { x: 30, y: 120 }, 10)(x, y) || thickSegment({ x: 30, y: 120 }, { x: 130, y: 120 }, 10)(x, y)
    const result = trace(160, 150, ell)
    expect(result.shapes).toHaveLength(1)
    const shape = result.shapes[0]
    expect(shape.kind).toBe('stroke')
    expect(shape.strokeWidth).toBeGreaterThan(8.5)
    const path = shape.subpaths[0]
    const nodes = [path.start, ...path.segments.map((s) => s.to)]
    expect(Math.min(...nodes.map((n) => dist(n, { x: 30, y: 120 })))).toBeLessThan(2.5)
    for (const p of sampleSubPath(path)) {
      const d = Math.min(segDist(p, { x: 30, y: 15 }, { x: 30, y: 120 }), segDist(p, { x: 30, y: 120 }, { x: 135, y: 120 }))
      expect(d).toBeLessThan(1.5)
    }
  })

  it('fits a smooth wave with few nodes', () => {
    const wave = (x: number, y: number) => {
      if (x < 20 || x > 280) return false
      return Math.abs(y - (75 + 40 * Math.sin((x - 20) / 40))) < 5
    }
    const result = trace(300, 150, wave)
    expect(result.shapes).toHaveLength(1)
    const path = result.shapes[0].subpaths[0]
    expect(result.stats.nodeCount).toBeLessThan(20)
    expect(path.segments.some((s) => s.type === 'C')).toBe(true)
  })

  it('maps centerlines and widths back to source size when processing is downscaled', () => {
    const raster = shapeRaster(100, 40, thickSegment({ x: 10, y: 20 }, { x: 90, y: 20 }, 8))
    const result = traceRaster({ raster, sourceWidth: 400, sourceHeight: 160, settings: settings({ mode: 'centerline' }) })
    expect(result.shapes).toHaveLength(1)
    expect(result.shapes[0].strokeWidth).toBeGreaterThan(26)
    expect(result.shapes[0].strokeWidth).toBeLessThan(38)
    for (const p of sampleSubPath(result.shapes[0].subpaths[0])) expect(Math.abs(p.y - 80)).toBeLessThan(5)
  })

  it('handles a large drawing in reasonable time', () => {
    const lines = (x: number, y: number) => {
      for (let k = 0; k < 20; k++) {
        if (Math.abs(y - (40 + k * 55) - 20 * Math.sin(x / 60 + k)) < 4) return true
        if (Math.abs(x - (40 + k * 55)) < 3) return true
      }
      return false
    }
    const t0 = Date.now()
    const result = trace(1200, 1200, lines)
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(result.shapes.length).toBeGreaterThan(20)
  })
})

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
