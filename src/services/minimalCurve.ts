import type { PathSegment, Point, SubPath } from '../types/vectorTrace'

/**
 * Fewest-node curve fitting, the way a person draws a shape with a pen tool: as few nodes as
 * possible, each span between two nodes a straight line, a circular arc, or (only when neither
 * fits) a free cubic, staying within `tolerance` of the data and on the ink.
 *
 * Candidate nodes lie every `step` samples. A dynamic programme finds the chain with the fewest
 * spans; free cubics cost a little more than lines and arcs, and among equally short chains the
 * one hugging the data best wins, which moves nodes to where a side turns into a corner.
 * Slightly bent joins are then made tangent. Closed paths are solved twice, the second time
 * starting from a node of the first solution, so the seam never adds a node of its own.
 */
export interface InkTest {
  /** Ink depth (distance to the background) at a point. */
  depth: (p: Point) => number
  /** Every point of an accepted span must be at least this deep in the ink. */
  minDepth: number
  /** Open paths: ink is not required this close to the two ends (stroke tips). */
  endClearance: number
}

/**
 * `corners` are sharp corners already established from the ink; each gets a node of its own,
 * placed exactly on the corner, and no span may round it off.
 */
export function fitMinimalPath(points: Point[], closed: boolean, tolerance: number, step: number, tangentSpan: number, ink?: InkTest, corners: Point[] = []): SubPath | null {
  const n = points.length
  if (n < 4) return null
  const ctx: Ctx = { tol: tolerance, step, span: tangentSpan, ink, ends: closed ? [] : [points[0], points[n - 1]] }
  const pts = points.map((p) => ({ ...p }))
  const forced = new Set<number>()
  for (const c of corners) {
    let best = -1
    let bestD = 2 * tolerance + 2
    for (let i = 0; i < n; i++) {
      const dd = Math.hypot(pts[i].x - c.x, pts[i].y - c.y)
      if (dd < bestD) {
        bestD = dd
        best = i
      }
    }
    if (best < 0 || (!closed && (best === 0 || best === n - 1))) continue
    pts[best] = { ...c }
    forced.add(best)
  }
  if (!closed) return solve(pts, false, ctx, forced)
  const seam = forced.size > 0 ? Math.min(...forced) : sharpestIndex(pts, tangentSpan)
  const shifted = new Set([...forced].map((i) => (i - seam + n) % n))
  return solve(rotate(pts, seam), true, ctx, shifted, forced.size === 0)
}

interface Ctx {
  tol: number
  step: number
  span: number
  ink?: InkTest
  ends: Point[]
}

/** Whether a span stays inside the stroke (a person checks the curve against the ink). */
function onInk(B: Bezier, ctx: Ctx): boolean {
  const ink = ctx.ink
  if (!ink) return true
  const len = Math.hypot(B[1].x - B[0].x, B[1].y - B[0].y) + Math.hypot(B[2].x - B[1].x, B[2].y - B[1].y) + Math.hypot(B[3].x - B[2].x, B[3].y - B[2].y)
  const n = Math.max(4, Math.ceil(len))
  for (let i = 0; i <= n; i++) {
    const q = bez(B, i / n)
    if (ctx.ends.some((e) => Math.hypot(q.x - e.x, q.y - e.y) < ink.endClearance)) continue
    if (ink.depth(q) < ink.minDepth) return false
  }
  return true
}

function rotate(points: Point[], k: number): Point[] {
  return [...points.slice(k), ...points.slice(0, k)]
}

