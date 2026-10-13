import { describe, expect, it } from 'vitest'
import type { Point, SubPath } from '../types/vectorTrace'
import { sampleSubPath, settings, shapeRaster } from '../test/helpers'
import { pointInPolygon } from './contourDetection'
import { fitCircle } from './primitives'
import { traceRaster } from './vectorization'

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
const nodesOf = (p: SubPath): Point[] => [p.start, ...p.segments.map((s) => s.to)]

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** Gear outline with trapezoid teeth: 4 vertices per tooth. */
function gear(cx: number, cy: number, teeth: number, rootR: number, tipR: number, baseHalf: number, tipHalf: number, phase = 0.13): Point[] {
  const pts: Point[] = []
  const deg = Math.PI / 180
  for (let k = 0; k < teeth; k++) {
    const c = phase + (k / teeth) * Math.PI * 2
    for (const [r, a] of [
      [rootR, c - baseHalf * deg],
      [tipR, c - tipHalf * deg],
      [tipR, c + tipHalf * deg],
      [rootR, c + baseHalf * deg],
    ]) {
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
  }
  return pts
}

/** Nodes where the outgoing direction turns by more than 20° (cusps / corners). */
function sharpNodes(p: SubPath): number {
  const nodes = nodesOf(p)
  let count = 0
  p.segments.forEach((s, k) => {
    const next = p.segments[k + 1] ?? (p.closed ? p.segments[0] : null)
    if (!next) return
    const inDir = s.type === 'C' ? { x: s.to.x - s.c2.x, y: s.to.y - s.c2.y } : { x: s.to.x - nodes[k].x, y: s.to.y - nodes[k].y }
    const outDir = next.type === 'C' ? { x: next.c1.x - s.to.x, y: next.c1.y - s.to.y } : { x: next.to.x - s.to.x, y: next.to.y - s.to.y }
    const cos = (inDir.x * outDir.x + inDir.y * outDir.y) / (Math.hypot(inDir.x, inDir.y) * Math.hypot(outDir.x, outDir.y) || 1)
    if (cos < Math.cos((20 * Math.PI) / 180)) count++
  })
  return count
}

/** Mask of a round-capped stroke along a parametric curve. */
function strokeMask(w: number, h: number, curve: (t: number) => Point, halfWidth: number, steps = 3000): (x: number, y: number) => boolean {
  const mask = new Uint8Array(w * h)
  const r = Math.ceil(halfWidth) + 1
  for (let i = 0; i <= steps; i++) {
    const c = curve(i / steps)
    for (let y = Math.floor(c.y - r); y <= c.y + r; y++) {
      for (let x = Math.floor(c.x - r); x <= c.x + r; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h && Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y) < halfWidth) mask[y * w + x] = 1
      }
    }
  }
  return (x, y) => mask[Math.floor(y) * w + Math.floor(x)] === 1
}

function trace(w: number, h: number, inside: (x: number, y: number) => boolean, mode: 'outline' | 'centerline' = 'outline', extra = {}) {
  return traceRaster({ raster: shapeRaster(w, h, inside), sourceWidth: w, sourceHeight: h, settings: settings({ mode, ...extra }) })
}

describe('fitCircle', () => {
  it('recovers centre and radius from noisy samples of a partial arc', () => {
    const pts: Point[] = []
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6
    for (let i = 0; i <= 40; i++) {
      const a = 0.3 + (i / 40) * 2.2
      pts.push({ x: 50 + 30 * Math.cos(a) + rnd(), y: 40 + 30 * Math.sin(a) + rnd() })
    }
    const c = fitCircle(pts)
    expect(c).not.toBeNull()
    expect(Math.abs(c!.cx - 50)).toBeLessThan(0.5)
    expect(Math.abs(c!.cy - 40)).toBeLessThan(0.5)
    expect(Math.abs(c!.r - 30)).toBeLessThan(0.3)
  })

  it('returns null for collinear points', () => {
    expect(fitCircle([0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x })))).toBeNull()
  })
})

