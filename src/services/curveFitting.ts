import type { PathSegment, Point, SubPath } from '../types/vectorTrace'

export interface Polyline {
  points: Point[]
  /** Pinned points are not moved by smoothing and are always considered corners. */
  pinned: boolean[]
}

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const scale = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s })
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y
const len = (a: Point): number => Math.hypot(a.x, a.y)
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
function normalize(a: Point): Point {
  const l = len(a)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

/**
 * Converts an axis-aligned pixel staircase (closed, corner vertices only) into a
 * polyline through edge midpoints, which removes jaggies on diagonals and curves.
 * Corners between two runs of at least `cornerRun` pixels are kept exactly and pinned.
 */
export function staircaseToPolyline(corners: Point[], cornerRun = 4): Polyline {
  const n = corners.length
  const points: Point[] = []
  const pinned: boolean[] = []
  const segLen = (i: number): number => dist(corners[i], corners[(i + 1) % n])
  for (let i = 0; i < n; i++) {
    const prevLen = segLen((i + n - 1) % n)
    const curLen = segLen(i)
    if (prevLen >= cornerRun && curLen >= cornerRun) {
      points.push({ ...corners[i] })
      pinned.push(true)
    }
    const a = corners[i]
    const b = corners[(i + 1) % n]
    points.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    pinned.push(false)
  }
  return { points, pinned }
}

/** Resamples to roughly uniform spacing while keeping pinned points (and open endpoints) exactly. */
export function resample(line: Polyline, spacing: number, closed: boolean): Polyline {
  const { points, pinned } = line
  const n = points.length
  if (n < 2 || spacing <= 0) return { points: points.map((p) => ({ ...p })), pinned: [...pinned] }

  const anchors: number[] = []
  for (let i = 0; i < n; i++) if (pinned[i]) anchors.push(i)
  if (!closed) {
    if (anchors[0] !== 0) anchors.unshift(0)
    if (anchors[anchors.length - 1] !== n - 1) anchors.push(n - 1)
  } else if (anchors.length === 0) {
    anchors.push(0)
  }

  const outPts: Point[] = []
  const outPin: boolean[] = []
  const pieceCount = closed ? anchors.length : anchors.length - 1
  for (let k = 0; k < pieceCount; k++) {
    const a = anchors[k]
    const b = closed ? anchors[(k + 1) % anchors.length] : anchors[k + 1]
    const idx: number[] = []
    let i = a
    idx.push(i)
    do {
      i = (i + 1) % n
      idx.push(i)
    } while (i !== b)

    let total = 0
    for (let j = 1; j < idx.length; j++) total += dist(points[idx[j - 1]], points[idx[j]])
    outPts.push({ ...points[a] })
    outPin.push(pinned[a] || (!closed && a === 0))
    const steps = Math.max(1, Math.round(total / spacing))
    if (steps > 1 && total > 0) {
      const step = total / steps
      let target = step
      let acc = 0
      for (let j = 1; j < idx.length; j++) {
        const p = points[idx[j - 1]]
        const q = points[idx[j]]
        const d = dist(p, q)
        while (d > 0 && acc + d >= target - 1e-9 && target < total - step * 0.5) {
          const t = (target - acc) / d
          outPts.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
          outPin.push(false)
          target += step
        }
        acc += d
      }
    }
  }
  if (!closed) {
    outPts.push({ ...points[n - 1] })
    outPin.push(true)
  }
  return { points: outPts, pinned: outPin }
}

/** Taubin λ/μ smoothing: removes noise without the shrinkage of plain Laplacian smoothing. */
export function taubinSmooth(line: Polyline, iterations: number, closed: boolean): Polyline {
  let pts = line.points.map((p) => ({ ...p }))
  const { pinned } = line
  const n = pts.length
  if (n < 3 || iterations <= 0) return { points: pts, pinned: [...pinned] }
  const lambda = 0.5
  const mu = -0.53
  for (let it = 0; it < iterations; it++) {
    for (const factor of [lambda, mu]) {
      const next = pts.map((p) => ({ ...p }))
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue
        if (!closed && (i === 0 || i === n - 1)) continue
        const prev = pts[(i + n - 1) % n]
        const nxt = pts[(i + 1) % n]
        const p = pts[i]
        next[i] = {
          x: p.x + factor * ((prev.x + nxt.x) / 2 - p.x),
          y: p.y + factor * ((prev.y + nxt.y) / 2 - p.y),
        }
      }
      pts = next
    }
  }
  return { points: pts, pinned: [...pinned] }
}

