import { describe, expect, it } from 'vitest'
import { WHITE, bitmapFrom, makeRaster, sampleSubPath, settings, shapeRaster } from '../test/helpers'
import { groupContours, pointInPolygon, signedArea, traceContours } from './contourDetection'
import { traceRaster } from './vectorization'

describe('traceContours', () => {
  it('traces a filled square as one clockwise contour with four corners', () => {
    const bmp = bitmapFrom(['.....', '.###.', '.###.', '.###.', '.....'])
    const contours = traceContours(bmp)
    expect(contours).toHaveLength(1)
    expect(contours[0].points).toHaveLength(4)
    expect(contours[0].area).toBe(9)
    expect(contours[0].isHole).toBe(false)
  })

  it('detects holes and groups them with their outer contour', () => {
    const bmp = bitmapFrom(['.....', '.###.', '.#.#.', '.###.', '.....'])
    const contours = traceContours(bmp)
    expect(contours).toHaveLength(2)
    const hole = contours.find((c) => c.isHole)
    expect(hole && signedArea(hole.points)).toBe(-1)
    const groups = groupContours(contours)
    expect(groups).toHaveLength(1)
    expect(groups[0].holes).toHaveLength(1)
  })

  it('keeps disconnected objects separate and nested islands as their own objects', () => {
    const bmp = bitmapFrom([
      '.........##',
      '.#######.##',
      '.#.....#...',
      '.#.###.#...',
      '.#.###.#...',
      '.#.....#...',
      '.#######...',
      '...........',
    ])
    const groups = groupContours(traceContours(bmp))
    expect(groups).toHaveLength(3)
    const frame = groups.find((g) => g.holes.length === 1)
    expect(frame).toBeDefined()
    expect(groups.filter((g) => g.holes.length === 0)).toHaveLength(2)
  })

  it('joins diagonally touching pixels (8-connectivity)', () => {
    const bmp = bitmapFrom(['....', '.#..', '..#.', '....'])
    expect(traceContours(bmp).filter((c) => !c.isHole)).toHaveLength(1)
  })

  it('returns nothing for an empty bitmap', () => {
    expect(traceContours(bitmapFrom(['....', '....']))).toHaveLength(0)
  })
})