describe('straight edges and corners', () => {
  for (const [label, g] of [
    ['large', gear(150, 150, 16, 80, 95, 7, 4)],
    ['small', gear(110, 110, 24, 60, 70, 5, 2.5)],
  ] as const) {
    it(`traces ${label} trapezoid gear teeth with a sharp node at every vertex (outline)`, () => {
      const size = label === 'large' ? 300 : 220
      const result = trace(size, size, (x, y) => pointInPolygon({ x, y }, g))
      const path = result.shapes[0].subpaths[0]
      const nodes = nodesOf(path)
      const misses = g.map((v) => Math.min(...nodes.map((n) => dist(n, v))))
      // The small gear has 6 px tooth tops: sub-pixel vertices are not recoverable at that size.
      expect(Math.max(...misses)).toBeLessThan(label === 'large' ? 1 : 1.5)
      for (const p of sampleSubPath(path)) {
        const d = Math.min(...g.map((v, i) => segDist(p, v, g[(i + 1) % g.length])))
        expect(d).toBeLessThan(label === 'large' ? 0.8 : 1)
      }
      const lines = path.segments.filter((s) => s.type === 'L').length
      expect(lines).toBeGreaterThanOrEqual(g.length * 0.9)
      expect(path.segments.length).toBeLessThanOrEqual(g.length + 4)
    })
  }

  it('traces gear teeth drawn as a stroke as trapezoids in centerline mode', () => {
    const g = gear(150, 150, 16, 80, 100, 7, 4)
    const onEdge = (x: number, y: number) => {
      for (let i = 0; i < g.length; i++) if (segDist({ x, y }, g[i], g[(i + 1) % g.length]) < 2.5) return true
      return false
    }
    const result = trace(300, 300, onEdge, 'centerline')
    const closed = result.shapes.filter((s) => s.subpaths[0].closed)
    expect(closed).toHaveLength(1)
    const path = closed[0].subpaths[0]
    const nodes = nodesOf(path)
    const misses = g.map((v) => Math.min(...nodes.map((n) => dist(n, v))))
    // The thinned skeleton itself only passes within ~1.9 px of these vertices.
    expect(Math.max(...misses)).toBeLessThan(2)
    for (const p of sampleSubPath(path)) {
      const d = Math.min(...g.map((v, i) => segDist(p, v, g[(i + 1) % g.length])))
      expect(d).toBeLessThan(1.5)
    }
    expect(path.segments.filter((s) => s.type === 'L').length).toBeGreaterThanOrEqual(g.length * 0.9)
  })

  it('falls back to the plain curve fit when straight edges and arcs are disabled', () => {
    const g = gear(150, 150, 16, 80, 95, 7, 4)
    const result = trace(300, 300, (x, y) => pointInPolygon({ x, y }, g), 'outline', { straightEdges: false, fitArcs: false })
    expect(result.stats.primitives.lines).toBe(0)
  })
})

