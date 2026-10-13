import type { PathSegment, Point, SubPath } from '../types/vectorTrace'
import { type Polyline, detectCorners, fitBezierPath, taubinSmooth } from './curveFitting'
import { ellipseDistance, ellipsePath, fitEllipse } from './ellipse'

/**
 * Geometric primitive segmentation: every stretch of a polyline is classified as a straight
 * line, a circular arc or a free-form curve, the way CAD vectorisers do it.
 *
 * - Straight runs are fitted with total least squares; where two runs meet, the corner is put at
 *   the intersection of the fitted lines, so obtuse corners (gear teeth, polygons) stay sharp even
 *   after pixel chamfering or skeleton thinning has rounded them.
 * - Arcs are fitted with an algebraic circle fit refined by Gauss–Newton and emitted as ≤90° cubics.
 * - Everything else falls back to the regular smoothed Bézier fit.
 */

export interface Circle {
  cx: number
  cy: number
  r: number
}

interface LineFit {
  cx: number
  cy: number
  dx: number
  dy: number
}

export interface PrimitiveOptions {
  lines: boolean
  arcs: boolean
  /** Max deviation (px) of points from a fitted line/arc. */
  tolerance: number
  /** Minimum length (px) of a line primitive; arcs need 1.5×. */
  minLength: number
  /** Max length (px) of unexplained points between two primitives that still meet directly. */
  maxGap: number
  minRadius: number
  /** Length (px) ignored at each end of a line fit, where neighbouring corners bend the data. */
  endTrim: number
  /** Half the stroke width for centerlines; 0 for contours. */
  strokeRadius: number
  /** Ink depth lookup (centerlines): distance from a point to the nearest background pixel. */
  radiusAt?: (p: Point) => number
  /** Free-curve fitting. */
  smoothing: number
  /** Taubin passes applied to free stretches before corner detection. */
  presmooth: number
  cornerAngle: number
  curveTolerance: number
  /** Pinned polyline points are hard corners (outlines) or smooth pass-through points (centerline junctions). */
  pinnedAreCorners: boolean
}

export interface PrimitiveCounts {
  lines: number
  arcs: number
  circles: number
  ellipses: number
  /** Stretches that matched no primitive and were emitted as free Béziers. */
  free?: number
  /** Corners between two recognised pieces. */
  corners?: Point[]
}

const MIN_ARC_SWEEP = (20 * Math.PI) / 180
const SMOOTH_TURN = (15 * Math.PI) / 180
const FREE_SMOOTH_TURN = (40 * Math.PI) / 180
const LINE_CORNER_TURN = (3 * Math.PI) / 180
const POLYGON_TURN = (35 * Math.PI) / 180
const LINE_ANCHOR_TURN = (40 * Math.PI) / 180
const BENT_LINE_TURN = (10 * Math.PI) / 180
const SHORT_LINE_CORNER = (50 * Math.PI) / 180
const AXIS_SNAP = (2 * Math.PI) / 180
/** Flatter loops are slots or bars, better described by lines and arcs. */
const MAX_ELLIPSE_RATIO = 6
/** Fillets of one shape whose radii agree within this ratio are given one common radius. */
const FILLET_RADIUS_RATIO = 1.2
const KAPPA_QUARTER = (4 / 3) * Math.tan(Math.PI / 8)

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
function unit(a: Point): Point {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}
const turnAngle = (a: Point, b: Point): number => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))))

// ---------------------------------------------------------------------------------------------
// Fitting

export function fitLine(pts: Point[], a = 0, b = pts.length - 1): LineFit {
  const n = b - a + 1
  let mx = 0
  let my = 0
  for (let i = a; i <= b; i++) {
    mx += pts[i].x
    my += pts[i].y
  }
  mx /= n
  my /= n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = a; i <= b; i++) {
    const u = pts[i].x - mx
    const v = pts[i].y - my
    sxx += u * u
    sxy += u * v
    syy += v * v
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  let dx = Math.cos(ang)
  let dy = Math.sin(ang)
  if (dx * (pts[b].x - pts[a].x) + dy * (pts[b].y - pts[a].y) < 0) {
    dx = -dx
    dy = -dy
  }
  return { cx: mx, cy: my, dx, dy }
}

/**
 * Line fit that ignores the end samples, which pick up the rounding of adjacent corners
 * (pixel chamfers, or about one stroke radius of skeleton bending for centerlines).
 */
function fitLineTrimmed(pts: Point[], a: number, b: number, trimPx = 0): LineFit {
  const spacing = dist(pts[a], pts[b]) / Math.max(1, b - a)
  const base = b - a >= 10 ? Math.max(2, Math.round(0.12 * (b - a))) : b - a >= 6 ? 1 : 0
  const k = Math.min(Math.floor((b - a) / 3), Math.max(base, Math.ceil(trimPx / Math.max(spacing, 1e-6))))
  const l = fitLine(pts, a + k, b - k)
  if (l.dx * (pts[b].x - pts[a].x) + l.dy * (pts[b].y - pts[a].y) < 0) return { ...l, dx: -l.dx, dy: -l.dy }
  return l
}

function lineDeviation(pts: Point[], a: number, b: number, l: LineFit): number {
  let m = 0
  for (let i = a; i <= b; i++) m = Math.max(m, Math.abs(l.dx * (pts[i].y - l.cy) - l.dy * (pts[i].x - l.cx)))
  return m
}

/**
 * Systematic bending of points around their fitted line: mean signed residual of the middle
 * third minus that of the outer thirds. Pixel noise on a true edge averages out; a gently curved
 * stretch (which can still lie within tolerance of a line) bows consistently to one side.
 */
function lineBow(pts: Point[], a: number, b: number, l: LineFit): number {
  const n = b - a + 1
  let mid = 0
  let midN = 0
  let outer = 0
  let outerN = 0
  for (let i = a; i <= b; i++) {
    const r = l.dx * (pts[i].y - l.cy) - l.dy * (pts[i].x - l.cx)
    const t = (i - a) / (n - 1)
    if (t > 1 / 3 && t < 2 / 3) {
      mid += r
      midN++
    } else {
      outer += r
      outerN++
    }
  }
  return midN && outerN ? Math.abs(mid / midN - outer / outerN) : 0
}

/** Algebraic (Kåsa) circle fit on centred coordinates. Returns null for (near-)collinear points. */
export function fitCircleAlgebraic(pts: Point[], a = 0, b = pts.length - 1): Circle | null {
  const n = b - a + 1
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (let i = a; i <= b; i++) {
    mx += pts[i].x
    my += pts[i].y
  }
  mx /= n
  my /= n
  let suu = 0
  let suv = 0
  let svv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (let i = a; i <= b; i++) {
    const u = pts[i].x - mx
    const v = pts[i].y - my
    const uu = u * u
    const vv = v * v
    suu += uu
    suv += u * v
    svv += vv
    suuu += uu * u
    svvv += vv * v
    suvv += u * vv
    svuu += v * uu
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-10 * (suu + svv) ** 2) return null
  const r1 = 0.5 * (suuu + suvv)
  const r2 = 0.5 * (svvv + svuu)
  const uc = (r1 * svv - r2 * suv) / det
  const vc = (suu * r2 - suv * r1) / det
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) }
}

/** Geometric least-squares refinement (Gauss–Newton on radial distance). */
export function refineCircle(pts: Point[], a: number, b: number, c: Circle, iterations = 4): Circle {
  let { cx, cy, r } = c
  for (let it = 0; it < iterations; it++) {
    // Normal equations JᵀJ δ = -Jᵀe for parameters (cx, cy, r).
    let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0
    let g1 = 0, g2 = 0, g3 = 0
    for (let i = a; i <= b; i++) {
      const dx = pts[i].x - cx
      const dy = pts[i].y - cy
      const d = Math.hypot(dx, dy) || 1e-9
      const j1 = -dx / d
      const j2 = -dy / d
      const j3 = -1
      const e = d - r
      a11 += j1 * j1; a12 += j1 * j2; a13 += j1 * j3
      a22 += j2 * j2; a23 += j2 * j3; a33 += j3 * j3
      g1 += j1 * e; g2 += j2 * e; g3 += j3 * e
    }
    const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13)
    if (Math.abs(det) < 1e-12) break
    const s1 = -(g1 * (a22 * a33 - a23 * a23) - a12 * (g2 * a33 - a23 * g3) + a13 * (g2 * a23 - a22 * g3)) / det
    const s2 = -(a11 * (g2 * a33 - a23 * g3) - g1 * (a12 * a33 - a23 * a13) + a13 * (a12 * g3 - g2 * a13)) / det
    const s3 = -(a11 * (a22 * g3 - g2 * a23) - a12 * (a12 * g3 - g2 * a13) + g1 * (a12 * a23 - a22 * a13)) / det
    cx += s1
    cy += s2
    r += s3
    if (Math.abs(s1) + Math.abs(s2) + Math.abs(s3) < 1e-6) break
  }
  return { cx, cy, r: Math.abs(r) }
}

export function fitCircle(pts: Point[], a = 0, b = pts.length - 1): Circle | null {
  const c = fitCircleAlgebraic(pts, a, b)
  return c ? refineCircle(pts, a, b, c) : null
}

interface ArcCheck {
  circle: Circle
  sweep: number
}

/** Checks that pts[a..b] lie on one circle and progress monotonically around it. */
function arcFits(pts: Point[], a: number, b: number, tol: number): ArcCheck | null {
  const circle = fitCircleAlgebraic(pts, a, b)
  return circle ? checkArc(pts, a, b, circle, tol) : null
}

