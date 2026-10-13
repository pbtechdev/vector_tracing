import type { Point, RasterInput, SubPath, TraceProgress, TraceResult, TraceSettings, TraceStats, VectorShape } from '../types/vectorTrace'
import { groupContours, traceContours } from './contourDetection'
import { type CurveOptions, polylineToPath, resample, scaleSubPath, staircaseToPolyline, taubinSmooth } from './curveFitting'
import { fitMinimalPath } from './minimalCurve'
import { preprocess } from './imagePreprocessing'
import { extractCenterlines } from './centerline'
import { type SnapStroke, snapStrokeEnds } from './junctionSnap'
import type { PrimitiveCounts } from './primitives'

export interface TraceInput {
  raster: RasterInput
  sourceWidth: number
  sourceHeight: number
  settings: TraceSettings
  /**
   * Raster pixels per pixel of genuine detail; defaults to the upscale factor. An AI-sharpened
   * raster carries real detail at its own resolution, so it is fitted at 1.
   */
  detailScale?: number
}

/** Maps the detail slider (0–100) to a max fitting deviation in processing pixels. */
export function detailToTolerance(detail: number): number {
  const d = Math.min(100, Math.max(0, detail))
  return 0.2 + ((100 - d) / 100) * 2.8
}

export function computeStats(shapes: VectorShape[], primitives: PrimitiveCounts = { lines: 0, arcs: 0, circles: 0, ellipses: 0 }): TraceStats {
  let subpathCount = 0
  let nodeCount = 0
  let curveCount = 0
  let lineCount = 0
  for (const s of shapes) {
    for (const p of s.subpaths) {
      subpathCount++
      nodeCount += p.segments.length + (p.closed ? 0 : 1)
      for (const seg of p.segments) {
        if (seg.type === 'C') curveCount++
        else lineCount++
      }
    }
  }
  return { shapeCount: shapes.length, subpathCount, nodeCount, curveCount, lineCount, primitives: { ...primitives } }
}

/**
 * Whether a fitted centerline stays on its stroke: no stretch longer than a stroke radius may run
 * off the ink. Stroke ends are exempt (they are extended to the tip). Hairlines are not checked,
 * since there the tolerance alone can reach the edge of the ink.
 */
function followsInk(sub: SubPath, strokeRadius: number, radiusAt: (p: Point) => number): boolean {
  if (strokeRadius < 1.5) return true
  const step = 0.5
  const minDepth = 0.25 * strokeRadius
  const { samples } = flattenPath(sub, step)
  const skip = sub.closed ? 0 : Math.ceil((2 * strokeRadius) / step)
  let run = 0
  for (let i = skip; i < samples.length - skip; i++) {
    run = radiusAt(samples[i]) < minDepth ? run + step : 0
    if (run > strokeRadius) return false
  }
  return true
}

/** Points every `step` along a path; `nodes[k]` is the sample index where segment k ends. */
function flattenPath(sub: SubPath, step: number): { samples: Point[]; nodes: number[] } {
  const samples: Point[] = [sub.start]
  const nodes: number[] = []
  let from = sub.start
  for (const seg of sub.segments) {
    const len = seg.type === 'L' ? Math.hypot(seg.to.x - from.x, seg.to.y - from.y) : Math.hypot(seg.c1.x - from.x, seg.c1.y - from.y) + Math.hypot(seg.c2.x - seg.c1.x, seg.c2.y - seg.c1.y) + Math.hypot(seg.to.x - seg.c2.x, seg.to.y - seg.c2.y)
    const n = Math.max(1, Math.ceil(len / step))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      if (seg.type === 'L') samples.push({ x: from.x + (seg.to.x - from.x) * t, y: from.y + (seg.to.y - from.y) * t })
      else {
        const u = 1 - t
        samples.push({
          x: u * u * u * from.x + 3 * u * u * t * seg.c1.x + 3 * u * t * t * seg.c2.x + t * t * t * seg.to.x,
          y: u * u * u * from.y + 3 * u * u * t * seg.c1.y + 3 * u * t * t * seg.c2.y + t * t * t * seg.to.y,
        })
      }
    }
    nodes.push(samples.length - 1)
    from = seg.to
  }
  return { samples, nodes }
}

/**
 * Fewest-node fits may stray this many stroke radii from the (jittery) skeleton, but must keep
 * every point at least MINIMAL_DEPTH stroke radii deep in the ink.
 */
const MINIMAL_TOLERANCE = 1
const MINIMAL_DEPTH = 0.45
/** A stroke is redrawn with fewest nodes once free stretches reach this share of its recognised pieces. */
const MOSTLY_FREE = 0.25

