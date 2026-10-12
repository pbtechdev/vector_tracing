import type { Point } from '../types/vectorTrace'
import type { Bitmap } from './imagePreprocessing'

/**
 * A closed boundary on the pixel-corner grid. Vertices are the corners where the
 * boundary changes direction. Outer boundaries run clockwise on screen (positive area),
 * holes run counter-clockwise (negative area).
 */
export interface Contour {
  points: Point[]
  area: number
  isHole: boolean
  /** A point strictly inside the region adjacent to this contour's left side (used for hole nesting). */
  probe: Point
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// Directions on screen (y down): East, South, West, North.
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

export function signedArea(points: Point[]): number {
  let a = 0
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i]
    const q = points[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/**
 * Traces every boundary between foreground and background pixels.
 * Foreground is treated as 8-connected: diagonally touching pixels belong to the same contour.
 */
export function traceContours(bitmap: Bitmap): Contour[] {
  const { data, width: w, height: h } = bitmap
  const vw = w + 1
  const vh = h + 1
  const edges = new Uint8Array(vw * vh)
  const fg = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] !== 1) continue
      if (!fg(x, y - 1)) edges[y * vw + x] |= 1 // E from top-left corner
      if (!fg(x + 1, y)) edges[y * vw + x + 1] |= 2 // S from top-right corner
      if (!fg(x, y + 1)) edges[(y + 1) * vw + x + 1] |= 4 // W from bottom-right corner
      if (!fg(x - 1, y)) edges[(y + 1) * vw + x] |= 8 // N from bottom-left corner
    }
  }

  const contours: Contour[] = []
  const dirs: number[] = []
  for (let v = 0; v < edges.length; v++) {
    while (edges[v] !== 0) {
      const sx = v % vw
      const sy = (v - sx) / vw
      let d = 0
      while (!(edges[v] & (1 << d))) d++

      dirs.length = 0
      let cx = sx
      let cy = sy
      let dir = d
      // Each traversal clears its edges, so it always returns to the start vertex.
      for (;;) {
        edges[cy * vw + cx] &= ~(1 << dir)
        dirs.push(dir)
        cx += DX[dir]
        cy += DY[dir]
        if (cx === sx && cy === sy) break
        const m = edges[cy * vw + cx]
        if (m === 0) break
        const left = (dir + 3) & 3
        const right = (dir + 1) & 3
        if (m & (1 << left)) dir = left
        else if (!(m & (1 << dir))) dir = right
      }

      // Keep only vertices where the direction changes.
      const points: Point[] = []
      let px = sx
      let py = sy
      const count = dirs.length
      for (let i = 0; i < count; i++) {
        const prev = dirs[(i + count - 1) % count]
        if (dirs[i] !== prev) points.push({ x: px, y: py })
        px += DX[dirs[i]]
        py += DY[dirs[i]]
      }
      if (points.length < 4) continue

      const area = signedArea(points)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const p of points) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
      // Pixel to the left of the first edge (the background side for outer contours,
      // the hole interior for hole contours).
      const fdx = DX[d]
      const fdy = DY[d]
      const probe = { x: sx + 0.5 * fdx + 0.5 * fdy, y: sy + 0.5 * fdy - 0.5 * fdx }
      contours.push({ points, area, isHole: area < 0, probe, minX, minY, maxX, maxY })
    }
  }
  return contours
}

export function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

export interface ContourGroup {
  outer: Contour
  holes: Contour[]
}

/** Assigns each hole to the smallest outer contour that encloses it. */
export function groupContours(contours: Contour[]): ContourGroup[] {
  const outers = contours.filter((c) => !c.isHole).sort((a, b) => a.area - b.area)
  const groups = new Map<Contour, ContourGroup>()
  for (const o of outers) groups.set(o, { outer: o, holes: [] })

  for (const hole of contours) {
    if (!hole.isHole) continue
    const p = hole.probe
    for (const o of outers) {
      if (o.area < -hole.area) continue
      if (p.x < o.minX || p.x > o.maxX || p.y < o.minY || p.y > o.maxY) continue
      if (pointInPolygon(p, o.points)) {
        groups.get(o)?.holes.push(hole)
        break
      }
    }
  }
  return outers.map((o) => groups.get(o) as ContourGroup).reverse()
}