function checkArc(pts: Point[], a: number, b: number, circle: Circle, tol: number): ArcCheck | null {
  let sweep = 0
  let prev = Math.atan2(pts[a].y - circle.cy, pts[a].x - circle.cx)
  let pos = 0
  let neg = 0
  for (let i = a; i <= b; i++) {
    const p = pts[i]
    if (Math.abs(Math.hypot(p.x - circle.cx, p.y - circle.cy) - circle.r) > tol) return null
    if (i === a) continue
    const ang = Math.atan2(p.y - circle.cy, p.x - circle.cx)
    let d = ang - prev
    if (d > Math.PI) d -= 2 * Math.PI
    else if (d < -Math.PI) d += 2 * Math.PI
    if (d > 0) pos += d
    else neg -= d
    sweep += d
    prev = ang
  }
  if (Math.min(pos, neg) > 0.15 * Math.max(pos, neg) + 0.05) return null
  return { circle, sweep }
}

/** Largest j in (a, limit] for which `fits(a, j)` holds (doubling, then bisection). */
function grow(a: number, limit: number, minCount: number, fits: (a: number, b: number) => boolean): number {
  let good = a
  let step = Math.max(1, minCount - 1)
  let j = Math.min(limit, a + step)
  let bad = -1
  while (j > good) {
    if (fits(a, j)) {
      good = j
      if (j === limit) break
      step *= 2
      j = Math.min(limit, a + step)
    } else {
      bad = j
      break
    }
  }
  if (bad < 0) return good
  let lo = good
  let hi = bad
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (fits(a, mid)) lo = mid
    else hi = mid
  }
  return lo
}

function cornerSkip(pts: Point[], a: number, b: number, trimPx: number): number {
  const spacing = dist(pts[a], pts[b]) / Math.max(1, b - a)
  return Math.max(1, Math.min(3, Math.ceil(trimPx / Math.max(spacing, 1e-6))))
}

/**
 * True when a few straight edges meeting at sharp turns (a chamfered polygon such as a tiny gear
 * tooth) explain pts[a..b] at least as well as the circle `c`. At small scales both fit within
 * tolerance, and the polygon is the simpler explanation when its turns are sharp.
 */
function looksPolygonal(pts: Point[], a: number, b: number, c: Circle, skip = 1): boolean {
  const n = b - a + 1
  if (n > 60) return false
  // Prefix sums for O(1) total-least-squares line error on any sub-range.
  const ox = pts[a].x
  const oy = pts[a].y
  const P = new Float64Array((n + 1) * 5)
  for (let i = 0; i < n; i++) {
    const x = pts[a + i].x - ox
    const y = pts[a + i].y - oy
    const o = i * 5
    P[o + 5] = P[o] + x
    P[o + 6] = P[o + 1] + y
    P[o + 7] = P[o + 2] + x * x
    P[o + 8] = P[o + 3] + x * y
    P[o + 9] = P[o + 4] + y * y
  }
  const sse = (i: number, j: number): number => {
    const k = j - i + 1
    const s = (q: number) => P[(j + 1 - a) * 5 + q] - P[(i - a) * 5 + q]
    const mx = s(0) / k
    const my = s(1) / k
    const sxx = s(2) - k * mx * mx
    const sxy = s(3) - k * mx * my
    const syy = s(4) - k * my * my
    const tr = sxx + syy
    return Math.max(0, tr / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy))
  }
  const dirOf = (i: number, j: number): Point => unit(sub(pts[j], pts[i]))
  const sharp = (...cuts: number[]): boolean => {
    for (let q = 1; q < cuts.length - 1; q++) {
      if (turnAngle(dirOf(cuts[q - 1], cuts[q]), dirOf(cuts[q], cuts[q + 1])) < POLYGON_TURN) return false
    }
    return true
  }
  let arcSse = 0
  for (let i = a; i <= b; i++) arcSse += (Math.hypot(pts[i].x - c.cx, pts[i].y - c.cy) - c.r) ** 2
  const minPts = 2 + skip
  // Samples next to a split are skipped: rasterisation (or thinning) rounds every corner.
  const edge = (i: number, j: number, first: boolean, last: boolean): number => sse(first ? i : i + skip, last ? j : j - skip)
  let best = Infinity
  for (let s1 = a + minPts; s1 <= b - minPts; s1++) {
    const e2 = edge(a, s1, true, false) + edge(s1, b, false, true)
    if (e2 < best && sharp(a, s1, b)) best = e2
    for (let s2 = s1 + minPts; s2 <= b - minPts; s2++) {
      const e3 = edge(a, s1, true, false) + edge(s1, s2, false, false) + edge(s2, b, false, true)
      if (e3 < best && sharp(a, s1, s2, b)) best = e3
    }
  }
  return best <= arcSse
}

// ---------------------------------------------------------------------------------------------
// Segmentation

type Piece =
  | { kind: 'line'; a: number; b: number; fit: LineFit }
  | { kind: 'arc'; a: number; b: number; fit: Circle; dir: number }
  | { kind: 'free'; a: number; b: number }

interface Join {
  point: Point
  /** Shared direction of travel for a smooth join; null for a corner. */
  tangent: Point | null
}

function cumulative(pts: Point[]): Float64Array {
  const cum = new Float64Array(pts.length)
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i])
  return cum
}

function segmentSection(pts: Point[], cum: Float64Array, s: number, e: number, opts: PrimitiveOptions): Piece[] {
  const tol = opts.tolerance
  const minArc = opts.minLength * 1.5
  const out: Piece[] = []
  let freeStart = -1
  const lineFits = (a: number, b: number): boolean => {
    if (b - a < 2) return true
    const l = fitLine(pts, a, b)
    return lineDeviation(pts, a, b, l) <= tol && (b - a < 6 || lineBow(pts, a, b, l) <= 0.55 * tol)
  }
  const arcOk = (a: number, b: number): boolean => b - a < 3 || arcFits(pts, a, b, tol) !== null
  let i = s
  while (i < e) {
    const lineEnd = opts.lines ? grow(i, e, 3, lineFits) : i
    const arcEnd = opts.arcs ? grow(i, e, 4, arcOk) : i
    const lenL = cum[lineEnd] - cum[i]
    const lenA = cum[arcEnd] - cum[i]
    let arc: ArcCheck | null = null
    if (opts.arcs && lenA >= minArc && arcEnd - i >= 3) {
      const rough = arcFits(pts, i, arcEnd, tol)
      arc = rough ? checkArc(pts, i, arcEnd, refineCircle(pts, i, arcEnd, rough.circle), tol) : null
      if (arc && (Math.abs(arc.sweep) < MIN_ARC_SWEEP || arc.circle.r < opts.minRadius)) arc = null
      // A barely bent arc is no better than a straight edge.
      if (arc && arc.circle.r * (1 - Math.cos(Math.min(Math.PI, Math.abs(arc.sweep)) / 2)) < 1.5 * tol) arc = null
      if (arc && opts.lines) {
        const skip = cornerSkip(pts, i, arcEnd, opts.endTrim)
        if (looksPolygonal(pts, i, arcEnd, arc.circle) || (skip > 1 && looksPolygonal(pts, i, arcEnd, arc.circle, skip))) arc = null
      }
    }
    const lineOk = opts.lines && lenL >= opts.minLength && lineEnd > i
    let chosen: Piece | null = null
    if (lineOk && (!arc || lenL >= 0.85 * lenA)) {
      chosen = { kind: 'line', a: i, b: lineEnd, fit: fitLineTrimmed(pts, i, lineEnd, opts.endTrim) }
    } else if (arc) {
      chosen = { kind: 'arc', a: i, b: arcEnd, fit: arc.circle, dir: Math.sign(arc.sweep) || 1 }
    }
    if (!chosen) {
      if (freeStart < 0) freeStart = i
      i++
      continue
    }
    if (freeStart >= 0) out.push({ kind: 'free', a: freeStart, b: i })
    freeStart = -1
    out.push(chosen)
    i = chosen.b
  }
  if (freeStart >= 0) out.push({ kind: 'free', a: freeStart, b: e })
  return out
}

function project(p: Piece, q: Point): Point {
  if (p.kind === 'line') {
    const t = (q.x - p.fit.cx) * p.fit.dx + (q.y - p.fit.cy) * p.fit.dy
    return { x: p.fit.cx + p.fit.dx * t, y: p.fit.cy + p.fit.dy * t }
  }
  if (p.kind === 'arc') {
    const v = unit(sub(q, { x: p.fit.cx, y: p.fit.cy }))
    return { x: p.fit.cx + v.x * p.fit.r, y: p.fit.cy + v.y * p.fit.r }
  }
  return q
}

/** Direction of travel of a piece at point q (on or near it). */
function tangentAt(p: Piece, q: Point, pts: Point[], atEnd: boolean, span = 3): Point {
  if (p.kind === 'line') return { x: p.fit.dx, y: p.fit.dy }
  if (p.kind === 'arc') {
    const v = unit(sub(q, { x: p.fit.cx, y: p.fit.cy }))
    return { x: -v.y * p.dir, y: v.x * p.dir }
  }
  const k = Math.min(span, p.b - p.a)
  return atEnd ? unit(sub(pts[p.b], pts[p.b - k])) : unit(sub(pts[p.a + k], pts[p.a]))
}

function intersect(p: Point, r: Point, q: Point, s: Point): Point | null {
  const d = cross(r, s)
  if (Math.abs(d) < 1e-9) return null
  const t = cross(sub(q, p), s) / d
  return { x: p.x + r.x * t, y: p.y + r.y * t }
}