describe('circles and arcs', () => {
  it('emits a gear bore as an exact circle (4 cubics)', () => {
    const g = gear(150, 150, 16, 80, 95, 7, 4)
    const result = trace(300, 300, (x, y) => pointInPolygon({ x, y }, g) && Math.hypot(x - 150, y - 150) > 30)
    const shape = result.shapes[0]
    expect(shape.subpaths).toHaveLength(2)
    const bore = shape.subpaths[1]
    expect(bore.segments).toHaveLength(4)
    expect(bore.segments.every((s) => s.type === 'C')).toBe(true)
    for (const p of sampleSubPath(bore)) expect(Math.abs(Math.hypot(p.x - 150, p.y - 150) - 30)).toBeLessThan(0.5)
    expect(result.stats.primitives.circles).toBe(1)
  })

  it('fits rounded-rectangle fillets as arcs that join the edges tangentially', () => {
    const r = 18
    const inside = (x: number, y: number) => {
      if (x < 40 || x > 220 || y < 40 || y > 160) return false
      const qx = Math.min(Math.max(x, 40 + r), 220 - r)
      const qy = Math.min(Math.max(y, 40 + r), 160 - r)
      return Math.hypot(x - qx, y - qy) <= r
    }
    const result = trace(260, 200, inside)
    const path = result.shapes[0].subpaths[0]
    expect(result.stats.primitives.arcs).toBe(4)
    expect(path.segments.filter((s) => s.type === 'L')).toHaveLength(4)
    expect(path.segments).toHaveLength(8)
    // Tangent continuity at every line → arc join.
    let prev = path.start
    path.segments.forEach((s, k) => {
      const next = path.segments[(k + 1) % path.segments.length]
      if (s.type === 'L' && next.type === 'C') {
        const dir = { x: s.to.x - prev.x, y: s.to.y - prev.y }
        const handle = { x: next.c1.x - s.to.x, y: next.c1.y - s.to.y }
        const sin = Math.abs(dir.x * handle.y - dir.y * handle.x) / (Math.hypot(dir.x, dir.y) * Math.hypot(handle.x, handle.y))
        expect(sin).toBeLessThan(0.05)
      }
      prev = s.to
    })
    for (const p of sampleSubPath(path)) {
      const qx = Math.min(Math.max(p.x, 40 + r), 220 - r)
      const qy = Math.min(Math.max(p.y, 40 + r), 160 - r)
      const d = qx === p.x || qy === p.y ? Math.min(Math.abs(p.x - 40), Math.abs(p.x - 220), Math.abs(p.y - 40), Math.abs(p.y - 160)) : Math.abs(Math.hypot(p.x - qx, p.y - qy) - r)
      expect(d).toBeLessThan(0.8)
    }
  })

  it('keeps small circles round instead of polygonising them', () => {
    const result = trace(60, 60, (x, y) => Math.hypot(x - 30, y - 30) < 6)
    const path = result.shapes[0].subpaths[0]
    expect(path.segments.every((s) => s.type === 'C')).toBe(true)
    for (const p of sampleSubPath(path)) expect(Math.abs(Math.hypot(p.x - 30, p.y - 30) - 6)).toBeLessThan(0.6)
  })

  it('does not add corners to smooth hand-drawn strokes', () => {
    const curve = (t: number): Point => {
      const a = t * Math.PI * 2
      return { x: 150 + 110 * Math.sin(a), y: 100 + 60 * Math.sin(2 * a + 0.4) }
    }
    const stroke = strokeMask(300, 200, curve, 2.5)
    for (const mode of ['centerline', 'outline'] as const) {
      const sharp = (on: boolean) =>
        trace(300, 200, stroke, mode, { straightEdges: on, fitArcs: on })
          .shapes.flatMap((s) => s.subpaths)
          .reduce((n, p) => n + sharpNodes(p), 0)
      expect(sharp(true), mode).toBeLessThanOrEqual(sharp(false))
    }
    // A thin wavy band keeps only its four end corners.
    const wave = trace(300, 120, (x, y) => x > 20 && x < 280 && Math.abs(y - (60 + 15 * Math.sin(x / 12))) < 4)
    expect(wave.shapes.flatMap((s) => s.subpaths).reduce((n, p) => n + sharpNodes(p), 0)).toBeLessThanOrEqual(4)
  })

  it('emits an ellipse as an exact ellipse in both modes', () => {
    const ell = (x: number, y: number) => Math.hypot((x - 120) / 90, (y - 100) / 55)
    for (const mode of ['outline', 'centerline'] as const) {
      const result = trace(240, 200, (x, y) => (mode === 'outline' ? ell(x, y) <= 1 : Math.abs(ell(x, y) - 1) * 70 < 4), mode)
      expect(result.stats.primitives.ellipses, mode).toBe(1)
      const path = result.shapes[0].subpaths[0]
      expect(path.segments.map((s) => s.type).join('')).toBe('CCCC')
      for (const p of sampleSubPath(path)) expect(Math.abs(ell(p.x, p.y) - 1) * 55).toBeLessThan(0.8)
    }
  })

  it('does not turn an ellipse into corners', () => {
    const result = trace(240, 160, (x, y) => ((x - 120) / 90) ** 2 + ((y - 80) / 45) ** 2 < 1)
    const path = result.shapes[0].subpaths[0]
    expect(result.stats.primitives.lines).toBe(0)
    // Every node is smooth: the incoming and outgoing directions agree.
    const nodes = nodesOf(path)
    path.segments.forEach((s, k) => {
      const next = path.segments[(k + 1) % path.segments.length]
      const from = nodes[k]
      const inDir = s.type === 'C' ? { x: s.to.x - s.c2.x, y: s.to.y - s.c2.y } : { x: s.to.x - from.x, y: s.to.y - from.y }
      const outDir = next.type === 'C' ? { x: next.c1.x - s.to.x, y: next.c1.y - s.to.y } : { x: next.to.x - s.to.x, y: next.to.y - s.to.y }
      const cos = (inDir.x * outDir.x + inDir.y * outDir.y) / (Math.hypot(inDir.x, inDir.y) * Math.hypot(outDir.x, outDir.y))
      expect(cos).toBeGreaterThan(Math.cos((20 * Math.PI) / 180))
    })
    for (const p of sampleSubPath(path)) {
      const e = Math.hypot((p.x - 120) / 90, (p.y - 80) / 45)
      expect(Math.abs(e - 1) * 45).toBeLessThan(1.2)
    }
  })
})