export interface Corner {
  index: number
  /** Refined vertex position (intersection of the two arms). */
  point: Point
}

const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x

function intersectLines(p: Point, r: Point, q: Point, s: Point): Point | null {
  const d = cross(r, s)
  if (Math.abs(d) < 1e-9) return null
  const t = cross(sub(q, p), s) / d
  return add(p, scale(r, t))
}

/**
 * Finds corners by comparing the direction of the two "arms" on either side of each point,
 * skipping `gap` samples next to it. Skipping the immediate neighbourhood makes the measure
 * insensitive to the ~1px chamfer that pixel staircases leave at sharp corners.
 * Each corner is moved to the intersection of its arms, restoring the sharp vertex.
 */
export function detectCorners(
  line: Polyline,
  closed: boolean,
  cornerAngleDeg: number,
  gap = 2,
  arm = 2,
  pinnedAreCorners = true,
): Corner[] {
  const { points, pinned } = line
  const n = points.length
  const span = gap + arm
  const isPinnedCorner = (i: number): boolean => pinnedAreCorners && pinned[i] && (closed || (i !== 0 && i !== n - 1))
  const pinnedCorners = (): Corner[] =>
    pinned.flatMap((_, i) => (isPinnedCorner(i) ? [{ index: i, point: { ...points[i] } }] : []))
  if (n < 2 * span + 2) return pinnedCorners()

  const at = (i: number): Point => points[closed ? ((i % n) + n) % n : i]
  const valid = (i: number): boolean => closed || (i - span >= 0 && i + span <= n - 1)

  const angles = new Float64Array(n).fill(180)
  for (let i = 0; i < n; i++) {
    if (!valid(i)) continue
    const inDir = sub(at(i - gap), at(i - span))
    const outDir = sub(at(i + span), at(i + gap))
    const li = len(inDir)
    const lo = len(outDir)
    if (li < 1e-9 || lo < 1e-9) continue
    const c = Math.max(-1, Math.min(1, dot(inDir, outDir) / (li * lo)))
    angles[i] = 180 - (Math.acos(c) * 180) / Math.PI
  }

  const corners: Corner[] = []
  const used = new Set<number>()
  for (let i = 0; i < n; i++) {
    if (isPinnedCorner(i)) {
      if (!used.has(i)) corners.push({ index: i, point: { ...points[i] } })
      used.add(i)
      continue
    }
    if (angles[i] >= cornerAngleDeg) continue
    // Local minimum within ±span; on ties the earliest point of the run wins.
    let isMin = true
    for (let j = 1; j <= span && isMin; j++) {
      const before = closed ? (i - j + n) % n : i - j
      const after = closed ? (i + j) % n : i + j
      if (before >= 0 && angles[before] <= angles[i]) isMin = false
      if (after < n && angles[after] < angles[i]) isMin = false
    }
    if (!isMin) continue

    // Snap to the sample farthest from the chord across the corner, then to the arm intersection.
    const a = at(i - span)
    const b = at(i + span)
    const chord = sub(b, a)
    const cl = len(chord) || 1
    let best = i
    let bestDist = -1
    for (let j = i - gap; j <= i + gap; j++) {
      if (!closed && (j < 0 || j >= n)) continue
      const d = Math.abs(cross(chord, sub(at(j), a))) / cl
      if (d > bestDist) {
        bestDist = d
        best = j
      }
    }
    const idx = closed ? ((best % n) + n) % n : best
    if (used.has(idx)) continue
    used.add(idx)
    let point = { ...points[idx] }
    if (valid(best)) {
      const x = intersectLines(at(best - span), sub(at(best - gap), at(best - span)), at(best + gap), sub(at(best + span), at(best + gap)))
      const reachLimit = dist(at(best - gap), at(best))
      if (x && dist(x, point) <= reachLimit) point = x
    }
    corners.push({ index: idx, point })
  }
  return corners.sort((p, q) => p.index - q.index)
}