/**
 * A line that is only a flat stretch of a smooth curve (e.g. the ends of an ellipse, which
 * rasterise into short straight pixel runs) must not create nodes or corners. A line whose
 * neighbours are not straight edges is extended into them by about its own length; if the whole
 * stretch still lies on one circle, the "line" is part of that curve and is demoted.
 */
function demoteFlatLines(pieces: Piece[], pts: Point[], closed: boolean, fixed: Set<number>, cum: Float64Array, opts: PrimitiveOptions): Piece[] {
  const n = pieces.length
  const m = pts.length
  const at = (k: number): Piece | null => (k >= 0 && k < n ? pieces[k] : closed ? pieces[(k + n) % n] : null)
  /** Samples the line may be extended by on one side (0 = anchored by a corner/edge/fixed point). */
  const extension = (k: number, side: 'start' | 'end'): number => {
    const p = pieces[k]
    if (p.kind !== 'line') return 0
    const idx = side === 'start' ? p.a : p.b
    if (fixed.has(idx)) return 0
    const step = side === 'start' ? -1 : 1
    const nb = at(k + step)
    if (!nb || nb === p) return 0
    const dir = { x: p.fit.dx, y: p.fit.dy }
    if (nb.kind === 'line') {
      const t = turnAngle(dir, { x: nb.fit.dx, y: nb.fit.dy })
      // A corner, or the same edge continuing (e.g. across the seam of a closed path).
      if (t >= LINE_ANCHOR_TURN || t < 2 * LINE_CORNER_TURN) return 0
    }
    if (nb.kind === 'arc' && turnAngle(dir, tangentAt(nb, pts[idx], pts, side === 'start')) >= SMOOTH_TURN) return 0
    if (nb.kind === 'free' && cum[nb.b] - cum[nb.a] <= opts.maxGap && at(k + 2 * step)?.kind === 'line') return 0
    const want = Math.max(3, Math.ceil((p.b - p.a) / 2))
    return Math.min(want, nb.b - nb.a, closed ? m : side === 'start' ? idx : m - 1 - idx)
  }
  /** Walks along lines joined at shallow turns; true if the chain ends at a corner, fixed point or path end. */
  const chainBounded = (k: number, step: number): boolean => {
    let cur = pieces[k]
    for (let s = 1; s <= n; s++) {
      if (cur.kind !== 'line') return false
      const idx = step < 0 ? cur.a : cur.b
      if (fixed.has(idx)) return true
      const nb = at(k + s * step)
      if (!nb) return true
      if (nb === pieces[k]) return false
      if (nb.kind !== 'line') {
        if (nb.kind === 'free' && cum[nb.b] - cum[nb.a] <= opts.maxGap && at(k + (s + 1) * step)?.kind === 'line') return true
        return false
      }
      if (turnAngle({ x: cur.fit.dx, y: cur.fit.dy }, { x: nb.fit.dx, y: nb.fit.dy }) >= LINE_ANCHOR_TURN) return true
      cur = nb
    }
    return false
  }
  // Closed working arrays repeat the seam point (pts[m-1] = pts[0]), so wrap modulo m-1.
  const ptAt = (i: number): Point => (closed ? pts[(((i % (m - 1)) + (m - 1)) % (m - 1))] : pts[i])
  const isFlat = (k: number): boolean => {
    const p = pieces[k]
    if (p.kind !== 'line') return false
    const e1 = extension(k, 'start')
    const e2 = extension(k, 'end')
    if (e1 < 3 && e2 < 3) return false
    // Only a curve can make a line "flat"; a chain of lines between two corners stays an edge.
    if (chainBounded(k, -1) && chainBounded(k, 1)) return false
    const stretch: Point[] = []
    for (let i = p.a - e1; i <= p.b + e2; i++) stretch.push(ptAt(i))
    const fit = arcFits(stretch, 0, stretch.length - 1, opts.tolerance * 1.2)
    if (!fit) return false
    const skip = cornerSkip(stretch, 0, stretch.length - 1, opts.endTrim)
    const last = stretch.length - 1
    if (looksPolygonal(stretch, 0, last, fit.circle) || (skip > 1 && looksPolygonal(stretch, 0, last, fit.circle, skip))) return false
    // Only a clearly bent stretch is a curve; a nearly straight one is just a straight edge.
    const chord = dist(stretch[0], stretch[stretch.length - 1])
    const sagitta = fit.circle.r - Math.sqrt(Math.max(0, fit.circle.r ** 2 - (chord / 2) ** 2))
    return sagitta >= 0.5 * opts.tolerance
  }
  const out: Piece[] = []
  pieces.forEach((p, k) => {
    const piece: Piece = isFlat(k) ? { kind: 'free', a: p.a, b: p.b } : p
    const last = out[out.length - 1]
    if (piece.kind === 'free' && last?.kind === 'free' && last.b === piece.a) last.b = piece.b
    else out.push(piece)
  })
  return out
}

/**
 * A smooth curve can be approximated within tolerance by a chain of short lines, but each of
 * those lines keeps bending: its two halves point in clearly different directions. A real edge
 * stays straight along its whole length, so bent lines are handed back to the curve fit.
 */
function demoteBentLines(pieces: Piece[], pts: Point[], closed: boolean, fixed: Set<number>, opts: PrimitiveOptions, cum: Float64Array): Piece[] {
  const n = pieces.length
  const at = (k: number): Piece | null => (k >= 0 && k < n ? pieces[k] : closed && n > 1 ? pieces[(k + n) % n] : null)
  /** A real corner (or a path end / fixed point) anchors this end of a short line. */
  const anchored = (k: number, step: number): boolean => {
    const p = pieces[k] as Extract<Piece, { kind: 'line' }>
    const idx = step < 0 ? p.a : p.b
    if (fixed.has(idx)) return true
    const turnTo = (nb: Piece | null): boolean => {
      if (!nb || nb === p || nb.kind === 'free') return false
      const t = nb.kind === 'line' ? { x: nb.fit.dx, y: nb.fit.dy } : tangentAt(nb, pts[idx], pts, step > 0)
      return turnAngle({ x: p.fit.dx, y: p.fit.dy }, t) >= SHORT_LINE_CORNER
    }
    const nb = at(k + step)
    if (!nb || nb === p) return true
    if (turnTo(nb)) return true
    // Look across a short gap or stub: usually a vertex blunted by rasterisation or thinning.
    return cum[nb.b] - cum[nb.a] <= opts.maxGap && nb.kind !== 'arc' && turnTo(at(k + 2 * step))
  }
  /** A stub inside a blunted vertex between two edges; absorbGaps resolves it into the corner. */
  const stubInCorner = (k: number): boolean => {
    const p = pieces[k]
    const prev = at(k - 1)
    const next = at(k + 1)
    if (cum[p.b] - cum[p.a] > opts.maxGap || prev?.kind !== 'line' || next?.kind !== 'line') return false
    return turnAngle({ x: prev.fit.dx, y: prev.fit.dy }, { x: next.fit.dx, y: next.fit.dy }) >= SHORT_LINE_CORNER
  }
  const out: Piece[] = []
  pieces.forEach((p, k) => {
    let piece: Piece = p
    if (p.kind === 'line' && cum[p.b] - cum[p.a] < 4 * opts.minLength && !(anchored(k, -1) && anchored(k, 1)) && !stubInCorner(k)) {
      piece = { kind: 'free', a: p.a, b: p.b }
    } else if (p.kind === 'line') {
      const spacing = (cum[p.b] - cum[p.a]) / Math.max(1, p.b - p.a)
      const trim = Math.max(1, Math.ceil(opts.endTrim / Math.max(spacing, 1e-6)))
      const s = p.a + trim
      const e = p.b - trim
      const mid = Math.round((s + e) / 2)
      if (mid - s >= 3 && e - mid >= 3) {
        const d1 = fitLine(pts, s, mid)
        const d2 = fitLine(pts, mid, e)
        const half = (cum[e] - cum[s]) / 2
        const noise = (0.5 * opts.tolerance) / 0.6
        const limit = Math.max(BENT_LINE_TURN, Math.atan((1.5 * noise) / Math.max(half, 1e-6)))
        if (turnAngle({ x: d1.dx, y: d1.dy }, { x: d2.dx, y: d2.dy }) > limit) piece = { kind: 'free', a: p.a, b: p.b }
      }
    }
    const last = out[out.length - 1]
    if (piece.kind === 'free' && last?.kind === 'free' && last.b === piece.a) last.b = piece.b
    else out.push(piece)
  })
  return out
}

/** Arcs survive only when both ends are anchored (line, corner, fixed point, path end). */
function demoteFloatingArcs(
  pieces: Piece[],
  pts: Point[],
  closed: boolean,
  fixed: Set<number>,
  maxGap: number,
  cum: Float64Array,
  resegment?: (a: number, b: number) => Piece[],
): Piece[] {
  const n = pieces.length
  const neighbour = (k: number, step: number): Piece | null => {
    let j = k + step
    if (j < 0 || j >= n) {
      if (!closed) return null
      j = (j + n) % n
    }
    return pieces[j]
  }
  const anchored = (k: number, side: 'start' | 'end'): boolean => {
    const p = pieces[k]
    const idx = side === 'start' ? p.a : p.b
    if (fixed.has(idx)) return true
    let nb = neighbour(k, side === 'start' ? -1 : 1)
    if (!nb) return true
    let gap = 0
    if (nb.kind === 'free') {
      gap = cum[nb.b] - cum[nb.a]
      if (gap > maxGap) return false
      const beyond = neighbour(k, side === 'start' ? -2 : 2)
      if (!beyond || beyond === p) return true
      nb = beyond
    }
    if (nb.kind === 'line') return true
    if (nb.kind === 'free') return false
    const q = pts[idx]
    const t1 = side === 'end' ? tangentAt(p, q, pts, true) : tangentAt(nb, q, pts, true)
    const t2 = side === 'end' ? tangentAt(nb, q, pts, false) : tangentAt(p, q, pts, false)
    return turnAngle(t1, t2) >= SMOOTH_TURN
  }
  const keep = pieces.map((p, k) => p.kind !== 'arc' || (anchored(k, 'start') && anchored(k, 'end')))
  const out: Piece[] = []
  pieces.forEach((p, k) => {
    const replaced: Piece[] = keep[k] ? [p] : resegment ? resegment(p.a, p.b) : [{ kind: 'free', a: p.a, b: p.b }]
    for (const piece of replaced) {
      const last = out[out.length - 1]
      if (piece.kind === 'free' && last?.kind === 'free' && last.b === piece.a) last.b = piece.b
      else out.push(piece)
    }
  })
  return out
}