describe('shape regularisation', () => {
  const poly = (n: number, cx: number, cy: number, r: number, rot = 0): Point[] =>
    Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos(rot + (k / n) * 2 * Math.PI), y: cy + r * Math.sin(rot + (k / n) * 2 * Math.PI) }))
  const unitTo = (a: Point, b: Point): Point => {
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  }
  const onPolygon = (P: Point[], hw: number) => (x: number, y: number) => P.some((v, i) => segDist({ x, y }, v, P[(i + 1) % P.length]) < hw)

  /** Centerline of a 160×120 rounded rectangle at (40,40) with corner radius r. */
  const roundedRectDist = (r: number) => (x: number, y: number) => {
    const qx = Math.min(Math.max(x, 40 + r), 200 - r)
    const qy = Math.min(Math.max(y, 40 + r), 160 - r)
    if (qx === x || qy === y) return Math.min(Math.abs(x - 40), Math.abs(x - 200), Math.abs(y - 40), Math.abs(y - 160))
    return Math.abs(Math.hypot(x - qx, y - qy) - r)
  }

  it('traces a rounded-rectangle stroke as four exact axis-aligned edges and four equal fillets', () => {
    const d = roundedRectDist(16)
    const result = trace(240, 200, (x, y) => x > 30 && x < 210 && y > 30 && y < 170 && d(x, y) < 4.5, 'centerline')
    const path = result.shapes[0].subpaths[0]
    expect(path.closed).toBe(true)
    expect(result.stats.primitives.arcs).toBe(4)
    const nodes = nodesOf(path)
    const lines = path.segments.flatMap((s, k) => (s.type === 'L' ? [{ from: nodes[k], to: s.to }] : []))
    expect(lines).toHaveLength(4)
    for (const l of lines) expect(Math.min(Math.abs(l.to.x - l.from.x), Math.abs(l.to.y - l.from.y))).toBeLessThan(1e-9)
    // Each 90° fillet spans |dx| = |dy| = r; all four share one radius.
    const radii = path.segments.flatMap((s, k) => (s.type === 'C' ? [Math.abs(s.to.x - nodes[k].x)] : []))
    expect(radii).toHaveLength(4)
    for (const r of radii) expect(Math.abs(r - radii[0])).toBeLessThan(1e-6)
    expect(Math.abs(radii[0] - 16)).toBeLessThan(2)
    for (const p of sampleSubPath(path)) expect(d(p.x, p.y)).toBeLessThan(1)
  })

  it('runs edges straight through junctions and lands branch strokes on them', () => {
    const d = roundedRectDist(16)
    const leg = (x: number, y: number) => Math.abs(x - 100) < 4.5 && y > 155 && y < 196
    const arm = (x: number, y: number) => segDist({ x, y }, { x: 40, y: 100 }, { x: 4, y: 130 }) < 4.5
    const result = trace(240, 200, (x, y) => (x > 30 && x < 210 && y > 30 && y < 170 && d(x, y) < 4.5) || leg(x, y) || arm(x, y), 'centerline')
    const paths = result.shapes.flatMap((s) => s.subpaths)
    const loop = paths.find((p) => p.closed)!
    expect(loop.segments.map((s) => s.type).join('').replace(/CC/g, 'C')).toMatch(/^(CL){4}$|^(LC){4}$/)
    const open = paths.filter((p) => !p.closed)
    expect(open).toHaveLength(2)
    const loopNodes = nodesOf(loop)
    const curvePts = sampleSubPath({ ...loop, segments: loop.segments.map((s) => (s.type === 'C' ? s : { type: 'L', to: s.to })) }, 400)
    const toLoop = (e: Point) =>
      Math.min(...loop.segments.map((s, k) => (s.type === 'L' ? segDist(e, loopNodes[k], s.to) : Infinity)), ...curvePts.map((q) => dist(e, q)))
    for (const p of open) {
      const ends = [p.start, p.segments[p.segments.length - 1].to]
      expect(Math.min(...ends.map(toLoop))).toBeLessThan(0.05)
    }
  })

  it('keeps a rounded acute tip rounded and a sharp one sharp', () => {
    const V = [{ x: 210, y: 40 }, { x: 228, y: 290 }, { x: 60, y: 370 }]
    // Centerline of the triangle with every corner rounded (apex r = 12).
    const rounded: Point[] = []
    V.forEach((P, i) => {
      const r = [12, 30, 25][i]
      const ua = unitTo(P, V[(i + 2) % 3])
      const ub = unitTo(P, V[(i + 1) % 3])
      const half = Math.acos(ua.x * ub.x + ua.y * ub.y) / 2
      const bis = unitTo({ x: 0, y: 0 }, { x: ua.x + ub.x, y: ua.y + ub.y })
      const C = { x: P.x + (bis.x * r) / Math.sin(half), y: P.y + (bis.y * r) / Math.sin(half) }
      const d = r / Math.tan(half)
      const a0 = Math.atan2(P.y + ua.y * d - C.y, P.x + ua.x * d - C.x)
      let sweep = Math.atan2(P.y + ub.y * d - C.y, P.x + ub.x * d - C.x) - a0
      while (sweep > Math.PI) sweep -= 2 * Math.PI
      while (sweep < -Math.PI) sweep += 2 * Math.PI
      for (let k = 0; k <= 40; k++) rounded.push({ x: C.x + r * Math.cos(a0 + (sweep * k) / 40), y: C.y + r * Math.sin(a0 + (sweep * k) / 40) })
    })
    const roundTrace = trace(300, 420, onPolygon(rounded, 4.5), 'centerline')
    const roundPath = roundTrace.shapes[0].subpaths[0]
    expect(roundTrace.stats.primitives.arcs).toBe(3)
    for (const p of sampleSubPath(roundPath, 16)) expect(Math.min(...rounded.map((v, i) => segDist(p, v, rounded[(i + 1) % rounded.length])))).toBeLessThan(0.8)

    const sharpTrace = trace(300, 420, onPolygon(V, 4.5), 'centerline')
    expect(sharpTrace.shapes[0].subpaths[0].segments.map((s) => s.type).join('')).toBe('LLL')
  })

  it('keeps polygons sharp with exactly one edge per side', () => {
    const shapes: [string, Point[]][] = [
      ['triangle', poly(3, 120, 105, 80, -Math.PI / 2)],
      ['hexagon', poly(6, 120, 100, 75)],
      ['rotated square', poly(4, 120, 100, 80, 0.3)],
    ]
    for (const [name, P] of shapes) {
      for (const mode of ['outline', 'centerline'] as const) {
        const result = trace(240, 200, mode === 'outline' ? (x, y) => pointInPolygon({ x, y }, P) : onPolygon(P, 4), mode)
        const path = result.shapes[0].subpaths[0]
        expect(path.segments.map((s) => s.type).join(''), `${name} ${mode}`).toBe('L'.repeat(P.length))
        const misses = P.map((v) => Math.min(...nodesOf(path).map((n) => dist(n, v))))
        expect(Math.max(...misses), `${name} ${mode}`).toBeLessThan(mode === 'outline' ? 1.2 : 2.5)
      }
    }
  })
})