describe('traceRaster', () => {
  it('fits a circle with Bézier curves and few nodes, staying close to the true radius', () => {
    const raster = shapeRaster(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 40)
    const result = traceRaster({ raster, sourceWidth: 120, sourceHeight: 120, settings: settings({ detail: 80 }) })
    expect(result.shapes).toHaveLength(1)
    const path = result.shapes[0].subpaths[0]
    expect(path.closed).toBe(true)
    expect(result.stats.curveCount).toBeGreaterThan(0)
    expect(result.stats.nodeCount).toBeLessThan(40)
    for (const p of sampleSubPath(path)) {
      expect(Math.abs(Math.hypot(p.x - 60, p.y - 60) - 40)).toBeLessThan(1.2)
    }
  })

  it('keeps sharp corners on a rectangle', () => {
    const raster = shapeRaster(100, 80, (x, y) => x > 20 && x < 80 && y > 20 && y < 60)
    const result = traceRaster({ raster, sourceWidth: 100, sourceHeight: 80, settings: settings() })
    const path = result.shapes[0].subpaths[0]
    const nodes = [path.start, ...path.segments.map((s) => s.to)]
    for (const corner of [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
      { x: 80, y: 60 },
      { x: 20, y: 60 },
    ]) {
      expect(nodes.some((n) => Math.hypot(n.x - corner.x, n.y - corner.y) < 0.75)).toBe(true)
    }
    expect(result.stats.nodeCount).toBeLessThanOrEqual(8)
  })

  it('keeps the concave and convex vertices of a rotated star as sharp nodes', () => {
    const star: { x: number; y: number }[] = []
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 50 : 125
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2
      star.push({ x: 150 + r * Math.cos(a), y: 150 + r * Math.sin(a) })
    }
    const raster = shapeRaster(300, 300, (x, y) => pointInPolygon({ x, y }, star))
    const result = traceRaster({ raster, sourceWidth: 300, sourceHeight: 300, settings: settings() })
    const path = result.shapes[0].subpaths[0]
    const nodes = [path.start, ...path.segments.map((s) => s.to)]
    star.forEach((v, i) => {
      const nearest = Math.min(...nodes.map((n) => Math.hypot(n.x - v.x, n.y - v.y)))
      // Inner (concave) vertices are exact; 36° tips lose a little to pixel aliasing.
      expect(nearest).toBeLessThan(i % 2 ? 0.75 : 2)
    })
  })

  it('preserves holes as extra subpaths in the same shape', () => {
    const raster = shapeRaster(100, 100, (x, y) => {
      const d = Math.hypot(x - 50, y - 50)
      return d < 40 && d > 20
    })
    const result = traceRaster({ raster, sourceWidth: 100, sourceHeight: 100, settings: settings() })
    expect(result.shapes).toHaveLength(1)
    expect(result.shapes[0].subpaths).toHaveLength(2)
  })

  it('maps geometry back to source dimensions when processing at a lower resolution', () => {
    // 100x50 processing raster for a 400x200 source: aspect ratio 2:1 must be preserved.
    const raster = shapeRaster(100, 50, (x, y) => x > 10 && x < 90 && y > 10 && y < 40)
    const result = traceRaster({ raster, sourceWidth: 400, sourceHeight: 200, settings: settings() })
    expect(result.width).toBe(400)
    expect(result.height).toBe(200)
    expect(result.processingWidth).toBe(100)
    const pts = sampleSubPath(result.shapes[0].subpaths[0])
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    expect(Math.min(...xs)).toBeCloseTo(40, 0)
    expect(Math.max(...xs)).toBeCloseTo(360, 0)
    expect(Math.min(...ys)).toBeCloseTo(40, 0)
    expect(Math.max(...ys)).toBeCloseTo(160, 0)
  })

  it('returns no shapes and a warning for an empty image', () => {
    const raster = makeRaster(50, 50, () => WHITE)
    const result = traceRaster({ raster, sourceWidth: 50, sourceHeight: 50, settings: settings() })
    expect(result.shapes).toHaveLength(0)
    expect(result.stats.nodeCount).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('rejects invalid source dimensions', () => {
    const raster = makeRaster(4, 4, () => WHITE)
    expect(() => traceRaster({ raster, sourceWidth: 0, sourceHeight: 4, settings: settings() })).toThrow()
    expect(() => traceRaster({ raster, sourceWidth: Number.NaN, sourceHeight: 4, settings: settings() })).toThrow()
  })

  it('centerline mode produces a single open stroke along the middle of a thick line', () => {
    const raster = shapeRaster(120, 40, (x, y) => x > 10 && x < 110 && y > 15 && y < 25)
    const result = traceRaster({
      raster,
      sourceWidth: 120,
      sourceHeight: 40,
      settings: settings({ mode: 'centerline' }),
    })
    expect(result.shapes.length).toBe(1)
    const shape = result.shapes[0]
    expect(shape.kind).toBe('stroke')
    const path = shape.subpaths[0]
    expect(path.closed).toBe(false)
    for (const p of sampleSubPath(path)) expect(Math.abs(p.y - 20)).toBeLessThan(1.5)
    const xs = sampleSubPath(path).map((p) => p.x)
    // The skeleton of a flat-ended 10px stroke ends roughly one stroke width short of each end.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(70)
    expect(result.estimatedStrokeWidth).toBeGreaterThan(7)
    expect(result.estimatedStrokeWidth).toBeLessThan(13)
  })

  it('centerline mode traces a ring as a closed loop', () => {
    const raster = shapeRaster(100, 100, (x, y) => {
      const d = Math.hypot(x - 50, y - 50)
      return d < 34 && d > 26
    })
    const result = traceRaster({ raster, sourceWidth: 100, sourceHeight: 100, settings: settings({ mode: 'centerline' }) })
    const closed = result.shapes.filter((s) => s.subpaths[0].closed)
    expect(closed.length).toBe(1)
    for (const p of sampleSubPath(closed[0].subpaths[0])) {
      expect(Math.abs(Math.hypot(p.x - 50, p.y - 50) - 30)).toBeLessThan(2)
    }
  })
})