/** Prefix sums giving the total-least-squares line error of any index range in O(1). */
function lineErrorTable(pts: Point[]): (i: number, j: number) => number {
  const n = pts.length
  const ox = pts[0]?.x ?? 0
  const oy = pts[0]?.y ?? 0
  const P = new Float64Array((n + 1) * 5)
  for (let i = 0; i < n; i++) {
    const x = pts[i].x - ox
    const y = pts[i].y - oy
    const o = i * 5
    P[o + 5] = P[o] + x
    P[o + 6] = P[o + 1] + y
    P[o + 7] = P[o + 2] + x * x
    P[o + 8] = P[o + 3] + x * y
    P[o + 9] = P[o + 4] + y * y
  }
  return (i, j) => {
    if (j <= i) return 0
    const k = j - i + 1
    const s = (q: number) => P[(j + 1) * 5 + q] - P[i * 5 + q]
    const mx = s(0) / k
    const my = s(1) / k
    const sxx = s(2) - k * mx * mx
    const sxy = s(3) - k * mx * my
    const syy = s(4) - k * my * my
    return Math.max(0, (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy))
  }
}

/**
 * Greedy growth lets a line run past a rounded corner into the next edge. For every pair of
 * adjacent lines the shared boundary is moved to the split with the least combined error
 * (skipping the sample on each side of it), then both lines are refitted.
 */
function refineLineBoundaries(pieces: Piece[], pts: Point[], fixed: Set<number>, trimPx: number): Piece[] {
  const err = lineErrorTable(pts)
  const out = pieces.map((p) => ({ ...p }) as Piece)
  for (let k = 0; k + 1 < out.length; k++) {
    const x = out[k]
    const y = out[k + 1]
    if (x.kind !== 'line' || y.kind !== 'line' || x.b !== y.a || fixed.has(x.b)) continue
    let best = x.b
    let bestErr = Infinity
    for (let s = x.a + 3; s <= y.b - 3; s++) {
      const e = err(x.a, s - 1) + err(s + 1, y.b)
      if (e < bestErr) {
        bestErr = e
        best = s
      }
    }
    if (best === x.b) continue
    out[k] = { kind: 'line', a: x.a, b: best, fit: fitLineTrimmed(pts, x.a, best, trimPx) }
    out[k + 1] = { kind: 'line', a: best, b: y.b, fit: fitLineTrimmed(pts, best, y.b, trimPx) }
  }
  return out
}

/** Merges consecutive lines whose union is still straight within tolerance. */
function mergeCollinear(pieces: Piece[], pts: Point[], fixed: Set<number>, tol: number, trimPx: number): Piece[] {
  const out: Piece[] = []
  for (const p of pieces) {
    const last = out[out.length - 1]
    if (p.kind === 'line' && last?.kind === 'line' && last.b === p.a && !fixed.has(p.a)) {
      const fit = fitLine(pts, last.a, p.b)
      if (lineDeviation(pts, last.a, p.b, fit) <= 1.5 * tol) {
        out[out.length - 1] = { kind: 'line', a: last.a, b: p.b, fit: fitLineTrimmed(pts, last.a, p.b, trimPx) }
        continue
      }
    }
    out.push(p)
  }
  return out
}

/** Absorbs short free gaps between two primitives; they meet directly at a corner or tangent. */
function absorbGaps(pieces: Piece[], pts: Point[], fixed: Set<number>, opts: PrimitiveOptions, cum: Float64Array, closed: boolean): Piece[] {
  const n = pieces.length
  const maxGap = opts.maxGap
  const at = (k: number): Piece | undefined => (k >= 0 && k < n ? pieces[k] : closed && n > 2 ? pieces[(k + n) % n] : undefined)
  const lengthOf = (p: Piece): number => cum[p.b] - cum[p.a]
  const tangentTo = (arc: Extract<Piece, { kind: 'arc' }>, ln: Extract<Piece, { kind: 'line' }>): boolean =>
    Math.abs(dist({ x: arc.fit.cx, y: arc.fit.cy }, project(ln, { x: arc.fit.cx, y: arc.fit.cy })) - arc.fit.r) <= 1.5 * opts.tolerance
  return pieces.filter((p, k) => {
    const prev = at(k - 1)
    const next = at(k + 1)
    if (p.kind === 'line') {
      // A stub edge inside a blunted vertex: much shorter than both edges it connects.
      if (prev?.kind !== 'line' || next?.kind !== 'line' || fixed.has(p.a) || fixed.has(p.b)) return true
      const len = lengthOf(p)
      const stub = opts.endTrim > 0 ? Math.max(0.6 * maxGap, 2.6 * opts.endTrim) : 0.6 * maxGap
      const ratio = opts.endTrim > 0 ? 2 : 3
      if (len > stub || len * ratio > Math.min(lengthOf(prev), lengthOf(next))) return true
      return turnAngle({ x: prev.fit.dx, y: prev.fit.dy }, { x: next.fit.dx, y: next.fit.dy }) < POLYGON_TURN
    }
    if (!prev || !next || prev.kind === 'free' || next.kind === 'free') return true
    if (fixed.has(p.a) || fixed.has(p.b)) return true
    const len = lengthOf(p)
    if (prev.kind === 'line' && next.kind === 'line') {
      const turn = turnAngle({ x: prev.fit.dx, y: prev.fit.dy }, { x: next.fit.dx, y: next.fit.dy })
      if (turn >= POLYGON_TURN) {
        // A real fillet touches both edges tangentially; anything else this short between two
        // edges is the vertex blunted by rasterisation (over ~1/sin(half-angle) pixels).
        if (p.kind === 'arc' && tangentTo(p, prev) && tangentTo(p, next)) return true
        const halfAngle = (Math.PI - turn) / 2
        const limit = Math.max(maxGap / Math.max(0.3, Math.sin(halfAngle) + 0.3), Math.min(3 * maxGap, 0.25 * Math.min(lengthOf(prev), lengthOf(next))))
        if (len > limit) return true
        // A blunted vertex stays close to where the edges meet; a rounded turn of radius R misses
        // that point by R·(1/sin(half-angle) − 1).
        const corner = intersect(project(prev, pts[p.a]), { x: prev.fit.dx, y: prev.fit.dy }, project(next, pts[p.b]), { x: next.fit.dx, y: next.fit.dy })
        if (!corner) return true
        let miss = Infinity
        for (let i = p.a; i <= p.b; i++) miss = Math.min(miss, dist(pts[i], corner))
        const rounding = Math.max(3 * opts.tolerance, 2 * opts.endTrim)
        return miss > Math.max(1.5 * opts.tolerance, rounding * (1 / Math.max(0.05, Math.sin(halfAngle)) - 1))
      }
    }
    return p.kind === 'arc' || len > maxGap
  })
}

/**
 * Joins two collinear edges separated by a short bump (a junction where a branch leaves a
 * centerline, or a speck on an outline) into one edge. The bump may deviate by about a stroke
 * radius on centerlines, but only by the normal tolerance on outlines.
 */