describe('fewest nodes', () => {
  it('redraws a wobbly freehand loop with a handful of nodes that stay on the ink', () => {
    // A rounded triangle drawn by hand: the pen wobbles a little all the way round.
    const loop = (wobble: number): Point[] =>
      Array.from({ length: 720 }, (_, k) => {
        const t = (k / 720) * 2 * Math.PI
        const r = 70 + 14 * Math.cos(3 * t) + wobble * Math.sin(29 * t)
        return { x: 120 + r * Math.cos(t), y: 120 + r * Math.sin(t) }
      })
    const curve = loop(1.5)
    const intended = loop(0)
    const half = 5
    const ink = (x: number, y: number) => {
      for (let i = 0; i < curve.length; i++) if (segDist({ x, y }, curve[i], curve[(i + 1) % curve.length]) < half) return true
      return false
    }
    const result = trace(240, 240, ink, 'centerline')
    const path = result.shapes[0].subpaths[0]
    expect(path.closed).toBe(true)
    expect(path.segments.length).toBeLessThanOrEqual(8)
    const far = (p: Point, c: Point[]) => Math.min(...c.map((q, i) => segDist(p, q, c[(i + 1) % c.length])))
    let onInk = 0
    let offIntent = 0
    for (const p of sampleSubPath(path, 16)) {
      onInk = Math.max(onInk, far(p, curve))
      offIntent = Math.max(offIntent, far(p, intended))
    }
    expect(onInk).toBeLessThan(0.85 * half)
    expect(offIntent).toBeLessThan(0.7 * half)
  })
})
