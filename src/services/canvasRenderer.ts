import type { ExportSettings, SubPath, TraceResult } from '../types/vectorTrace'
import { uniformCenterlineWidth } from './svgExporter'

export interface PreparedPaths {
  areas: Path2D
  strokes: Path2D
  /** Centerline strokes grouped by measured width (rounded to 0.25 source px). */
  strokesByWidth: { width: number; path: Path2D }[]
  hasAreas: boolean
  hasStrokes: boolean
  nodes: Float32Array
  result: TraceResult
}

function appendSubPath(target: Path2D, p: SubPath, nodes: number[]): void {
  target.moveTo(p.start.x, p.start.y)
  nodes.push(p.start.x, p.start.y)
  for (const s of p.segments) {
    if (s.type === 'L') target.lineTo(s.to.x, s.to.y)
    else target.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y)
    nodes.push(s.to.x, s.to.y)
  }
  if (p.closed) target.closePath()
}

/**
 * Builds reusable Path2D objects for a result. Traced contours never cross, so a single
 * even-odd path renders holes and islands correctly.
 */
export function preparePaths(result: TraceResult): PreparedPaths {
  const areas = new Path2D()
  const strokes = new Path2D()
  const nodes: number[] = []
  const groups = new Map<number, Path2D>()
  const ignored: number[] = []
  let hasAreas = false
  let hasStrokes = false
  for (const shape of result.shapes) {
    if (shape.kind === 'area') {
      hasAreas = true
      for (const p of shape.subpaths) appendSubPath(areas, p, nodes)
      continue
    }
    hasStrokes = true
    const key = Math.max(0.25, Math.round((shape.strokeWidth ?? result.estimatedStrokeWidth) * 4) / 4)
    let group = groups.get(key)
    if (!group) {
      group = new Path2D()
      groups.set(key, group)
    }
    for (const p of shape.subpaths) {
      appendSubPath(strokes, p, nodes)
      appendSubPath(group, p, ignored)
      ignored.length = 0
    }
  }
  const strokesByWidth = [...groups.entries()].map(([width, path]) => ({ width, path }))
  return { areas, strokes, strokesByWidth, hasAreas, hasStrokes, nodes: new Float32Array(nodes), result }
}

/**
 * Draws prepared paths in image coordinates; `viewScale` keeps hairlines visible when zoomed out.
 * With `hairline`, centerlines are drawn as thin accent lines instead of at their stroke width.
 */
export function drawVectors(
  ctx: CanvasRenderingContext2D,
  paths: PreparedPaths,
  style: ExportSettings,
  viewScale: number,
  opacity = 1,
  hairline = false,
): void {
  const minLine = 1 / viewScale
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (paths.hasAreas) {
    if (style.style !== 'stroke') {
      ctx.fillStyle = style.fillColor
      ctx.fill(paths.areas, 'evenodd')
    }
    if (style.style !== 'fill') {
      ctx.strokeStyle = style.strokeColor
      ctx.lineWidth = Math.max(style.strokeWidth, minLine)
      ctx.stroke(paths.areas)
    }
  }
  if (paths.hasStrokes) {
    if (hairline) {
      ctx.strokeStyle = '#0284c7'
      ctx.lineWidth = 1.5 / viewScale
      ctx.stroke(paths.strokes)
    } else {
      ctx.strokeStyle = style.strokeColor
      const uniform = uniformCenterlineWidth(paths.result, style)
      if (uniform !== null) {
        ctx.lineWidth = Math.max(uniform, minLine)
        ctx.stroke(paths.strokes)
      } else {
        for (const g of paths.strokesByWidth) {
          ctx.lineWidth = Math.max(g.width, minLine)
          ctx.stroke(g.path)
        }
      }
    }
  }
  ctx.restore()
}

export function drawNodes(ctx: CanvasRenderingContext2D, nodes: Float32Array, viewScale: number, limit = 40000): void {
  const count = nodes.length / 2
  if (count === 0 || count > limit) return
  const s = 4 / viewScale
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#0284c7'
  ctx.lineWidth = 1 / viewScale
  ctx.beginPath()
  for (let i = 0; i < nodes.length; i += 2) ctx.rect(nodes[i] - s / 2, nodes[i + 1] - s / 2, s, s)
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

/** Renders the traced bitmap (black on transparent) into a canvas at processing resolution. */
export function bitmapToCanvas(result: TraceResult): HTMLCanvasElement {
  const { processingWidth: w, processingHeight: h, bitmap } = result
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < bitmap.length; i++) {
    const v = bitmap[i]
    img.data[i * 4] = 15
    img.data[i * 4 + 1] = 23
    img.data[i * 4 + 2] = 42
    img.data[i * 4 + 3] = v ? 255 : 0
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

let checkerCache: HTMLCanvasElement | null = null
export function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (!checkerCache) {
    checkerCache = document.createElement('canvas')
    checkerCache.width = 16
    checkerCache.height = 16
    const c = checkerCache.getContext('2d')
    if (c) {
      c.fillStyle = '#ffffff'
      c.fillRect(0, 0, 16, 16)
      c.fillStyle = '#e2e8f0'
      c.fillRect(0, 0, 8, 8)
      c.fillRect(8, 8, 8, 8)
    }
  }
  return ctx.createPattern(checkerCache, 'repeat')
}