function mergeAcrossBumps(pieces: Piece[], pts: Point[], fixed: Set<number>, opts: PrimitiveOptions, cum: Float64Array): Piece[] {
  const tol = opts.tolerance
  const bump = opts.strokeRadius > 0 ? tol + opts.strokeRadius : 1.5 * tol
  const cut = 2 * opts.strokeRadius
  const maxLen = 2 * opts.maxGap + 2 * cut
  const out: Piece[] = []
  for (const p of pieces) {
    const A = out[out.length - 1]
    if (p.kind !== 'line' || !A) {
      out.push(p)
      continue
    }
    // Walk back over short pieces (curves or short tilted lines) to a collinear line; the
    // farthest one first, so a tilted piece of the bump never claims the edge.
    const cands: number[] = []
    let gapLen = 0
    for (let k = out.length - 1; k >= 0; k--) {
      if (k < out.length - 1) gapLen += cum[out[k + 1].b] - cum[out[k + 1].a]
      if (gapLen > maxLen || fixed.has(out[k].b)) break
      cands.push(k)
    }
    let merged = false
    for (const k of cands.reverse()) {
      const L = out[k]
      if (L.kind !== 'line' || L.b > p.a) continue
      if (L.fit.dx * p.fit.dx + L.fit.dy * p.fit.dy < Math.cos(2 * LINE_CORNER_TURN)) continue
      // The edge ends next to the bump already lean into it; hold them to the bump limit only.
      let la = L.b
      while (la > L.a && cum[L.b] - cum[la] < cut) la--
      let pb = p.a
      while (pb < p.b && cum[pb] - cum[p.a] < cut) pb++
      if (cum[la] - cum[L.a] < opts.minLength || cum[p.b] - cum[pb] < opts.minLength) continue
      // Outer ends are left out of the fit: they pick up the rounding of the corners beyond.
      const ta = Math.round(0.1 * (la - L.a))
      const tb = Math.round(0.1 * (p.b - pb))
      const edgePts = [...pts.slice(L.a + ta, la + 1), ...pts.slice(pb, p.b + 1 - tb)]
      let fit = fitLine(edgePts)
      if (fit.dx * (pts[p.b].x - pts[L.a].x) + fit.dy * (pts[p.b].y - pts[L.a].y) < 0) fit = { ...fit, dx: -fit.dx, dy: -fit.dy }
      fit = snapToAxis(fit, pts, L.a, p.b, tol)
      // Each edge must sit on the joint line about as well as on its own (it may already hold an
      // absorbed bump of its own).
      const limA = Math.max(1.5 * tol, lineDeviation(pts, L.a + ta, la, L.fit) + 0.5 * tol)
      const limB = Math.max(1.5 * tol, lineDeviation(pts, pb, p.b - tb, p.fit) + 0.5 * tol)
      if (lineDeviation(pts, L.a + ta, la, fit) > limA || lineDeviation(pts, pb, p.b - tb, fit) > limB) continue
      if (lineDeviation(pts, la, pb, fit) > bump) continue
      // Outer ends run into the neighbouring corners, whose rasterised apex is clipped.
      const endLim = Math.max(bump, 2.5 * tol)
      if (lineDeviation(pts, L.a, L.a + ta, fit) > endLim || lineDeviation(pts, p.b - tb, p.b, fit) > endLim) continue
      out.length = k
      out.push({ kind: 'line', a: L.a, b: p.b, fit })
      merged = true
      break
    }
    if (!merged) out.push(p)
  }
  return out
}

interface CornerFit {
  r: number
  err: number
  /** Mean squared error of the window samples nearest the fillet arc (or corner). */
  arcRms: number
  P: Point
  T1: Point
  T2: Point
  C: Point
}

/**
 * Best corner between two straight edges: a circle tangent to both (radius r ≥ 0, r = 0 being a
 * sharp corner), fitted to the samples around the corner. Edges eaten into the rounding by the
 * greedy segmentation do not matter: only the fitted lines and the raw samples are used.
 */
/**
 * Turns a line within AXIS_SNAP of horizontal or vertical exactly onto that axis (about its
 * centroid), provided its samples still fit: drawn rectangles and frames come out square, while a
 * genuinely tilted long edge drifts out of tolerance and keeps its angle.
 */
function snapToAxis(fit: LineFit, pts: Point[], a: number, b: number, tol: number): LineFit {
  const ax = Math.abs(fit.dx) >= Math.abs(fit.dy) ? { x: Math.sign(fit.dx), y: 0 } : { x: 0, y: Math.sign(fit.dy) }
  if (ax.x === 0 && ax.y === 0) return fit
  if (Math.abs(fit.dx * ax.y - fit.dy * ax.x) > Math.sin(AXIS_SNAP)) return fit
  if (ax.x === fit.dx && ax.y === fit.dy) return fit
  const snapped = { cx: fit.cx, cy: fit.cy, dx: ax.x, dy: ax.y }
  const limit = Math.max(tol, lineDeviation(pts, a, b, fit) + 0.25 * tol)
  return lineDeviation(pts, a, b, snapped) <= limit ? snapped : fit
}

function fitCorner(A: LineFit, B: LineFit, pts: Point[], i0: number, i1: number, dmax: number, forceR?: number): CornerFit | null {
  const dA = { x: A.dx, y: A.dy }
  const dB = { x: B.dx, y: B.dy }
  const P = intersect({ x: A.cx, y: A.cy }, dA, { x: B.cx, y: B.cy }, dB)
  if (!P) return null
  const turn = turnAngle(dA, dB)
  const h = (Math.PI - turn) / 2
  const inward = unit(sub(dB, dA))
  const far = dmax * 4 + 10
  const segDist = (q: Point, a: Point, b: Point): number => {
    const ab = sub(b, a)
    const l2 = dot(ab, ab)
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2))
    return Math.hypot(q.x - a.x - ab.x * t, q.y - a.y - ab.y * t)
  }
  const model = (r: number) => {
    const d = r / Math.tan(h)
    const T1 = { x: P.x - dA.x * d, y: P.y - dA.y * d }
    const T2 = { x: P.x + dB.x * d, y: P.y + dB.y * d }
    const C = { x: P.x + inward.x * (r / Math.sin(h)), y: P.y + inward.y * (r / Math.sin(h)) }
    const A0 = { x: P.x - dA.x * far, y: P.y - dA.y * far }
    const B1 = { x: P.x + dB.x * far, y: P.y + dB.y * far }
    const v1 = sub(T1, C)
    const v2 = sub(T2, C)
    const span = Math.abs(Math.atan2(cross(v1, v2), dot(v1, v2)))
    return { T1, T2, C, dist: (q: Point): { d: number; onArc: boolean } => {
      const dl = Math.min(segDist(q, A0, T1), segDist(q, T2, B1))
      if (r <= 1e-9) return { d: dl, onArc: false }
      const v = sub(q, C)
      const a1 = Math.abs(Math.atan2(cross(v1, v), dot(v1, v)))
      const a2 = Math.abs(Math.atan2(cross(v, v2), dot(v, v2)))
      if (a1 + a2 <= span + 1e-6) {
        const da = Math.abs(Math.hypot(v.x, v.y) - r)
        return da < dl ? { d: da, onArc: true } : { d: dl, onArc: false }
      }
      return { d: dl, onArc: false }
    } }
  }
  const errOf = (r: number): number => {
    const m = model(r)
    let e = 0
    for (let i = i0; i <= i1; i++) e += m.dist(pts[i]).d ** 2
    return e
  }
  const rMax = Math.max(0, dmax * Math.tan(h))
  let finalR: number
  let finalE: number
  if (forceR !== undefined) {
    if (forceR > rMax) return null
    finalR = forceR
    finalE = errOf(forceR)
  } else {
    const steps = 48
    let bestR = 0
    let bestE = errOf(0)
    for (let s = 1; s <= steps; s++) {
      const r = (rMax * s) / steps
      const e = errOf(r)
      if (e < bestE) {
        bestE = e
        bestR = r
      }
    }
    let lo = Math.max(0, bestR - rMax / steps)
    let hi = Math.min(rMax, bestR + rMax / steps)
    for (let it = 0; it < 24; it++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (errOf(m1) < errOf(m2)) hi = m2
      else lo = m1
    }
    const r = (lo + hi) / 2
    const e = errOf(r)
    finalR = e < bestE ? r : bestR
    finalE = Math.min(e, bestE)
  }
  const m = model(finalR)
  let arcSq = 0
  let arcN = 0
  for (let i = i0; i <= i1; i++) {
    const q = m.dist(pts[i])
    if (q.onArc || finalR <= 1e-9) {
      arcSq += q.d ** 2
      arcN++
    }
  }
  return { r: finalR, err: finalE, arcRms: arcN ? Math.sqrt(arcSq / arcN) : 0, P, T1: m.T1, T2: m.T2, C: m.C }
}

/**
 * Re-solves every corner between two straight edges with `fitCorner`: the pieces in between
 * (chamfer stubs, short free curves, mis-sized arcs) are replaced by an exact tangent fillet arc,
 * or removed so the edges meet at a sharp corner.
 */
