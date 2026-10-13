import type { LineEndMode, Point } from '../types/vectorTrace'
import { distanceTransform } from './distanceTransform'
import type { Bitmap } from './imagePreprocessing'
import { removeStaircases, thinInPlace } from './skeleton'

export interface CenterlineOptions {
  /** Extra spur length (processing px) pruned beyond the automatic 1.5 × local radius. */
  spurLength: number
  /** Isolated strokes shorter than this (processing px) are dropped. */
  minLength: number
  lineEnds: LineEndMode
  joinStrokes: boolean
  /** Max bend in degrees for continuing through a junction. */
  joinAngle: number
  /** Max gap (processing px) bridged between aligned line ends. */
  gapClosing: number
}

export interface CenterlineStroke {
  /** Processing-pixel coordinates. */
  points: Point[]
  closed: boolean
  /** Indices of junction points that must stay fixed so branches keep meeting there. */
  fixed: number[]
  /** Median stroke width along the path (processing px). */
  width: number
}

export interface CenterlineResult {
  strokes: CenterlineStroke[]
  /** Median stroke width over the whole skeleton (processing px). */
  medianWidth: number
  skeletonPixels: number
  junctionCount: number
  /** Distance (processing px) from a point to the nearest background pixel; 0 outside the ink. */
  radiusAt: (p: Point) => number
}

interface GNode {
  x: number
  y: number
  radius: number
  edges: number[]
  parent: number
}

interface GEdge {
  a: number
  b: number
  /** Interior skeleton points from a to b (node positions excluded). */
  pts: Point[]
  alive: boolean
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function polylineLength(pts: Point[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

/** Point at arc length `s` from the start of `pts` (clamped to the end). */
function pointAtArc(pts: Point[], s: number): Point {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i])
    if (acc + d >= s && d > 0) {
      const t = (s - acc) / d
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
    }
    acc += d
  }
  return pts[pts.length - 1]
}

function unit(dx: number, dy: number): Point {
  const l = Math.hypot(dx, dy)
  return l < 1e-9 ? { x: 0, y: 0 } : { x: dx / l, y: dy / l }
}

/**
 * Extracts single-stroke centerlines from a binary bitmap.
 *
 * Pipeline: distance transform → Zhang–Suen thinning → staircase removal → skeleton graph
 * (junction clusters become single nodes) → width-relative spur pruning → merging of split
 * X-junctions → optional gap closing → chaining strokes straight through junctions →
 * restoring stroke ends lost to thinning → per-stroke width from the distance transform.
 */