function sharpestIndex(points: Point[], span: number): number {
  const n = points.length
  let best = 0
  let bestTurn = -1
  for (let i = 0; i < n; i++) {
    const a = points[(i - span + n) % n]
    const b = points[i]
    const c = points[(i + span) % n]
    const t = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)))
    if (t > bestTurn) {
      bestTurn = t
      best = i
    }
  }
  return best
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y
const unit = (a: Point): Point => {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

type Bezier = [Point, Point, Point, Point]
const FREE_COST = 1.25
const FREE_CORNER_COST = 1.4
const MAX_ARC_SWEEP = (170 * Math.PI) / 180
const SMOOTH_JOIN = (25 * Math.PI) / 180
/** Among chains with equally many nodes, the one hugging the data best wins (nodes move to the transitions). */
const FIT_WEIGHT = 0.08
/** Bounds the search: candidate nodes per path, and candidates one span may cover. */
const MAX_CANDIDATES = 120
const MAX_SPAN = 60

function bez(b: Bezier, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * b[0].x + 3 * u * u * t * b[1].x + 3 * u * t * t * b[2].x + t * t * t * b[3].x,
    y: u * u * u * b[0].y + 3 * u * u * t * b[1].y + 3 * u * t * t * b[2].y + t * t * t * b[3].y,
  }
}

/** Least-squares cubic with fixed end tangents (Schneider), refined by Newton reparametrisation. */
function fitSpan(d: Point[], a: number, b: number, t1: Point, t2: Point, tol: number): { bez: Bezier; err: number; rms: number } {
  const p0 = d[a]
  const p3 = d[b]
  const u: number[] = [0]
  for (let i = a + 1; i <= b; i++) u.push(u[u.length - 1] + Math.hypot(d[i].x - d[i - 1].x, d[i].y - d[i - 1].y))
  const total = u[u.length - 1] || 1
  for (let i = 0; i < u.length; i++) u[i] /= total
  const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y)
  let best: { bez: Bezier; err: number; rms: number } | null = null
  for (let iter = 0; iter < 4; iter++) {
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
      const A1 = { x: t1.x * b1, y: t1.y * b1 }
      const A2 = { x: t2.x * b2, y: t2.y * b2 }
      c00 += dot(A1, A1)
      c01 += dot(A1, A2)
      c11 += dot(A2, A2)
      const q = d[a + i]
      const tmp = { x: q.x - p0.x * (b0 + b1) - p3.x * (b2 + b3), y: q.y - p0.y * (b0 + b1) - p3.y * (b2 + b3) }
      x0 += dot(A1, tmp)
      x1 += dot(A2, tmp)
    }
    const det = c00 * c11 - c01 * c01
    let al = chord / 3
    let ar = chord / 3
    if (Math.abs(det) > 1e-12) {
      al = (x0 * c11 - x1 * c01) / det
      ar = (c00 * x1 - c01 * x0) / det
    }
    if (!(al > 1e-6 * chord) || !(ar > 1e-6 * chord) || al > 3 * chord || ar > 3 * chord) {
      al = chord / 3
      ar = chord / 3
    }
    const B: Bezier = [p0, { x: p0.x + t1.x * al, y: p0.y + t1.y * al }, { x: p3.x + t2.x * ar, y: p3.y + t2.y * ar }, p3]
    let err = 0
    let sq = 0
    for (let i = 1; i < u.length - 1; i++) {
      const q = bez(B, u[i])
      const e = Math.hypot(q.x - d[a + i].x, q.y - d[a + i].y)
      err = Math.max(err, e)
      sq += e * e
    }
    if (!best || err < best.err) best = { bez: B, err, rms: Math.sqrt(sq / Math.max(1, u.length - 2)) }
    if (err <= tol || err > 4 * tol) break
    // Newton step on each parameter.
    for (let i = 1; i < u.length - 1; i++) {
      const t = u[i]
      const mt = 1 - t
      const q = bez(B, t)
      const q1 = {
        x: 3 * (mt * mt * (B[1].x - B[0].x) + 2 * mt * t * (B[2].x - B[1].x) + t * t * (B[3].x - B[2].x)),
        y: 3 * (mt * mt * (B[1].y - B[0].y) + 2 * mt * t * (B[2].y - B[1].y) + t * t * (B[3].y - B[2].y)),
      }
      const q2 = {
        x: 6 * (mt * (B[2].x - 2 * B[1].x + B[0].x) + t * (B[3].x - 2 * B[2].x + B[1].x)),
        y: 6 * (mt * (B[2].y - 2 * B[1].y + B[0].y) + t * (B[3].y - 2 * B[2].y + B[1].y)),
      }
      const diff = sub(q, d[a + i])
      const den = dot(q1, q1) + dot(diff, q2)
      if (Math.abs(den) > 1e-12) u[i] = Math.min(1, Math.max(0, t - dot(diff, q1) / den))
    }
  }
  return best!
}