function fitCorners(pieces: Piece[], pts: Point[], fixed: Set<number>, opts: PrimitiveOptions, cum: Float64Array): Piece[] {
  const tol = opts.tolerance
  const lenOf = (p: Piece): number => cum[p.b] - cum[p.a]
  const isEdge = (p: Piece | undefined): p is Extract<Piece, { kind: 'line' }> => p?.kind === 'line' && lenOf(p) >= 2 * opts.minLength
  const dirOf = (p: Extract<Piece, { kind: 'line' }>): Point => ({ x: p.fit.dx, y: p.fit.dy })
  const out: Piece[] = []
  const corners: FilletRecord[] = []
  let k = 0
  while (k < pieces.length) {
    const A = pieces[k]
    if (!isEdge(A)) {
      out.push(A)
      k++
      continue
    }
    // The next edge, past free curves and arcs; a short line is skipped only when it is a chamfer
    // (shallow turns at both ends), never when it is a real edge such as a tooth top.
    let j = k + 1
    while (j < pieces.length && !isEdge(pieces[j])) {
      const p = pieces[j]
      if (p.kind === 'line') {
        const prev = pieces[j - 1]
        const next = pieces[j + 1]
        const shallow = (q: Piece | undefined) => q?.kind !== 'line' || turnAngle(dirOf(q), dirOf(p)) < SHORT_LINE_CORNER
        // Also a chamfer: a pixel stub whose neighbours meet right beside it (the flanks around a
        // tooth top meet far away).
        let stub = false
        if (prev?.kind === 'line' && next?.kind === 'line') {
          const X = intersect({ x: prev.fit.cx, y: prev.fit.cy }, dirOf(prev), { x: next.fit.cx, y: next.fit.cy }, dirOf(next))
          const midP = { x: (pts[p.a].x + pts[p.b].x) / 2, y: (pts[p.a].y + pts[p.b].y) / 2 }
          // Skeletons cut a corner off by about r_s / sin(half-angle) on top of that.
          const half = (Math.PI - turnAngle(dirOf(prev), dirOf(next))) / 2
          const skeletonCut = opts.strokeRadius > 0 ? opts.strokeRadius / Math.max(Math.sin(half), 0.2) : 0
          stub = !!X && dist(X, midP) <= Math.max(lenOf(p), 2 * tol) + skeletonCut
        }
        if (!stub && (!shallow(prev) || !shallow(next))) break
      }
      j++
    }
    const B = pieces[j]
    let ok = isEdge(B)
    const between = ok ? cum[B.a] - cum[A.b] : 0
    const maxBetween = 6 * opts.maxGap + Math.min(lenOf(A), ok ? lenOf(B) : 0)
    if (ok && between > maxBetween) ok = false
    if (ok) for (let i = A.b; i <= B.a; i++) if (fixed.has(i)) ok = false
    const Bl = B as Extract<Piece, { kind: 'line' }>
    if (ok && turnAngle({ x: A.fit.dx, y: A.fit.dy }, { x: Bl.fit.dx, y: Bl.fit.dy }) < MIN_ARC_SWEEP) ok = false
    if (!ok) {
      out.push(A)
      k++
      continue
    }
    // Window: the stretch between the edges plus the edge ends that may hide part of the rounding.
    const reachA = Math.min(0.5 * lenOf(A), between + 2 * opts.maxGap)
    const reachB = Math.min(0.5 * lenOf(Bl), between + 2 * opts.maxGap)
    let i0 = A.b
    while (i0 > A.a + 1 && cum[A.b] - cum[i0 - 1] <= reachA) i0--
    let i1 = Bl.a
    while (i1 < Bl.b - 1 && cum[i1 + 1] - cum[Bl.a] <= reachB) i1++
    let fa = A.fit
    let fb = Bl.fit
    let fit: CornerFit | null = null
    let cornerDmax = 0
    for (let pass = 0; pass < 2; pass++) {
      const P = intersect({ x: fa.cx, y: fa.cy }, { x: fa.dx, y: fa.dy }, { x: fb.cx, y: fb.cy }, { x: fb.dx, y: fb.dy })
      if (!P) break
      const dmax = Math.min(dot(sub(P, pts[A.a]), { x: fa.dx, y: fa.dy }) - 0.5 * lenOf(A), dot(sub(pts[Bl.b], P), { x: fb.dx, y: fb.dy }) - 0.5 * lenOf(Bl)) + between / 2
      if (!(dmax > 0)) break
      fit = fitCorner(fa, fb, pts, i0, i1, dmax)
      cornerDmax = dmax
      if (!fit) break
      // Refit the edges without the corner samples, then solve again.
      const cutA = nearestIndex(pts, A.a, A.b, fit.T1)
      const cutB = nearestIndex(pts, Bl.a, Bl.b, fit.T2)
      if (pass === 0 && cutA - A.a >= 4 && Bl.b - cutB >= 4) {
        fa = opts.lines ? snapToAxis(fitLineTrimmed(pts, A.a, cutA, opts.endTrim), pts, A.a, cutA, tol) : fitLineTrimmed(pts, A.a, cutA, opts.endTrim)
        fb = opts.lines ? snapToAxis(fitLineTrimmed(pts, cutB, Bl.b, opts.endTrim), pts, cutB, Bl.b, tol) : fitLineTrimmed(pts, cutB, Bl.b, opts.endTrim)
      }
    }
    const turn = turnAngle({ x: fa.dx, y: fa.dy }, { x: fb.dx, y: fb.dy })
    const innerDepth = (f: CornerFit): number => {
      if (!opts.radiusAt) return 0
      const inward = unit(sub({ x: fb.dx, y: fb.dy }, { x: fa.dx, y: fa.dy }))
      const off = (opts.strokeRadius + 0.25) / Math.sin((Math.PI - turn) / 2)
      return opts.radiusAt({ x: f.P.x + inward.x * off, y: f.P.y + inward.y * off })
    }
    let rounded = opts.arcs && !!fit && turn >= MIN_ARC_SWEEP && fit.r >= opts.minRadius && fit.arcRms <= 0.75 * tol
    let miss = Infinity
    if (fit) for (let i = i0; i <= i1; i++) miss = Math.min(miss, dist(pts[i], fit.P))
    if (fit && rounded) {
      // The edges' meeting point lies off a rounded corner but on (outlines) or deep inside
      // (centerlines: about one stroke radius / sin(half-angle) from the background) a sharp one.
      // Centerlines: a fillet no larger than the stroke radius leaves the inside of the stroke
      // sharp, and rasterised acute corners measure about that much. When the edges' meeting
      // point is off the ink altogether, the stroke plainly turns before reaching it.
      if (opts.radiusAt && opts.strokeRadius > 0) {
        const offInk = opts.radiusAt(fit.P) < 0.5 * opts.strokeRadius
        rounded = miss >= tol && fit.r >= 1.5 * opts.strokeRadius + 1 && (offInk || innerDepth(fit) >= 1.75)
      } else rounded = miss >= 2.5 * tol
    }
    if (!fit || !rounded) {
      // A sharp corner: whatever lies between the edges (a misfit arc, a free blob) goes, when the
      // two edges alone explain it. Skeletons round sharp corners by about r_s / sin(half-angle).
      const half = (Math.PI - turn) / 2
      const sharpLim = opts.strokeRadius > 0 ? 2.5 * tol + opts.strokeRadius / Math.sin(half) : 2.5 * tol
      const m = fit ? nearestIndex(pts, A.b, Bl.a, fit.P) : -1
      let sharp = !!fit && j > k + 1 && m > A.a + 1 && m < Bl.b - 1
      // The sharp apex must exist in the drawing: on the ink for strokes, on the boundary for
      // outlines. Otherwise the pieces that follow the ink are kept.
      if (sharp && fit) sharp = opts.radiusAt && opts.strokeRadius > 0 ? opts.radiusAt(fit.P) >= 0.5 * opts.strokeRadius : miss <= 2.5 * tol
      for (let i = A.b; sharp && i <= Bl.a; i++) {
        const q = pts[i]
        const d = Math.min(Math.abs(fa.dx * (q.y - fa.cy) - fa.dy * (q.x - fa.cx)), Math.abs(fb.dx * (q.y - fb.cy) - fb.dy * (q.x - fb.cx)))
        if (d > sharpLim) sharp = false
      }
      if (!sharp) {
        out.push(A)
        k++
        continue
      }
      out.push({ kind: 'line', a: A.a, b: m, fit: fa })
      pieces = pieces.slice()
      pieces[j] = { kind: 'line', a: m, b: Bl.b, fit: fb }
      k = j
      continue
    }
    const cutA = nearestIndex(pts, A.a + 2, Bl.b - 3, fit.T1)
    const cutB = nearestIndex(pts, cutA + 1, Bl.b - 2, fit.T2)
    const v = unit(sub(fit.T1, fit.C))
    const dir = dot({ x: -v.y, y: v.x }, { x: fa.dx, y: fa.dy }) > 0 ? 1 : -1
    out.push({ kind: 'line', a: A.a, b: cutA, fit: fa })
    out.push({ kind: 'arc', a: cutA, b: cutB, fit: { cx: fit.C.x, cy: fit.C.y, r: fit.r }, dir })
    corners.push({ arc: out.length - 1, fa, fb, i0, i1, dmax: cornerDmax, r: fit.r })
    pieces = pieces.slice()
    pieces[j] = { kind: 'line', a: cutB, b: Bl.b, fit: fb }
    k = j
  }
  equaliseFillets(out, corners, pts, tol)
  return out
}

interface FilletRecord {
  /** Index of the fillet arc in the output; the edges are the pieces either side of it. */
  arc: number
  fa: LineFit
  fb: LineFit
  i0: number
  i1: number
  dmax: number
  r: number
}

/**
 * Drawn shapes repeat one corner radius (a rounded rectangle, a slot, a bracket); the separately
 * measured fillets scatter by a pixel or two around it. Fillets of similar radius are re-solved at
 * their mean radius wherever that still fits their samples.
 */
function equaliseFillets(out: Piece[], corners: FilletRecord[], pts: Point[], tol: number): void {
  if (corners.length < 2) return
  const sorted = [...corners].sort((a, b) => a.r - b.r)
  const groups: FilletRecord[][] = []
  for (const c of sorted) {
    const g = groups[groups.length - 1]
    if (g && c.r <= (g.reduce((s, x) => s + x.r, 0) / g.length) * FILLET_RADIUS_RATIO) g.push(c)
    else groups.push([c])
  }
  for (const g of groups) {
    if (g.length < 2) continue
    const r = g.reduce((s, c) => s + c.r, 0) / g.length
    for (const c of g) {
      const before = out[c.arc - 1]
      const after = out[c.arc + 1]
      if (before?.kind !== 'line' || after?.kind !== 'line') continue
      const fit = fitCorner(c.fa, c.fb, pts, c.i0, c.i1, c.dmax, r)
      if (!fit || fit.arcRms > 0.75 * tol) continue
      const cutA = nearestIndex(pts, before.a + 2, after.b - 3, fit.T1)
      const cutB = nearestIndex(pts, cutA + 1, after.b - 2, fit.T2)
      const arc = out[c.arc]
      if (arc.kind !== 'arc') continue
      out[c.arc - 1] = { ...before, b: cutA }
      out[c.arc] = { ...arc, a: cutA, b: cutB, fit: { cx: fit.C.x, cy: fit.C.y, r } }
      out[c.arc + 1] = { ...after, a: cutB }
    }
  }
}