type Bezier = [Point, Point, Point, Point]

function bezierPoint(b: Bezier, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const c = 3 * mt * mt * t
  const d = 3 * mt * t * t
  const e = t * t * t
  return {
    x: a * b[0].x + c * b[1].x + d * b[2].x + e * b[3].x,
    y: a * b[0].y + c * b[1].y + d * b[2].y + e * b[3].y,
  }
}

function chordLengthParameterize(d: Point[], first: number, last: number): number[] {
  const u = [0]
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(d[i], d[i - 1]))
  const total = u[u.length - 1]
  return total > 0 ? u.map((v) => v / total) : u.map((_, i) => i / (u.length - 1))
}

function generateBezier(d: Point[], first: number, last: number, u: number[], tHat1: Point, tHat2: Point): Bezier {
  const p0 = d[first]
  const p3 = d[last]
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < u.length; i++) {
    const t = u[i]
    const mt = 1 - t
    const b0 = mt * mt * mt
    const b1 = 3 * mt * mt * t
    const b2 = 3 * mt * t * t
    const b3 = t * t * t
    const a1 = scale(tHat1, b1)
    const a2 = scale(tHat2, b2)
    c00 += dot(a1, a1)
    c01 += dot(a1, a2)
    c11 += dot(a2, a2)
    const tmp = sub(d[first + i], add(scale(p0, b0 + b1), scale(p3, b2 + b3)))
    x0 += dot(a1, tmp)
    x1 += dot(a2, tmp)
  }
  const det = c00 * c11 - c01 * c01
  const segLength = dist(p0, p3)
  let alphaL = 0
  let alphaR = 0
  if (Math.abs(det) > 1e-12) {
    alphaL = (x0 * c11 - x1 * c01) / det
    alphaR = (c00 * x1 - c01 * x0) / det
  }
  const eps = 1e-6 * segLength
  if (alphaL < eps || alphaR < eps || alphaL > segLength * 3 || alphaR > segLength * 3) {
    const h = segLength / 3
    return [p0, add(p0, scale(tHat1, h)), add(p3, scale(tHat2, h)), p3]
  }
  return [p0, add(p0, scale(tHat1, alphaL)), add(p3, scale(tHat2, alphaR)), p3]
}

function newtonRaphson(b: Bezier, p: Point, t: number): number {
  const q = bezierPoint(b, t)
  const mt = 1 - t
  const q1 = {
    x: 3 * (mt * mt * (b[1].x - b[0].x) + 2 * mt * t * (b[2].x - b[1].x) + t * t * (b[3].x - b[2].x)),
    y: 3 * (mt * mt * (b[1].y - b[0].y) + 2 * mt * t * (b[2].y - b[1].y) + t * t * (b[3].y - b[2].y)),
  }
  const q2 = {
    x: 6 * (mt * (b[2].x - 2 * b[1].x + b[0].x) + t * (b[3].x - 2 * b[2].x + b[1].x)),
    y: 6 * (mt * (b[2].y - 2 * b[1].y + b[0].y) + t * (b[3].y - 2 * b[2].y + b[1].y)),
  }
  const diff = sub(q, p)
  const num = dot(diff, q1)
  const den = dot(q1, q1) + dot(diff, q2)
  if (Math.abs(den) < 1e-12) return t
  return Math.min(1, Math.max(0, t - num / den))
}

function maxError(d: Point[], first: number, last: number, b: Bezier, u: number[]): { err: number; split: number } {
  let err = 0
  let split = Math.floor((first + last) / 2)
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(b, u[i - first])
    const e = (p.x - d[i].x) ** 2 + (p.y - d[i].y) ** 2
    if (e >= err) {
      err = e
      split = i
    }
  }
  return { err, split }
}

