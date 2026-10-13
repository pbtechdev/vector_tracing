import type { PathSegment, Point, SubPath } from '../types/vectorTrace'

export interface SnapStroke {
  sub: SubPath
  /** Half the stroke width, in the same units as the path. */
  radius: number
}

const CELL = 32

function evalSeg(from: Point, s: PathSegment, t: number): Point {
  if (s.type === 'L') return { x: from.x + (s.to.x - from.x) * t, y: from.y + (s.to.y - from.y) * t }
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * from.x + b * s.c1.x + c * s.c2.x + d * s.to.x, y: a * from.y + b * s.c1.y + c * s.c2.y + d * s.to.y }
}

interface SegRef {
  stroke: number
  from: Point
  seg: PathSegment
}

function nearestOnSeg(p: Point, r: SegRef): { q: Point; d: number } {
  const sq = (t: number): number => {
    const q = evalSeg(r.from, r.seg, t)
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2
  }
  if (r.seg.type === 'L') {
    const dx = r.seg.to.x - r.from.x
    const dy = r.seg.to.y - r.from.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - r.from.x) * dx + (p.y - r.from.y) * dy) / len2)) : 0
    const q = evalSeg(r.from, r.seg, t)
    return { q, d: Math.hypot(q.x - p.x, q.y - p.y) }
  }
  const N = 16
  let best = 0
  for (let i = 1; i <= N; i++) if (sq(i / N) < sq(best / N)) best = i
  let lo = Math.max(0, (best - 1) / N)
  let hi = Math.min(1, (best + 1) / N)
  for (let it = 0; it < 30; it++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (sq(m1) < sq(m2)) hi = m2
    else lo = m1
  }
  const q = evalSeg(r.from, r.seg, (lo + hi) / 2)
  return { q, d: Math.hypot(q.x - p.x, q.y - p.y) }
}

/**
 * Lands every open stroke end that stops at another stroke exactly on that stroke's fitted
 * geometry. Skeleton junctions sit slightly off the ideal edge (the medial axis bends toward a
 * branch), so once the edge is fitted straight through, the branch would otherwise end beside it.
 * An end moves only when the two inks overlap there (closer than ¾ of the summed radii); the
 * adjacent control point moves with it so the stroke keeps its direction.
 */
export function snapStrokeEnds(strokes: SnapStroke[]): number {
  const grid = new Map<string, SegRef[]>()
  const key = (cx: number, cy: number): string => `${cx},${cy}`
  strokes.forEach((s, stroke) => {
    let from = s.sub.start
    for (const seg of s.sub.segments) {
      const xs = seg.type === 'L' ? [from.x, seg.to.x] : [from.x, seg.c1.x, seg.c2.x, seg.to.x]
      const ys = seg.type === 'L' ? [from.y, seg.to.y] : [from.y, seg.c1.y, seg.c2.y, seg.to.y]
      const ref: SegRef = { stroke, from, seg }
      for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(...ys) / CELL); cy <= Math.floor(Math.max(...ys) / CELL); cy++) {
          const k = key(cx, cy)
          const list = grid.get(k)
          if (list) list.push(ref)
          else grid.set(k, [ref])
        }
      }
      from = seg.to
    }
  })

  const nearest = (p: Point, self: number, reach: number): { q: Point; d: number; stroke: number } | null => {
    let best: { q: Point; d: number; stroke: number } | null = null
    const seen = new Set<SegRef>()
    for (let cx = Math.floor((p.x - reach) / CELL); cx <= Math.floor((p.x + reach) / CELL); cx++) {
      for (let cy = Math.floor((p.y - reach) / CELL); cy <= Math.floor((p.y + reach) / CELL); cy++) {
        for (const r of grid.get(key(cx, cy)) ?? []) {
          if (r.stroke === self || seen.has(r)) continue
          seen.add(r)
          const n = nearestOnSeg(p, r)
          if (n.d <= reach && (!best || n.d < best.d)) best = { ...n, stroke: r.stroke }
        }
      }
    }
    return best
  }

  // Targets are measured on the unmoved geometry, so the result does not depend on stroke order.
  const moves: { stroke: number; atStart: boolean; to: Point }[] = []
  const maxR = strokes.reduce((m, s) => Math.max(m, s.radius), 0)
  strokes.forEach((s, i) => {
    const { sub } = s
    if (sub.closed || sub.segments.length === 0) return
    for (const atStart of [true, false]) {
      const p = atStart ? sub.start : sub.segments[sub.segments.length - 1].to
      const n = nearest(p, i, 0.75 * (s.radius + maxR))
      if (!n || n.d < 1e-3 || n.d > 0.75 * (s.radius + strokes[n.stroke].radius)) continue
      moves.push({ stroke: i, atStart, to: n.q })
    }
  })

  for (const m of moves) {
    const sub = strokes[m.stroke].sub
    if (m.atStart) {
      const dx = m.to.x - sub.start.x
      const dy = m.to.y - sub.start.y
      sub.start = m.to
      const s = sub.segments[0]
      if (s.type === 'C') sub.segments[0] = { ...s, c1: { x: s.c1.x + dx, y: s.c1.y + dy } }
    } else {
      const last = sub.segments.length - 1
      const s = sub.segments[last]
      const dx = m.to.x - s.to.x
      const dy = m.to.y - s.to.y
      sub.segments[last] = s.type === 'C' ? { ...s, c2: { x: s.c2.x + dx, y: s.c2.y + dy }, to: m.to } : { ...s, to: m.to }
    }
  }
  return moves.length
}