export function extractCenterlines(bitmap: Bitmap, opts: CenterlineOptions): CenterlineResult {
  const { width: w, height: h } = bitmap
  const pw = w + 2
  const ph = h + 2
  const N = pw * ph
  const fg = new Uint8Array(N)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fg[(y + 1) * pw + x + 1] = bitmap.data[y * w + x]

  const dt = distanceTransform(fg, pw, ph)
  const skel = fg.slice()
  thinInPlace(skel, pw, ph)
  removeStaircases(skel, pw, ph)

  const OFF = [1, -pw + 1, -pw, -pw - 1, -1, pw - 1, pw, pw + 1]
  const toPt = (i: number): Point => ({ x: (i % pw) - 1 + 0.5, y: Math.floor(i / pw) - 1 + 0.5 })
  const indexAt = (p: Point): number => {
    const x = Math.floor(p.x) + 1
    const y = Math.floor(p.y) + 1
    return x < 0 || y < 0 || x >= pw || y >= ph ? -1 : y * pw + x
  }
  const radiusAt = (p: Point): number => {
    const i = indexAt(p)
    const r = i >= 0 ? dt[i] : 0
    return Number.isFinite(r) ? r : 0
  }
  /** Bilinear ink depth between pixel centres. */
  const depthAt = (p: Point): number => {
    const fx = p.x - 0.5
    const fy = p.y - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const at = (x: number, y: number): number => radiusAt({ x: x + 0.5, y: y + 0.5 })
    return (1 - ty) * ((1 - tx) * at(x0, y0) + tx * at(x0 + 1, y0)) + ty * ((1 - tx) * at(x0, y0 + 1) + tx * at(x0 + 1, y0 + 1))
  }

  const pixels: number[] = []
  const deg = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (!skel[i]) continue
    pixels.push(i)
    let c = 0
    for (const o of OFF) c += skel[i + o]
    deg[i] = c
  }

  // ---- Nodes: endpoints (degree 1) and clusters of junction pixels (degree ≥ 3).
  const nodeOf = new Int32Array(N).fill(-1)
  const nodes: GNode[] = []
  const nodePixels: number[][] = []
  for (const i of pixels) {
    if (deg[i] === 2 || deg[i] === 0 || nodeOf[i] >= 0) continue
    const id = nodes.length
    const members: number[] = []
    if (deg[i] === 1) {
      members.push(i)
      nodeOf[i] = id
    } else {
      const stack = [i]
      nodeOf[i] = id
      while (stack.length) {
        const p = stack.pop() as number
        members.push(p)
        for (const o of OFF) {
          const q = p + o
          if (skel[q] && deg[q] >= 3 && nodeOf[q] < 0) {
            nodeOf[q] = id
            stack.push(q)
          }
        }
      }
    }
    let sx = 0
    let sy = 0
    let r = 0
    for (const p of members) {
      const pt = toPt(p)
      sx += pt.x
      sy += pt.y
      r = Math.max(r, dt[p])
    }
    nodes.push({ x: sx / members.length, y: sy / members.length, radius: r, edges: [], parent: id })
    nodePixels.push(members)
  }

  // ---- Edges: walk degree-2 pixels between nodes.
  const edges: GEdge[] = []
  const visited = new Uint8Array(N)
  const direct = new Set<number>()
  const addEdge = (a: number, b: number, pts: Point[]): void => {
    const id = edges.length
    edges.push({ a, b, pts, alive: true })
    nodes[a].edges.push(id)
    if (b !== a) nodes[b].edges.push(id)
  }

  for (let id = 0; id < nodes.length; id++) {
    for (const s of nodePixels[id]) {
      for (const o of OFF) {
        const q = s + o
        if (!skel[q]) continue
        const nq = nodeOf[q]
        if (nq === id) continue
        if (nq >= 0) {
          const key = Math.min(s, q) * N + Math.max(s, q)
          if (direct.has(key)) continue
          direct.add(key)
          addEdge(id, nq, [])
          continue
        }
        if (visited[q]) continue
        const pts: Point[] = [toPt(q)]
        visited[q] = 1
        let prev = s
        let cur = q
        let end = -1
        for (;;) {
          let next = -1
          for (const o2 of OFF) {
            const r = cur + o2
            if (r !== prev && skel[r] && !(nodeOf[r] < 0 && visited[r])) {
              next = r
              if (nodeOf[r] >= 0) break
            }
          }
          if (next < 0) break
          if (nodeOf[next] >= 0) {
            end = nodeOf[next]
            break
          }
          visited[next] = 1
          pts.push(toPt(next))
          prev = cur
          cur = next
        }
        if (end >= 0) addEdge(id, end, pts)
      }
    }
  }

  // Closed loops without any node (e.g. an "O").
  const loops: Point[][] = []
  for (const i of pixels) {
    if (deg[i] !== 2 || visited[i]) continue
    const pts: Point[] = []
    let prev = -1
    let cur = i
    while (cur >= 0) {
      visited[cur] = 1
      pts.push(toPt(cur))
      let next = -1
      for (const o of OFF) {
        const r = cur + o
        if (r !== prev && skel[r] && !visited[r] && nodeOf[r] < 0) {
          next = r
          break
        }
      }
      prev = cur
      cur = next
    }
    if (pts.length >= 3) loops.push(pts)
  }

  // ---- Graph helpers.
  const find = (id: number): number => {
    let r = id
    while (nodes[r].parent !== r) r = nodes[r].parent
    while (nodes[id].parent !== r) {
      const nxt = nodes[id].parent
      nodes[id].parent = r
      id = nxt
    }
    return r
  }
  const aliveEdges = (id: number): number[] => [...new Set(nodes[id].edges)].filter((e) => edges[e].alive)
  const degreeOf = (id: number): number => {
    let d = 0
    for (const e of aliveEdges(id)) d += find(edges[e].a) === find(edges[e].b) ? 2 : 1
    return d
  }
  const nodePt = (id: number): Point => nodes[find(id)]
  const fullPts = (e: GEdge): Point[] => [nodePt(e.a), ...e.pts, nodePt(e.b)]
  const edgeLength = (e: GEdge): number => polylineLength(fullPts(e))
  const kill = (eid: number): void => {
    edges[eid].alive = false
  }
  // Edge ends must be compared against root ids once nodes have been merged.
  const endsAt = (eid: number, id: number): { a: boolean; b: boolean } => ({
    a: find(edges[eid].a) === id,
    b: find(edges[eid].b) === id,
  })

  const prune = (): void => {
    for (let pass = 0; pass < 8; pass++) {
      const order = edges
        .map((e, i) => ({ i, len: e.alive ? edgeLength(e) : Infinity }))
        .filter((x) => Number.isFinite(x.len))
        .sort((p, q) => p.len - q.len)
      let changed = false
      for (const { i, len } of order) {
        const e = edges[i]
        if (!e.alive) continue
        const a = find(e.a)
        const b = find(e.b)
        if (a === b) {
          // Tiny self-loop inside a junction cluster.
          if (len < 2 * nodes[a].radius + 2) {
            kill(i)
            changed = true
          }
          continue
        }
        const da = degreeOf(a)
        const db = degreeOf(b)
        const junction = da === 1 && db >= 3 ? b : db === 1 && da >= 3 ? a : -1
        if (junction < 0) continue
        if (len < 1.5 * nodes[junction].radius + opts.spurLength) {
          kill(i)
          changed = true
        }
      }
      if (!changed) break
    }
  }

  // Thinning splits an X crossing into two nearby T-junctions; merge them back.
  const mergeJunctions = (): void => {
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      if (!e.alive) continue
      const a = find(e.a)
      const b = find(e.b)
      if (a === b) continue
      if (degreeOf(a) < 3 || degreeOf(b) < 3) continue
      const limit = Math.max(2, 1.25 * Math.max(nodes[a].radius, nodes[b].radius))
      if (edgeLength(e) > limit) continue
      kill(i)
      const na = nodes[a]
      const nb = nodes[b]
      na.x = (na.x + nb.x) / 2
      na.y = (na.y + nb.y) / 2
      na.radius = Math.max(na.radius, nb.radius)
      na.edges.push(...nb.edges)
      nb.parent = a
    }
    for (const e of edges) {
      e.a = find(e.a)
      e.b = find(e.b)
    }
  }

  prune()
  mergeJunctions()
  prune()

  // Oriented points of an edge starting at node `from` (which must be one of its ends).
  const oriented = (eid: number, fromEnd: 0 | 1): Point[] => {
    const p = fullPts(edges[eid])
    return fromEnd === 0 ? p : p.reverse()
  }
  // Direction leaving a node along an edge, measured a few radii away to ignore junction noise.
  const leaveDir = (eid: number, fromEnd: 0 | 1): Point => {
    const p = oriented(eid, fromEnd)
    const len = polylineLength(p)
    const r = nodes[find(fromEnd === 0 ? edges[eid].a : edges[eid].b)].radius
    const q = pointAtArc(p, Math.min(len * 0.6, Math.max(3, 2.5 * r)))
    return unit(q.x - p[0].x, q.y - p[0].y)
  }

  // ---- Gap closing between aligned free ends.
  if (opts.gapClosing > 0) {
    const ends: { node: number; dir: Point }[] = []
    for (let id = 0; id < nodes.length; id++) {
      if (find(id) !== id || degreeOf(id) !== 1) continue
      const eid = aliveEdges(id)[0]
      const fromEnd: 0 | 1 = endsAt(eid, id).a ? 0 : 1
      const d = leaveDir(eid, fromEnd)
      ends.push({ node: id, dir: { x: -d.x, y: -d.y } })
    }
    const cosLimit = Math.cos((60 * Math.PI) / 180)
    const cands: { i: number; j: number; score: number }[] = []
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const pi = nodes[ends[i].node]
        const pj = nodes[ends[j].node]
        const d = dist(pi, pj)
        if (d > opts.gapClosing || d < 1e-6) continue
        const u = unit(pj.x - pi.x, pj.y - pi.y)
        const ci = ends[i].dir.x * u.x + ends[i].dir.y * u.y
        const cj = -(ends[j].dir.x * u.x + ends[j].dir.y * u.y)
        if (ci < cosLimit || cj < cosLimit) continue
        cands.push({ i, j, score: d * (3 - ci - cj) })
      }
    }
    cands.sort((p, q) => p.score - q.score)
    const used = new Set<number>()
    for (const c of cands) {
      if (used.has(c.i) || used.has(c.j)) continue
      used.add(c.i)
      used.add(c.j)
      addEdge(ends[c.i].node, ends[c.j].node, [])
    }
  }

  // ---- Pair edge ends at each node so strokes continue through junctions.
  const E = edges.length
  const partner = new Int32Array(E * 2).fill(-1)
  const cosJoin = Math.cos((Math.min(89, Math.max(0, opts.joinAngle)) * Math.PI) / 180)
  let junctionCount = 0
  for (let id = 0; id < nodes.length; id++) {
    if (find(id) !== id) continue
    const ends: { key: number; dir: Point }[] = []
    for (const eid of aliveEdges(id)) {
      const at = endsAt(eid, id)
      if (at.a) ends.push({ key: eid * 2, dir: leaveDir(eid, 0) })
      if (at.b) ends.push({ key: eid * 2 + 1, dir: leaveDir(eid, 1) })
    }
    if (ends.length >= 3) junctionCount++
    if (ends.length === 2) {
      partner[ends[0].key] = ends[1].key
      partner[ends[1].key] = ends[0].key
      continue
    }
    if (ends.length < 3 || !opts.joinStrokes) continue
    const pairs: { i: number; j: number; c: number }[] = []
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const c = -(ends[i].dir.x * ends[j].dir.x + ends[i].dir.y * ends[j].dir.y)
        if (c >= cosJoin) pairs.push({ i, j, c })
      }
    }
    pairs.sort((p, q) => q.c - p.c)
    const taken = new Set<number>()
    for (const p of pairs) {
      if (taken.has(p.i) || taken.has(p.j)) continue
      taken.add(p.i)
      taken.add(p.j)
      partner[ends[p.i].key] = ends[p.j].key
      partner[ends[p.j].key] = ends[p.i].key
    }
  }

  // ---- Walk chains of paired edges into strokes.
  interface Chain {
    points: Point[]
    fixed: number[]
    closed: boolean
    startFree: boolean
    endFree: boolean
  }
  const usedEdge = new Uint8Array(E)
  const isFreeEnd = (node: number): boolean => degreeOf(node) === 1
  const walk = (startEdge: number, startEnd: 0 | 1): Chain => {
    const startNode = startEnd === 0 ? edges[startEdge].a : edges[startEdge].b
    const points: Point[] = [{ ...nodePt(startNode) }]
    // Only real junctions are pinned; a node left with two edges (e.g. after spur pruning) is
    // just a point on the stroke.
    const isJunction = (node: number): boolean => degreeOf(node) >= 3
    const fixed: number[] = isJunction(startNode) ? [0] : []
    let eid = startEdge
    let from: 0 | 1 = startEnd
    let closed = false
    let lastNode = startNode
    for (;;) {
      usedEdge[eid] = 1
      const p = oriented(eid, from)
      for (let k = 1; k < p.length; k++) points.push({ ...p[k] })
      const toEnd = (1 - from) as 0 | 1
      lastNode = toEnd === 0 ? edges[eid].a : edges[eid].b
      if (isJunction(lastNode)) fixed.push(points.length - 1)
      const nxt = partner[eid * 2 + toEnd]
      if (nxt < 0) break
      const nEdge = nxt >> 1
      if (usedEdge[nEdge]) {
        closed = nEdge === startEdge
        break
      }
      eid = nEdge
      from = (nxt & 1) as 0 | 1
    }
    if (closed && points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-6) {
      points.pop()
      while (fixed.length > 0 && fixed[fixed.length - 1] >= points.length) fixed.pop()
    }
    return {
      points,
      fixed,
      closed,
      startFree: !closed && isFreeEnd(startNode),
      endFree: !closed && isFreeEnd(lastNode),
    }
  }

  const chains: Chain[] = []
  for (let eid = 0; eid < E; eid++) {
    if (!edges[eid].alive || usedEdge[eid]) continue
    for (const end of [0, 1] as const) {
      if (usedEdge[eid]) break
      if (partner[eid * 2 + end] < 0) chains.push(walk(eid, end))
    }
  }
  for (let eid = 0; eid < E; eid++) {
    if (edges[eid].alive && !usedEdge[eid]) chains.push(walk(eid, 0))
  }
  for (const loop of loops) chains.push({ points: loop, fixed: [], closed: true, startFree: false, endFree: false })

  // ---- Widths, end restoration and filtering.
  const fgAt = (p: Point): boolean => {
    const i = indexAt(p)
    return i >= 0 && fg[i] === 1
  }
  const strokeWidthOf = (pts: Point[]): number => {
    const samples: number[] = []
    const step = Math.max(1, Math.floor(pts.length / 200))
    for (let k = 0; k < pts.length; k += step) samples.push(2 * radiusAt(pts[k]) - 0.5)
    return Math.max(1, median(samples))
  }
  const extend = (pts: Point[], atStart: boolean, radius: number): void => {
    const end = atStart ? pts[0] : pts[pts.length - 1]
    const ordered = atStart ? pts : [...pts].reverse()
    const len = polylineLength(ordered)
    const back = pointAtArc(ordered, Math.min(len * 0.5, Math.max(2, 2 * radius)))
    const dir = unit(end.x - back.x, end.y - back.y)
    if (dir.x === 0 && dir.y === 0) return
    const stepSize = 0.5
    const maxT = 3 * radius + 4
    let t = 0
    while (t + stepSize <= maxT && fgAt({ x: end.x + dir.x * (t + stepSize), y: end.y + dir.y * (t + stepSize) })) t += stepSize
    const tip = t + 0.5
    const target = opts.lineEnds === 'tip' ? tip : tip - radius
    if (target <= 0.5) return
    const p = { x: end.x + dir.x * target, y: end.y + dir.y * target }
    if (atStart) pts.unshift(p)
    else pts.push(p)
  }

  const strokes: CenterlineStroke[] = []
  const allWidths: number[] = []
  for (const c of chains) {
    if (c.points.length < 2) continue
    const width = strokeWidthOf(c.points)
    const length = polylineLength(c.points) + (c.closed ? dist(c.points[0], c.points[c.points.length - 1]) : 0)
    const isolated = c.closed || (c.startFree && c.endFree)
    if (isolated && length < opts.minLength) continue
    allWidths.push(width)
    let fixed = c.fixed
    if (opts.lineEnds !== 'none') {
      if (c.startFree) {
        const before = c.points.length
        extend(c.points, true, width / 2)
        if (c.points.length > before) fixed = fixed.map((f) => f + 1)
      }
      if (c.endFree) extend(c.points, false, width / 2)
    }
    // Only interior junction points need pinning; open ends are always kept.
    const interior = fixed.filter((f) => f > 0 && f < c.points.length - 1)
    strokes.push({ points: c.points, closed: c.closed, fixed: interior, width })
  }

  const skelWidths: number[] = []
  const stride = Math.max(1, Math.floor(pixels.length / 5000))
  for (let k = 0; k < pixels.length; k += stride) skelWidths.push(2 * dt[pixels[k]] - 0.5)

  return {
    strokes,
    medianWidth: Math.max(1, skelWidths.length ? median(skelWidths) : median(allWidths)),
    skeletonPixels: pixels.length,
    junctionCount,
    radiusAt: depthAt,
  }
}