/** Tangent through sample i from neighbours `span` away (one-sided at open ends). */
function smoothTangent(d: Point[], i: number, span: number, closed: boolean): Point {
  const n = closed ? d.length - 1 : d.length
  const at = (k: number): Point => (closed ? d[((k % n) + n) % n] : d[Math.max(0, Math.min(n - 1, k))])
  return unit(sub(at(i + span), at(i - span)))
}

/** Direction of the data leaving sample a toward b, from a line fit over the first `span` samples. */
function sideTangent(d: Point[], a: number, b: number, span: number): Point {
  const s = Math.sign(b - a)
  const k = Math.min(Math.abs(b - a), span)
  let mx = 0
  let my = 0
  for (let j = 0; j <= k; j++) {
    mx += d[a + s * j].x
    my += d[a + s * j].y
  }
  mx /= k + 1
  my /= k + 1
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let j = 0; j <= k; j++) {
    const u = d[a + s * j].x - mx
    const v = d[a + s * j].y - my
    sxx += u * u
    sxy += u * v
    syy += v * v
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const t = { x: Math.cos(ang), y: Math.sin(ang) }
  const along = sub(d[a + s * k], d[a])
  return dot(t, along) < 0 ? { x: -t.x, y: -t.y } : t
}

/** Max distance of samples a..b from the chord between them, or Infinity if they run past its ends. */
function chordDeviation(d: Point[], a: number, b: number): number {
  const p0 = d[a]
  const v = sub(d[b], p0)
  const L2 = dot(v, v)
  if (L2 < 1e-12) return Infinity
  const L = Math.sqrt(L2)
  let m = 0
  for (let i = a + 1; i < b; i++) {
    const w = sub(d[i], p0)
    const t = dot(w, v) / L2
    if (t < -0.05 || t > 1.05) return Infinity
    m = Math.max(m, Math.abs(w.x * v.y - w.y * v.x) / L)
  }
  return m
}

/** Circular arc through samples a, mid and b as one cubic, if every sample lies within tol of it. */
function arcSpan(d: Point[], a: number, b: number, tol: number): { bez: Bezier; err: number; rms: number } | null {
  const p0 = d[a]
  const p3 = d[b]
  const pm = d[(a + b) >> 1]
  const ax = p0.x - pm.x
  const ay = p0.y - pm.y
  const bx = p3.x - pm.x
  const by = p3.y - pm.y
  const den = 2 * (ax * by - ay * bx)
  if (Math.abs(den) < 1e-9) return null
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c = { x: pm.x + (by * a2 - ay * b2) / den, y: pm.y + (ax * b2 - bx * a2) / den }
  const R = Math.hypot(p0.x - c.x, p0.y - c.y)
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x)
  const am = Math.atan2(pm.y - c.y, pm.x - c.x)
  const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x))
  const half = wrap(am - a0)
  const sweep = wrap(Math.atan2(p3.y - c.y, p3.x - c.x) - am) + half
  if (Math.abs(sweep) > MAX_ARC_SWEEP || Math.sign(sweep) !== Math.sign(half)) return null
  let err = 0
  let sq = 0
  let prev = 0
  for (let i = a + 1; i < b; i++) {
    const e = Math.abs(Math.hypot(d[i].x - c.x, d[i].y - c.y) - R)
    if (e > tol) return null
    // Samples must advance along the arc.
    const t = wrap(Math.atan2(d[i].y - c.y, d[i].x - c.x) - a0) * Math.sign(sweep)
    if (t < prev - 0.2 || t > Math.abs(sweep) + 0.05) return null
    prev = Math.max(prev, t)
    err = Math.max(err, e)
    sq += e * e
  }
  const k = (4 / 3) * Math.tan(sweep / 4) * R
  const t0 = { x: -(p0.y - c.y) / R, y: (p0.x - c.x) / R }
  const t3 = { x: -(p3.y - c.y) / R, y: (p3.x - c.x) / R }
  const bez: Bezier = [p0, { x: p0.x + t0.x * k, y: p0.y + t0.y * k }, { x: p3.x - t3.x * k, y: p3.y - t3.y * k }, p3]
  return { bez, err, rms: Math.sqrt(sq / Math.max(1, b - a - 1)) }
}