function fitCubic(d: Point[], first: number, last: number, tHat1: Point, tHat2: Point, errSq: number, out: Bezier[], depth: number): void {
  const p0 = d[first]
  const p3 = d[last]
  if (last - first === 1 || depth > 40) {
    const h = dist(p0, p3) / 3
    out.push([p0, add(p0, scale(tHat1, h)), add(p3, scale(tHat2, h)), p3])
    return
  }
  let u = chordLengthParameterize(d, first, last)
  let bez = generateBezier(d, first, last, u, tHat1, tHat2)
  let { err, split } = maxError(d, first, last, bez, u)
  if (err < errSq) {
    out.push(bez)
    return
  }
  if (err < errSq * 4) {
    for (let i = 0; i < 4; i++) {
      u = u.map((t, k) => newtonRaphson(bez, d[first + k], t))
      bez = generateBezier(d, first, last, u, tHat1, tHat2)
      ;({ err, split } = maxError(d, first, last, bez, u))
      if (err < errSq) {
        out.push(bez)
        return
      }
    }
  }
  split = Math.min(last - 1, Math.max(first + 1, split))
  const r = Math.min(2, split - first, last - split)
  let center = normalize(sub(d[split - r], d[split + r]))
  if (len(center) === 0) center = normalize(sub(d[split - 1], d[split + 1]))
  fitCubic(d, first, split, tHat1, center, errSq, out, depth + 1)
  fitCubic(d, split, last, scale(center, -1), tHat2, errSq, out, depth + 1)
}

function endTangent(d: Point[], from: number, toward: number): Point {
  const span = Math.abs(toward - from)
  const step = toward > from ? 1 : -1
  const k = Math.min(3, span)
  for (let j = k; j >= 1; j--) {
    const t = normalize(sub(d[from + step * j], d[from]))
    if (len(t) > 0) return t
  }
  return { x: 1, y: 0 }
}

function toSegment(b: Bezier, lineTol: number): PathSegment {
  const [p0, c1, c2, p3] = b
  const chord = sub(p3, p0)
  const L = len(chord)
  if (L < 1e-9) return { type: 'L', to: p3 }
  const nrm = { x: -chord.y / L, y: chord.x / L }
  const d1 = Math.abs(dot(sub(c1, p0), nrm))
  const d2 = Math.abs(dot(sub(c2, p0), nrm))
  const t1 = dot(sub(c1, p0), chord) / (L * L)
  const t2 = dot(sub(c2, p0), chord) / (L * L)
  if (0.75 * Math.max(d1, d2) <= lineTol && t1 >= -0.05 && t1 <= 1.05 && t2 >= -0.05 && t2 <= 1.05) {
    return { type: 'L', to: p3 }
  }
  return { type: 'C', c1, c2, to: p3 }
}

/** Forward tangent through point `i`, using neighbours `r` samples away (wrapping when closed). */
function centralTangent(points: Point[], i: number, closed: boolean): Point {
  const n = points.length
  for (let r = 2; r >= 1; r--) {
    const a = closed ? points[(i - r + n) % n] : points[Math.max(0, i - r)]
    const b = closed ? points[(i + r) % n] : points[Math.min(n - 1, i + r)]
    const t = normalize(sub(b, a))
    if (len(t) > 0) return t
  }
  return { x: 1, y: 0 }
}

/**
 * Fits a piecewise cubic Bézier through the polyline (Schneider's algorithm), breaking at the
 * given corner indices. `smoothBreaks` are additional split points the curve must pass through
 * with a continuous tangent (e.g. junctions). `tolerance` is the max deviation in pixels.
 */
