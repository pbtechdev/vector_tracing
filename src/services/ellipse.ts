import type { PathSegment, Point, SubPath } from '../types/vectorTrace'

export interface Ellipse {
  cx: number
  cy: number
  /** Semi-axes; `a` lies along `angle`. */
  a: number
  b: number
  angle: number
}

/** Eigenvalues of a real 3×3 matrix that are real (roots of its characteristic cubic). */
function realEigenvalues(m: number[][]): number[] {
  const tr = m[0][0] + m[1][1] + m[2][2]
  const minors = m[0][0] * m[1][1] - m[0][1] * m[1][0] + m[0][0] * m[2][2] - m[0][2] * m[2][0] + m[1][1] * m[2][2] - m[1][2] * m[2][1]
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  // λ³ − tr·λ² + minors·λ − det = 0, depressed with λ = t + tr/3.
  const p = minors - (tr * tr) / 3
  const q = (-2 * tr ** 3) / 27 + (tr * minors) / 3 - det
  const shift = tr / 3
  const disc = (q * q) / 4 + (p * p * p) / 27
  if (disc > 1e-18) {
    const s = Math.sqrt(disc)
    return [Math.cbrt(-q / 2 + s) + Math.cbrt(-q / 2 - s) + shift]
  }
  if (Math.abs(p) < 1e-18) return [shift]
  const r = 2 * Math.sqrt(-p / 3)
  const phi = Math.acos(Math.max(-1, Math.min(1, (3 * q) / (p * r))))
  return [0, 1, 2].map((k) => r * Math.cos(phi / 3 - (2 * Math.PI * k) / 3) + shift)
}

function nullVector(m: number[][], lambda: number): number[] | null {
  const rows = m.map((row, i) => row.map((v, j) => (i === j ? v - lambda : v)))
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  let best: number[] | null = null
  let bestN = 0
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    const c = cross(rows[i], rows[j])
    const n = Math.hypot(c[0], c[1], c[2])
    if (n > bestN) {
      bestN = n
      best = c
    }
  }
  return best && bestN > 1e-300 ? best.map((v) => v / bestN) : null
}

function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r
    if (Math.abs(m[piv][c]) < 1e-300) return null
    ;[m[c], m[piv]] = [m[piv], m[c]]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
}

/**
 * Direct least-squares ellipse fit (Fitzgibbon, Pilu & Fisher, in the numerically stable form of
 * Halíř & Flusser) on normalised coordinates. Always returns an ellipse when the points allow one.
 */
export function fitEllipse(pts: Point[]): Ellipse | null {
  const n = pts.length
  if (n < 6) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let s = 0
  for (const p of pts) s += (p.x - mx) ** 2 + (p.y - my) ** 2
  s = Math.sqrt(s / n) || 1
  const S1 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const S2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const S3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of pts) {
    const x = (p.x - mx) / s
    const y = (p.y - my) / s
    const d1 = [x * x, x * y, y * y]
    const d2 = [x, y, 1]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        S1[i][j] += d1[i] * d1[j]
        S2[i][j] += d1[i] * d2[j]
        S3[i][j] += d2[i] * d2[j]
      }
    }
  }
  // T = −S3⁻¹ S2ᵀ, column by column.
  const T = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let c = 0; c < 3; c++) {
    const col = solve3(S3, [S2[c][0], S2[c][1], S2[c][2]])
    if (!col) return null
    for (let r = 0; r < 3; r++) T[r][c] = -col[r]
  }
  const M = S1.map((row, i) => row.map((v, j) => v + S2[i][0] * T[0][j] + S2[i][1] * T[1][j] + S2[i][2] * T[2][j]))
  // Premultiply by the inverse constraint matrix C1⁻¹ (4ac − b² = 1).
  const Mc = [M[2].map((v) => v / 2), M[1].map((v) => -v), M[0].map((v) => v / 2)]
  let a1: number[] | null = null
  for (const l of realEigenvalues(Mc)) {
    const v = nullVector(Mc, l)
    if (v && 4 * v[0] * v[2] - v[1] * v[1] > 0) {
      a1 = v
      break
    }
  }
  if (!a1) return null
  const a2 = [0, 1, 2].map((r) => T[r][0] * a1[0] + T[r][1] * a1[1] + T[r][2] * a1[2])
  const [A, B, C] = a1
  const [D, E, F] = a2
  // Centre, then the axes from the quadratic form.
  const det = 4 * A * C - B * B
  if (!(det > 0)) return null
  const x0 = (B * E - 2 * C * D) / det
  const y0 = (B * D - 2 * A * E) / det
  const F0 = F + (D * x0 + E * y0) / 2
  const angle = 0.5 * Math.atan2(B, A - C)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const l1 = A * cos * cos + B * cos * sin + C * sin * sin
  const l2 = A * sin * sin - B * cos * sin + C * cos * cos
  if (!(-F0 / l1 > 0) || !(-F0 / l2 > 0)) return null
  return { cx: mx + x0 * s, cy: my + y0 * s, a: Math.sqrt(-F0 / l1) * s, b: Math.sqrt(-F0 / l2) * s, angle }
}