function solve(points: Point[], closed: boolean, ctx: Ctx, forced: Set<number>, reseam = false): SubPath | null {
  const { tol, step, span } = ctx
  const d = closed ? [...points, points[0]] : points
  const last = d.length - 1
  const cand: number[] = []
  const stride = Math.max(step, Math.ceil(last / MAX_CANDIDATES))
  for (let i = 0; i < last; i += stride) {
    if (![...forced].some((f) => f !== i && Math.abs(f - i) < stride / 2)) cand.push(i)
  }
  for (const f of forced) if (f > 0 && f < last && !cand.includes(f)) cand.push(f)
  cand.sort((x, y) => x - y)
  if (cand[cand.length - 1] !== last) {
    if (last - cand[cand.length - 1] < stride / 2 && cand.length > 1 && !forced.has(cand[cand.length - 1])) cand[cand.length - 1] = last
    else cand.push(last)
  }
  const K = cand.length
  const cost = new Float64Array(K).fill(Infinity)
  const from = new Int32Array(K).fill(-1)
  const spanOf: (Bezier | null)[] = new Array(K).fill(null)
  const lineOf: boolean[] = new Array(K).fill(false)
  cost[0] = 0
  for (let i = 0; i < K - 1; i++) {
    if (!Number.isFinite(cost[i])) continue
    let misses = 0
    for (let j = i + 1; j < K && misses < 3 && j - i <= MAX_SPAN; j++) {
      if (closed && i === 0 && j === K - 1) break
      const a = cand[i]
      const b = cand[j]
      // Candidate shapes for this span, cheapest first: straight line, circular arc, free cubic.
      const options: { bez: Bezier; rms: number; cost: number; line: boolean }[] = []
      const dev = chordDeviation(d, a, b)
      if (dev <= tol) {
        const v = sub(d[b], d[a])
        options.push({ bez: [d[a], { x: d[a].x + v.x / 3, y: d[a].y + v.y / 3 }, { x: d[b].x - v.x / 3, y: d[b].y - v.y / 3 }, d[b]], rms: dev / 2, cost: 1, line: true })
      }
      const arc = arcSpan(d, a, b, tol)
      if (arc) options.push({ bez: arc.bez, rms: arc.rms, cost: 1, line: false })
      let valid = options.filter((o) => onInk(o.bez, ctx))
      if (valid.length === 0) {
        const smooth = fitSpan(d, a, b, smoothTangent(d, a, span, closed), negate(smoothTangent(d, b, span, closed)), tol)
        if (smooth.err <= tol) valid.push({ bez: smooth.bez, rms: smooth.rms, cost: FREE_COST, line: false })
        const corner = fitSpan(d, a, b, sideTangent(d, a, b, span), sideTangent(d, b, a, span), tol)
        if (corner.err <= tol) valid.push({ bez: corner.bez, rms: corner.rms, cost: FREE_CORNER_COST, line: false })
        valid = valid.filter((o) => onInk(o.bez, ctx))
      }
      let fitted = false
      for (const o of valid) {
        fitted = true
        const c = cost[i] + o.cost + FIT_WEIGHT * (o.rms / tol)
        if (c < cost[j]) {
          cost[j] = c
          from[j] = i
          spanOf[j] = o.bez
          lineOf[j] = o.line
        }
      }
      misses = fitted ? 0 : misses + 1
      if (forced.has(b)) break
    }
  }
  if (!Number.isFinite(cost[K - 1])) return null
  const chain: number[] = []
  for (let k = K - 1; k > 0; k = from[k]) {
    if (from[k] < 0) return null
    chain.push(k)
  }
  chain.reverse()
  if (closed && reseam && chain.length > 1) {
    // Restart from the first node so the seam sits on a natural node.
    const again = solve(rotate(points, cand[chain[0]]), true, ctx, forced, false)
    if (again && again.segments.length <= chain.length) return again
  }
  const segs = chain.map((k) => ({ bez: spanOf[k]!.map((p) => ({ ...p })) as Bezier, line: lineOf[k], corner: forced.has(cand[k]) || (closed && k === K - 1 && forced.has(0)) }))
  smoothJoins(segs, closed, ctx)
  return { start: { ...d[0] }, segments: segs.map((s) => (s.line ? { type: 'L', to: s.bez[3] } : toSegment(s.bez, tol))), closed }
}