function addCounts(into: PrimitiveCounts, from: PrimitiveCounts): void {
  into.lines += from.lines
  into.arcs += from.arcs
  into.circles += from.circles
  into.ellipses += from.ellipses
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export function traceRaster(input: TraceInput, onProgress?: (p: TraceProgress) => void): TraceResult {
  const t0 = now()
  const { raster, sourceWidth, sourceHeight, settings } = input
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Invalid source dimensions.')
  }
  if (raster.width <= 0 || raster.height <= 0) throw new Error('Image has no pixels.')
  const report = (stage: string, fraction: number): void => onProgress?.({ stage, fraction })

  const scale = raster.width / sourceWidth
  const sx = sourceWidth / raster.width
  const sy = sourceHeight / raster.height
  const upscale = input.detailScale ?? Math.max(1, scale)

  report('Preprocessing', 0.05)
  const pre = preprocess(raster, settings, scale)
  const warnings = [...pre.warnings]

  const opts: CurveOptions = {
    smoothing: settings.smoothing,
    tolerance: detailToTolerance(settings.detail) * upscale,
    cornerAngle: settings.cornerAngle,
    spacing: 1.25 * upscale,
  }
  const counts: PrimitiveCounts = { lines: 0, arcs: 0, circles: 0, ellipses: 0 }
  const useGeometry = settings.straightEdges || settings.fitArcs
  const geometry = (strokeRadius: number, radiusAt?: (p: Point) => number, into: PrimitiveCounts = counts): CurveOptions['geometry'] =>
    useGeometry ? { lines: settings.straightEdges, arcs: settings.fitArcs, upscale, strokeRadius, radiusAt, counts: into } : undefined

  const shapes: VectorShape[] = []
  let estimatedStrokeWidth = 1

  if (settings.mode === 'centerline') {
    report('Skeletonizing', 0.25)
    const center = extractCenterlines(pre.bitmap, {
      spurLength: Math.max(0, settings.spurLength) * scale,
      minLength: Math.max(3, Math.sqrt(Math.max(0, settings.minObjectSize)) * scale),
      lineEnds: settings.lineEnds,
      joinStrokes: settings.joinStrokes,
      joinAngle: settings.joinAngle,
      gapClosing: Math.max(0, settings.gapClosing) * scale,
    })
    estimatedStrokeWidth = center.medianWidth * sx
    report('Fitting curves', 0.6)
    const lineOpts: CurveOptions = { ...opts, pinnedAreCorners: false, presmooth: 2 }
    const total = center.strokes.length
    const fitted: (SnapStroke & { width: number })[] = []
    center.strokes.forEach((stroke, k) => {
      const fixed = new Set(stroke.fixed)
      const pinned = stroke.points.map((_, i) => fixed.has(i))
      const line = { points: stroke.points, pinned }
      const found: PrimitiveCounts = { lines: 0, arcs: 0, circles: 0, ellipses: 0 }
      const r = stroke.width / 2
      let sub = polylineToPath(line, stroke.closed, { ...lineOpts, geometry: geometry(r, center.radiusAt, found) })
      // Every recognised shape is checked against the drawing; one that leaves the ink anywhere
      // is replaced by the plain curve fit, which follows the ink.
      let exact = true
      if (sub && useGeometry && !followsInk(sub, r, center.radiusAt)) {
        sub = polylineToPath(line, stroke.closed, lineOpts)
        exact = false
      }
      const recognised = found.lines + found.arcs + found.circles + found.ellipses
      if (exact && recognised > 0 && (found.free ?? 0) < MOSTLY_FREE * recognised) {
        addCounts(counts, found)
      } else if (useGeometry && sub) {
        // Mostly freehand strokes get the fewest-node description that still stays on the ink,
        // the way a person would redraw them; strokes made of exact lines, arcs and whole shapes are kept.
        const tol = Math.max(0.6 * upscale, 0.6 + 0.12 * r, MINIMAL_TOLERANCE * r)
        const sampled = taubinSmooth(resample(line, opts.spacing, stroke.closed), 3, stroke.closed)
        const span = Math.max(2, Math.round(r / opts.spacing))
        const ink = { depth: center.radiusAt, minDepth: MINIMAL_DEPTH * r, endClearance: 2 * r }
        const simple = fitMinimalPath(sampled.points, stroke.closed, tol, span, span, ink, exact ? found.corners : [])
        if (simple && simple.segments.length < sub.segments.length && followsInk(simple, r, center.radiusAt)) {
          sub = simple
        } else if (exact) {
          addCounts(counts, found)
        }
      } else if (exact) {
        addCounts(counts, found)
      }
      if (sub) fitted.push({ sub, radius: stroke.width / 2, width: stroke.width })
      if (k % 200 === 0) report('Fitting curves', 0.6 + 0.35 * (k / Math.max(1, total)))
    })
    snapStrokeEnds(fitted)
    for (const f of fitted) shapes.push({ kind: 'stroke', subpaths: [scaleSubPath(f.sub, sx, sy)], strokeWidth: f.width * sx })
  } else {
    report('Detecting contours', 0.3)
    const contours = traceContours(pre.bitmap)
    const groups = groupContours(contours)
    report('Fitting curves', 0.45)
    const cornerRun = Math.max(3, Math.round(3 * upscale))
    const contourOpts: CurveOptions = { ...opts, geometry: geometry(0) }
    const total = groups.length
    for (let g = 0; g < total; g++) {
      const group = groups[g]
      const subpaths: SubPath[] = []
      for (const c of [group.outer, ...group.holes]) {
        const sub = polylineToPath(staircaseToPolyline(c.points, cornerRun), true, contourOpts)
        if (sub) subpaths.push(scaleSubPath(sub, sx, sy))
      }
      if (subpaths.length > 0) shapes.push({ kind: 'area', subpaths })
      if (g % 200 === 0) report('Fitting curves', 0.45 + 0.5 * (g / Math.max(1, total)))
    }
  }

  if (shapes.length > 5000) {
    warnings.push(`${shapes.length} shapes were generated. Increase noise removal or lower detail for a lighter file.`)
  }
  report('Done', 1)

  return {
    mode: settings.mode,
    width: sourceWidth,
    height: sourceHeight,
    processingWidth: raster.width,
    processingHeight: raster.height,
    shapes,
    stats: computeStats(shapes, counts),
    thresholdUsed: pre.thresholdUsed,
    foregroundRatio: pre.foregroundRatio,
    estimatedStrokeWidth,
    bitmap: pre.bitmap.data,
    durationMs: now() - t0,
    warnings,
  }
}