export function fitBezierPath(
  points: Point[],
  closed: boolean,
  corners: number[],
  tolerance: number,
  smoothBreaks: number[] = [],
): SubPath | null {
  const n = points.length
  if (n < 2) return null
  const errSq = tolerance * tolerance
  const lineTol = tolerance * 0.5
  const beziers: Bezier[] = []
  const cornerSet = new Set(corners)
  const inRange = (c: number): boolean => (closed ? c >= 0 && c < n : c > 0 && c < n - 1)
  const breaks = [...new Set([...corners, ...smoothBreaks])].filter(inRange).sort((a, b) => a - b)

  // Tangents at a break: one-sided at corners, shared central tangent at smooth breaks.
  const startTangent = (d: Point[], a: number, b: number, orig: number): Point =>
    cornerSet.has(orig) || (!closed && orig === 0) ? endTangent(d, a, b) : centralTangent(points, orig, closed)
  const finishTangent = (d: Point[], b: number, a: number, orig: number): Point =>
    cornerSet.has(orig) || (!closed && orig === n - 1) ? endTangent(d, b, a) : scale(centralTangent(points, orig, closed), -1)

  if (closed) {
    if (n < 3) return null
    if (breaks.length === 0) {
      const d = [...points, points[0]]
      const t1 = normalize(sub(points[1], points[n - 1]))
      fitCubic(d, 0, n, t1, scale(t1, -1), errSq, beziers, 0)
    } else {
      const offset = breaks[0]
      const d: Point[] = []
      for (let i = 0; i <= n; i++) d.push(points[(offset + i) % n])
      const cuts = breaks.map((c) => c - offset)
      cuts.push(n)
      for (let k = 0; k < cuts.length - 1; k++) {
        const a = cuts[k]
        const b = cuts[k + 1]
        if (b <= a) continue
        fitCubic(d, a, b, startTangent(d, a, b, (offset + a) % n), finishTangent(d, b, a, (offset + b) % n), errSq, beziers, 0)
      }
    }
  } else {
    const cuts = [0, ...breaks, n - 1]
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = cuts[k]
      const b = cuts[k + 1]
      if (b <= a) continue
      fitCubic(points, a, b, startTangent(points, a, b, a), finishTangent(points, b, a, b), errSq, beziers, 0)
    }
  }
  if (beziers.length === 0) return null
  return {
    start: { ...beziers[0][0] },
    segments: beziers.map((b) => toSegment(b, lineTol)),
    closed,
  }
}

export interface CurveOptions {
  smoothing: number
  tolerance: number
  cornerAngle: number
  spacing: number
  /**
   * When true (default), pinned points are hard corners. When false they are only held in place
   * and the curve passes through them smoothly (used for centerline junctions).
   */
  pinnedAreCorners?: boolean
  /** Light smoothing iterations applied before corner detection (for jittery skeleton input). */
  presmooth?: number
}

/**
 * Full pipeline for a polyline: resample → corner detection → smoothing (corners pinned) → Bézier fit.
 * Corners are found before smoothing, otherwise smoothing would blunt them below the angle threshold.
 */
export function polylineToPath(line: Polyline, closed: boolean, opts: CurveOptions): SubPath | null {
  const pinnedAreCorners = opts.pinnedAreCorners ?? true
  let sampled = resample(line, opts.spacing, closed)
  if (opts.presmooth) sampled = taubinSmooth(sampled, opts.presmooth, closed)
  const corners = detectCorners(sampled, closed, opts.cornerAngle, 2, 2, pinnedAreCorners)
  const pinned = [...sampled.pinned]
  const points = sampled.points.map((p) => ({ ...p }))
  for (const c of corners) {
    pinned[c.index] = true
    points[c.index] = c.point
  }
  const smoothed = taubinSmooth({ points, pinned }, Math.round(opts.smoothing * 2), closed)
  const cornerIdx = corners.map((c) => c.index)
  const smoothBreaks = pinnedAreCorners ? [] : sampled.pinned.flatMap((p, i) => (p && !cornerIdx.includes(i) ? [i] : []))
  return fitBezierPath(smoothed.points, closed, cornerIdx, opts.tolerance, smoothBreaks)
}

/** Maps every coordinate of a subpath through (x*sx, y*sy). */
export function scaleSubPath(path: SubPath, sx: number, sy: number): SubPath {
  const m = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy })
  return {
    closed: path.closed,
    start: m(path.start),
    segments: path.segments.map((s) => (s.type === 'L' ? { type: 'L', to: m(s.to) } : { type: 'C', c1: m(s.c1), c2: m(s.c2), to: m(s.to) })),
  }
}