const negate = (p: Point): Point => ({ x: -p.x, y: -p.y })

/**
 * Joins that bend only slightly are made tangent: a curve meeting a line takes the line's
 * direction, two curves share their mean direction. Real corners are left alone.
 */
function smoothJoins(segs: { bez: Bezier; line: boolean; corner: boolean }[], closed: boolean, ctx: Ctx): void {
  const n = segs.length
  for (let k = 0; k < n; k++) {
    if (!closed && k === n - 1) break
    const x = segs[k]
    const y = segs[(k + 1) % n]
    if (x === y) break
    if (x.corner) continue
    const node = x.bez[3]
    const tin = unit(x.line ? sub(x.bez[3], x.bez[0]) : sub(x.bez[3], x.bez[2]))
    const tout = unit(y.line ? sub(y.bez[3], y.bez[0]) : sub(y.bez[1], y.bez[0]))
    if (dot(tin, tout) < Math.cos(SMOOTH_JOIN)) continue
    if (x.line && y.line) continue
    const t = x.line ? tin : y.line ? tout : unit({ x: tin.x + tout.x, y: tin.y + tout.y })
    const keep = [x.bez[2], y.bez[1]]
    if (!x.line) {
      const h = Math.hypot(x.bez[3].x - x.bez[2].x, x.bez[3].y - x.bez[2].y)
      x.bez[2] = { x: node.x - t.x * h, y: node.y - t.y * h }
    }
    if (!y.line) {
      const h = Math.hypot(y.bez[1].x - y.bez[0].x, y.bez[1].y - y.bez[0].y)
      y.bez[1] = { x: node.x + t.x * h, y: node.y + t.y * h }
    }
    if (!onInk(x.bez, ctx) || !onInk(y.bez, ctx)) {
      x.bez[2] = keep[0]
      y.bez[1] = keep[1]
    }
  }
}

function toSegment(b: Bezier, tol: number): PathSegment {
  const [p0, c1, c2, p3] = b
  const L = Math.hypot(p3.x - p0.x, p3.y - p0.y)
  if (L < 1e-9) return { type: 'L', to: p3 }
  const nx = -(p3.y - p0.y) / L
  const ny = (p3.x - p0.x) / L
  const dev = Math.max(Math.abs((c1.x - p0.x) * nx + (c1.y - p0.y) * ny), Math.abs((c2.x - p0.x) * nx + (c2.y - p0.y) * ny))
  return 0.75 * dev <= 0.5 * tol ? { type: 'L', to: p3 } : { type: 'C', c1, c2, to: p3 }
}
