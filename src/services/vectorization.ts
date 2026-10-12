import type { RasterInput, SubPath, TraceProgress, TraceResult, TraceSettings, TraceStats, VectorShape } from '../types/vectorTrace'
import { groupContours, traceContours } from './contourDetection'
import { type CurveOptions, polylineToPath, scaleSubPath, staircaseToPolyline } from './curveFitting'
import { preprocess } from './imagePreprocessing'
import { extractCenterlines } from './centerline'

export interface TraceInput {
  raster: RasterInput
  sourceWidth: number
  sourceHeight: number
  settings: TraceSettings
}

/** Maps the detail slider (0–100) to a max fitting deviation in processing pixels. */
export function detailToTolerance(detail: number): number {
  const d = Math.min(100, Math.max(0, detail))
  return 0.2 + ((100 - d) / 100) * 2.8
}

export function computeStats(shapes: VectorShape[]): TraceStats {
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
  return { shapeCount: shapes.length, subpathCount, nodeCount, curveCount, lineCount }
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
  const upscale = Math.max(1, scale)

  report('Preprocessing', 0.05)
  const pre = preprocess(raster, settings, scale)
  const warnings = [...pre.warnings]

  const opts: CurveOptions = {
    smoothing: settings.smoothing,
    tolerance: detailToTolerance(settings.detail) * upscale,
    cornerAngle: settings.cornerAngle,
    spacing: 1.25 * upscale,
  }

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
    center.strokes.forEach((stroke, k) => {
      const fixed = new Set(stroke.fixed)
      const pinned = stroke.points.map((_, i) => fixed.has(i))
      const sub = polylineToPath({ points: stroke.points, pinned }, stroke.closed, lineOpts)
      if (sub) shapes.push({ kind: 'stroke', subpaths: [scaleSubPath(sub, sx, sy)], strokeWidth: stroke.width * sx })
      if (k % 200 === 0) report('Fitting curves', 0.6 + 0.35 * (k / Math.max(1, total)))
    })
  } else {
    report('Detecting contours', 0.3)
    const contours = traceContours(pre.bitmap)
    const groups = groupContours(contours)
    report('Fitting curves', 0.45)
    const cornerRun = Math.max(3, Math.round(3 * upscale))
    const total = groups.length
    for (let g = 0; g < total; g++) {
      const group = groups[g]
      const subpaths: SubPath[] = []
      for (const c of [group.outer, ...group.holes]) {
        const sub = polylineToPath(staircaseToPolyline(c.points, cornerRun), true, opts)
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
    stats: computeStats(shapes),
    thresholdUsed: pre.thresholdUsed,
    foregroundRatio: pre.foregroundRatio,
    estimatedStrokeWidth,
    bitmap: pre.bitmap.data,
    durationMs: now() - t0,
    warnings,
  }
}