function nearestIndex(pts: Point[], a: number, b: number, q: Point): number {
  let best = a
  let bd = Infinity
  for (let i = a; i <= b; i++) {
    const d = dist(pts[i], q)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

function computeJoin(x: Piece, y: Piece, pts: Point[], fixedIdx: number | null, hardFixed: boolean, reach: number, tol: number): Join {
  const qx = pts[x.b]
  const qy = pts[y.a]
  if (fixedIdx !== null) {
    const point = pts[fixedIdx]
    if (hardFixed) return { point, tangent: null }
    const tx = tangentAt(x, point, pts, true)
    const ty = tangentAt(y, point, pts, false)
    const turn = turnAngle(tx, ty)
    if (x.kind === 'line' && y.kind === 'line' && turn >= LINE_CORNER_TURN * 4) return { point, tangent: null }
    if (turn >= FREE_SMOOTH_TURN) return { point, tangent: null }
    const tangent = x.kind === 'line' ? tx : y.kind === 'line' ? ty : unit({ x: tx.x + ty.x, y: tx.y + ty.y })
    return { point, tangent }
  }
  if ((x.kind === 'line' && y.kind === 'arc') || (x.kind === 'arc' && y.kind === 'line')) {
    const ln = x.kind === 'line' ? x : (y as Extract<Piece, { kind: 'line' }>)
    const arc = x.kind === 'arc' ? x : (y as Extract<Piece, { kind: 'arc' }>)
    const mid = { x: (qx.x + qy.x) / 2, y: (qx.y + qy.y) / 2 }
    const c = { x: arc.fit.cx, y: arc.fit.cy }
    const foot = project(ln, c)
    const dir = { x: ln.fit.dx, y: ln.fit.dy }
    const slide = 1.5 * Math.sqrt(2 * arc.fit.r * tol)
    if (Math.abs(dist(c, foot) - arc.fit.r) <= tol * 1.5 && dist(foot, mid) <= reach + slide + dist(qx, qy)) {
      return { point: foot, tangent: dir }
    }
    // Corner: the line–circle intersection nearest to where the pieces meet.
    const off = dist(c, foot)
    if (off < arc.fit.r) {
      const h = Math.sqrt(arc.fit.r * arc.fit.r - off * off)
      const cands = [
        { x: foot.x + dir.x * h, y: foot.y + dir.y * h },
        { x: foot.x - dir.x * h, y: foot.y - dir.y * h },
      ]
      const best = cands.sort((p, q) => dist(p, mid) - dist(q, mid))[0]
      if (dist(best, mid) <= reach + dist(qx, qy)) {
        const turn = turnAngle(tangentAt(x, best, pts, true), tangentAt(y, best, pts, false))
        return { point: best, tangent: turn < FREE_SMOOTH_TURN ? dir : null }
      }
    }
  }
  if (x.kind !== 'free' && y.kind !== 'free') {
    const ex = project(x, qx)
    const sy = project(y, qy)
    const tx = tangentAt(x, ex, pts, true)
    const ty = tangentAt(y, sy, pts, false)
    const turn = turnAngle(tx, ty)
    const mid = { x: (ex.x + sy.x) / 2, y: (ex.y + sy.y) / 2 }
    const corner = x.kind === 'line' && y.kind === 'line' ? turn >= LINE_CORNER_TURN : turn >= FREE_SMOOTH_TURN
    if (corner) {
      const p = intersect(ex, tx, sy, ty)
      const ok = p && dist(p, mid) <= reach + dist(ex, sy) && dot(sub(p, ex), tx) > -reach && dot(sub(sy, p), ty) > -reach
      return { point: ok ? p : mid, tangent: null }
    }
    const tangent = x.kind === 'line' ? tx : y.kind === 'line' ? ty : unit({ x: tx.x + ty.x, y: tx.y + ty.y })
    return { point: mid, tangent }
  }
  // One side is free: meet at the primitive's projection of the shared point.
  const prim = x.kind !== 'free' ? x : y
  const point = project(prim, x.kind !== 'free' ? qx : qy)
  const tp = tangentAt(prim, point, pts, prim === x)
  const free = prim === x ? y : x
  const spacing = dist(pts[free.a], pts[free.b]) / Math.max(1, free.b - free.a)
  const tf = tangentAt(free, point, pts, prim !== x, Math.max(3, Math.ceil((4 * tol) / Math.max(spacing, 1e-6))))
  if (x.kind === 'free' && y.kind === 'free') return { point: qx, tangent: null }
  return { point, tangent: turnAngle(tp, tf) < FREE_SMOOTH_TURN ? tp : null }
}

// ---------------------------------------------------------------------------------------------
// Emission

function emitArc(out: PathSegment[], c: Circle, dir: number, s: Point, e: Point, ts: Point | null, te: Point | null): void {
  const center = { x: c.cx, y: c.cy }
  const a0 = Math.atan2(s.y - c.cy, s.x - c.cx)
  const a1 = Math.atan2(e.y - c.cy, e.x - c.cx)
  let sweep = a1 - a0
  if (dir > 0) while (sweep <= 1e-9) sweep += 2 * Math.PI
  else while (sweep >= -1e-9) sweep -= 2 * Math.PI
  if (Math.abs(sweep) > 2 * Math.PI - 1e-3 && dist(s, e) < 1e-6) sweep = dir * 2 * Math.PI
  const k = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 0.05))
  const step = sweep / k
  const h = (4 / 3) * Math.tan(Math.abs(step) / 4) * c.r
  const onCircle = (ang: number): Point => ({ x: center.x + c.r * Math.cos(ang), y: center.y + c.r * Math.sin(ang) })
  const tan = (ang: number): Point => ({ x: -Math.sin(ang) * dir, y: Math.cos(ang) * dir })
  for (let j = 0; j < k; j++) {
    const t0 = a0 + step * j
    const t1 = a0 + step * (j + 1)
    const p0 = j === 0 ? s : onCircle(t0)
    const p3 = j === k - 1 ? e : onCircle(t1)
    let d0 = tan(t0)
    let d1 = tan(t1)
    if (j === 0 && ts && dot(ts, d0) > 0) d0 = ts
    if (j === k - 1 && te && dot(te, d1) > 0) d1 = te
    out.push({
      type: 'C',
      c1: { x: p0.x + d0.x * h, y: p0.y + d0.y * h },
      c2: { x: p3.x - d1.x * h, y: p3.y - d1.y * h },
      to: p3,
    })
  }
}

function emitFree(out: PathSegment[], pts: Point[], a: number, b: number, s: Join, e: Join, opts: PrimitiveOptions): void {
  const points = [s.point, ...pts.slice(a + 1, b), e.point]
  if (points.length <= 2) {
    out.push({ type: 'L', to: e.point })
    return
  }
  const pinned = points.map((_, i) => i === 0 || i === points.length - 1)
  let line: Polyline = { points, pinned }
  if (opts.presmooth) line = taubinSmooth(line, opts.presmooth, false)
  const corners = detectCorners(line, false, opts.cornerAngle, 2, 2, false)
  const pts2 = line.points.map((p) => ({ ...p }))
  const pin = [...line.pinned]
  for (const c of corners) {
    pin[c.index] = true
    pts2[c.index] = c.point
  }
  const smoothed = taubinSmooth({ points: pts2, pinned: pin }, Math.round(opts.smoothing * 2), false)
  const fitted = fitBezierPath(
    smoothed.points,
    false,
    corners.map((c) => c.index),
    opts.curveTolerance,
    [],
    { start: s.tangent, end: e.tangent },
  )
  if (!fitted) {
    out.push({ type: 'L', to: e.point })
    return
  }
  // Near-straight pieces come back as lines; at a smooth join they must keep the shared tangent.
  const segs = fitted.segments
  const keepTangent = (j: number, ts: Point | null, te: Point | null): void => {
    const seg = segs[j]
    if (seg.type !== 'L') return
    const from = j === 0 ? s.point : segs[j - 1].to
    const third = dist(from, seg.to) / 3
    const chord = unit(sub(seg.to, from))
    const d0 = ts ?? chord
    const d1 = te ?? chord
    segs[j] = { type: 'C', c1: { x: from.x + d0.x * third, y: from.y + d0.y * third }, c2: { x: seg.to.x - d1.x * third, y: seg.to.y - d1.y * third }, to: seg.to }
  }
  const last = segs.length - 1
  if (s.tangent || (last === 0 && e.tangent)) keepTangent(0, s.tangent, last === 0 ? e.tangent : null)
  if (last > 0 && e.tangent) keepTangent(last, null, e.tangent)
  out.push(...segs)
}

function circlePath(c: Circle): SubPath {
  const segs: PathSegment[] = []
  const h = KAPPA_QUARTER * c.r
  for (let j = 0; j < 4; j++) {
    const a0 = (j * Math.PI) / 2
    const a1 = ((j + 1) * Math.PI) / 2
    const p0 = { x: c.cx + c.r * Math.cos(a0), y: c.cy + c.r * Math.sin(a0) }
    const p3 = { x: c.cx + c.r * Math.cos(a1), y: c.cy + c.r * Math.sin(a1) }
    segs.push({
      type: 'C',
      c1: { x: p0.x - Math.sin(a0) * h, y: p0.y + Math.cos(a0) * h },
      c2: { x: p3.x + Math.sin(a1) * h, y: p3.y - Math.cos(a1) * h },
      to: p3,
    })
  }
  return { start: { x: c.cx + c.r, y: c.cy }, segments: segs, closed: true }
}

/** A closed loop that is an ellipse within tolerance everywhere, as an exact ellipse path. */
function wholeEllipse(pts: Point[], opts: PrimitiveOptions): SubPath | null {
  const e = fitEllipse(pts)
  if (!e || Math.min(e.a, e.b) < opts.minRadius || Math.max(e.a, e.b) > MAX_ELLIPSE_RATIO * Math.min(e.a, e.b)) return null
  for (const p of pts) if (ellipseDistance(e, p) > opts.tolerance) return null
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length]
    area += pts[i].x * q.y - q.x * pts[i].y
  }
  return ellipsePath(e, area > 0)
}