/** Distance from a point to the ellipse curve (Newton on the parametric angle). */
export function ellipseDistance(e: Ellipse, p: Point): number {
  const c = Math.cos(e.angle)
  const s = Math.sin(e.angle)
  const u = (p.x - e.cx) * c + (p.y - e.cy) * s
  const v = -(p.x - e.cx) * s + (p.y - e.cy) * c
  let t = Math.atan2(v * e.a, u * e.b)
  for (let it = 0; it < 6; it++) {
    const ct = Math.cos(t)
    const st = Math.sin(t)
    const dx = e.a * ct - u
    const dy = e.b * st - v
    const g = -dx * e.a * st + dy * e.b * ct
    const h = e.a * e.a * st * st + e.b * e.b * ct * ct - dx * e.a * ct - dy * e.b * st
    if (Math.abs(h) < 1e-12) break
    t -= g / h
  }
  return Math.hypot(e.a * Math.cos(t) - u, e.b * Math.sin(t) - v)
}

const KAPPA_QUARTER = (4 / 3) * Math.tan(Math.PI / 8)

/**
 * Exact ellipse as four cubic quarter arcs (the affine image of the standard circle arcs),
 * traversed so that its shoelace area is positive or negative as requested.
 */
export function ellipsePath(e: Ellipse, positiveArea: boolean): SubPath {
  const U = { x: Math.cos(e.angle), y: Math.sin(e.angle) }
  const V = { x: -U.y, y: U.x }
  const sign = positiveArea ? 1 : -1
  const at = (t: number): Point => ({ x: e.cx + e.a * Math.cos(t) * U.x + e.b * Math.sin(t) * V.x, y: e.cy + e.a * Math.cos(t) * U.y + e.b * Math.sin(t) * V.y })
  const tangent = (t: number): Point => ({
    x: sign * (-e.a * Math.sin(t) * U.x + e.b * Math.cos(t) * V.x),
    y: sign * (-e.a * Math.sin(t) * U.y + e.b * Math.cos(t) * V.y),
  })
  const segments: PathSegment[] = []
  for (let j = 0; j < 4; j++) {
    const t0 = (sign * j * Math.PI) / 2
    const t1 = (sign * (j + 1) * Math.PI) / 2
    const p0 = at(t0)
    const p3 = at(t1)
    const d0 = tangent(t0)
    const d1 = tangent(t1)
    segments.push({
      type: 'C',
      c1: { x: p0.x + KAPPA_QUARTER * d0.x, y: p0.y + KAPPA_QUARTER * d0.y },
      c2: { x: p3.x - KAPPA_QUARTER * d1.x, y: p3.y - KAPPA_QUARTER * d1.y },
      to: p3,
    })
  }
  return { start: at(0), segments, closed: true }
}