/** Index of the sharpest turn, a good seam for a closed polyline. */
function sharpestIndex(pts: Point[], span: number): number {
  const n = pts.length
  let best = 0
  let bestDot = Infinity
  for (let i = 0; i < n; i++) {
    const a = unit(sub(pts[i], pts[(i - span + n) % n]))
    const b = unit(sub(pts[(i + span) % n], pts[i]))
    const d = dot(a, b)
    if (d < bestDot) {
      bestDot = d
      best = i
    }
  }
  return best
}

/**
 * Converts a resampled polyline into a path built from lines, arcs and free curves.
 * Returns null when no primitive was found, so the caller can use the plain curve fit.
 */
export function fitPrimitives(line: Polyline, closed: boolean, opts: PrimitiveOptions, counts?: PrimitiveCounts): SubPath | null {
  const n = line.points.length
  if (n < 4 || (!opts.lines && !opts.arcs)) return null
  // Soft pins (centerline junctions) do not constrain the geometry: edges and arcs run straight
  // through them, and the strokes that end there are snapped onto the result afterwards.
  const pinnedIdx = opts.pinnedAreCorners ? line.pinned.flatMap((p, i) => (p && (closed || (i > 0 && i < n - 1)) ? [i] : [])) : []

  if (closed && opts.arcs && pinnedIdx.length === 0) {
    const whole = arcFits(line.points, 0, n - 1, opts.tolerance)
    if (whole && Math.abs(whole.sweep) > 1.9 * Math.PI && whole.circle.r >= opts.minRadius) {
      const c = refineCircle(line.points, 0, n - 1, whole.circle)
      let worst = 0
      for (const p of line.points) worst = Math.max(worst, Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r))
      if (worst <= opts.tolerance) {
        if (counts) counts.circles++
        const path = circlePath(c)
        return whole.sweep < 0 ? reversePath(path) : path
      }
    }
    const ellipse = wholeEllipse(line.points, opts)
    if (ellipse) {
      if (counts) counts.ellipses++
      return ellipse
    }
  }

  // Working array: open, with the seam duplicated for closed paths.
  let pts: Point[] = line.points
  let fixedW: number[] = pinnedIdx
  let cum = cumulative(pts)
  let bounds: number[] = []
  let pieces: Piece[] = []
  const build = (start: number): void => {
    if (closed) {
      pts = []
      for (let i = 0; i <= n; i++) pts.push(line.points[(start + i) % n])
      fixedW = pinnedIdx.map((p) => (p - start + n) % n).filter((p) => p > 0)
      if (pinnedIdx.length > 0) fixedW.push(n)
    }
    cum = cumulative(pts)
    bounds = [0, ...fixedW.filter((p) => p > 0 && p < pts.length - 1), pts.length - 1]
    pieces = []
    for (let k = 0; k < bounds.length - 1; k++) pieces.push(...segmentSection(pts, cum, bounds[k], bounds[k + 1], opts))
  }
  const firstStart = closed ? (pinnedIdx.length > 0 ? pinnedIdx[0] : sharpestIndex(line.points, 3)) : 0
  build(firstStart)
  if (closed && pinnedIdx.length === 0) {
    // Re-cut the loop in the middle of its longest edge, so every corner (and fillet) lies away
    // from the seam; the two halves are merged again on output. Without a long edge, cut at the
    // sharpest line–line corner so no edge straddles the seam.
    let longest = -1
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k]
      if (p.kind === 'line' && cum[p.b] - cum[p.a] >= 4 * opts.minLength && (longest < 0 || cum[p.b] - cum[p.a] > cum[pieces[longest].b] - cum[pieces[longest].a])) longest = k
    }
    let bestTurn = POLYGON_TURN
    let seam = longest >= 0 ? Math.round((pieces[longest].a + pieces[longest].b) / 2) : -1
    for (let k = 0; longest < 0 && k + 1 < pieces.length; k++) {
      const x = pieces[k]
      const y = pieces[k + 1]
      if (x.kind !== 'line' || y.kind !== 'line') continue
      const t = turnAngle({ x: x.fit.dx, y: x.fit.dy }, { x: y.fit.dx, y: y.fit.dy })
      if (t > bestTurn) {
        bestTurn = t
        seam = x.b
      }
    }
    if (seam > 0) build((firstStart + seam) % n)
  }
  const m = pts.length

  const fixed = new Set(bounds.filter((_, k) => (k > 0 && k < bounds.length - 1) || (closed && pinnedIdx.length > 0)))
  if (!closed) {
    fixed.add(0)
    fixed.add(m - 1)
  }
  const reach = opts.maxGap
  const linesOnly = { ...opts, arcs: false }
  pieces = demoteFloatingArcs(pieces, pts, closed, fixed, opts.maxGap, cum, (a, b) => segmentSection(pts, cum, a, b, linesOnly))
  pieces = mergeCollinear(pieces, pts, fixed, opts.tolerance, opts.endTrim)
  pieces = refineLineBoundaries(pieces, pts, fixed, opts.endTrim)
  pieces = demoteBentLines(pieces, pts, closed, fixed, opts, cum)
  pieces = demoteFlatLines(pieces, pts, closed, fixed, cum, opts)
  pieces = demoteFloatingArcs(pieces, pts, closed, fixed, opts.maxGap, cum)
  pieces = absorbGaps(pieces, pts, fixed, opts, cum, closed)
  for (let before = -1; before !== pieces.length; ) {
    before = pieces.length
    pieces = mergeAcrossBumps(pieces, pts, fixed, opts, cum)
  }
  pieces = pieces.map((p) => (p.kind === 'line' ? { ...p, fit: snapToAxis(p.fit, pts, p.a, p.b, opts.tolerance) } : p))
  pieces = fitCorners(pieces, pts, fixed, opts, cum)
  if (!pieces.some((p) => p.kind !== 'free')) return null

  const hard = opts.pinnedAreCorners
  const joins: Join[] = []
  for (let k = 0; k < pieces.length; k++) {
    const x = pieces[k]
    const y = pieces[k + 1] ?? (closed ? pieces[0] : null)
    if (!y) break
    const idx = x.b
    const atSeam = k === pieces.length - 1
    const fixedIdx = fixed.has(idx) && !atSeam ? idx : atSeam && fixed.has(m - 1) ? m - 1 : null
    const join = computeJoin(x, y, pts, fixedIdx, hard, reach, opts.tolerance)
    joins.push(join)
    if (counts && !join.tangent && x.kind !== 'free' && y.kind !== 'free') (counts.corners ??= []).push({ ...join.point })
  }

  // joins[k] is between pieces[k] and pieces[k+1]; for closed paths the last wraps to the first.
  const startJoin: Join = closed ? joins[pieces.length - 1] : { point: project(pieces[0], pts[0]), tangent: null }
  const endJoinOpen: Join = { point: project(pieces[pieces.length - 1], pts[m - 1]), tangent: null }
  if (!closed && pieces[0].kind === 'free') startJoin.point = pts[0]
  if (!closed && pieces[pieces.length - 1].kind === 'free') endJoinOpen.point = pts[m - 1]

  const segments: PathSegment[] = []
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k]
    const s = k === 0 ? startJoin : joins[k - 1]
    const e = k === pieces.length - 1 ? (closed ? joins[pieces.length - 1] : endJoinOpen) : joins[k]
    if (p.kind === 'line') {
      segments.push({ type: 'L', to: e.point })
      if (counts) counts.lines++
    } else if (p.kind === 'arc') {
      emitArc(segments, p.fit, p.dir, s.point, e.point, s.tangent, e.tangent)
      if (counts) counts.arcs++
    } else {
      emitFree(segments, pts, p.a, p.b, s, e, opts)
      if (counts) counts.free = (counts.free ?? 0) + 1
    }
  }
  const path: SubPath = { start: { ...startJoin.point }, segments, closed }
  const merged = mergeSeamLines(path, opts.tolerance)
  if (merged !== path && counts) counts.lines--
  return merged
}

/** A closed path that starts in the middle of a straight edge: restart it at that edge's end. */
function mergeSeamLines(path: SubPath, tol: number): SubPath {
  const segs = path.segments
  const n = segs.length
  if (!path.closed || n < 3 || segs[0].type !== 'L' || segs[n - 1].type !== 'L') return path
  const from = segs[n - 2].to
  const a = sub(path.start, from)
  const b = sub(segs[0].to, path.start)
  if (dot(a, b) <= 0) return path
  // Collinear by angle, or (for a short stub) by the seam point's offset from the joint line.
  const chord = sub(segs[0].to, from)
  const offset = Math.abs(cross(unit(chord), a))
  if (Math.abs(cross(unit(a), unit(b))) > Math.sin(LINE_CORNER_TURN) && offset > tol) return path
  return { start: { ...segs[0].to }, segments: [...segs.slice(1, n - 1), { type: 'L', to: { ...segs[0].to } }], closed: true }
}

function reversePath(path: SubPath): SubPath {
  const nodes = [path.start, ...path.segments.map((s) => s.to)]
  const segs: PathSegment[] = []
  for (let k = path.segments.length - 1; k >= 0; k--) {
    const s = path.segments[k]
    const to = nodes[k]
    segs.push(s.type === 'L' ? { type: 'L', to } : { type: 'C', c1: s.c2, c2: s.c1, to })
  }
  return { start: nodes[nodes.length - 1], segments: segs, closed: path.closed }
}
