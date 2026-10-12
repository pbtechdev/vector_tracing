import type { ExportSettings, ExportUnit, SubPath, TraceResult, VectorShape } from '../types/vectorTrace'

export function formatNumber(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0'
  const p = Math.max(0, Math.min(6, Math.round(precision)))
  let s = value.toFixed(p)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0') s = '0'
  return s
}

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }, eps: number): boolean =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

export function subpathToPathData(path: SubPath, precision: number): string {
  const f = (v: number): string => formatNumber(v, precision)
  const pt = (p: { x: number; y: number }): string => `${f(p.x)} ${f(p.y)}`
  const parts: string[] = [`M${pt(path.start)}`]
  const eps = 0.5 * 10 ** -precision
  const segs = path.segments
  segs.forEach((seg, i) => {
    const isLast = i === segs.length - 1
    if (seg.type === 'L') {
      // The closing line is implied by Z.
      if (path.closed && isLast && samePoint(seg.to, path.start, eps)) return
      parts.push(`L${pt(seg.to)}`)
    } else {
      parts.push(`C${pt(seg.c1)} ${pt(seg.c2)} ${pt(seg.to)}`)
    }
  })
  if (path.closed) parts.push('Z')
  return parts.join('')
}

export function shapeToPathData(shape: VectorShape, precision: number): string {
  return shape.subpaths.map((p) => subpathToPathData(p, precision)).join('')
}

export interface OutputSize {
  width: number
  height: number
  unit: ExportUnit
}

/** Physical output size for a source image of width × height pixels. */
export function computeOutputSize(width: number, height: number, unit: ExportUnit, dpi: number): OutputSize {
  if (unit === 'px') return { width, height, unit }
  const safeDpi = dpi > 0 ? dpi : 96
  const inches = { w: width / safeDpi, h: height / safeDpi }
  if (unit === 'in') return { width: inches.w, height: inches.h, unit }
  return { width: inches.w * 25.4, height: inches.h * 25.4, unit }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const safeColor = (c: string, fallback: string): string => (HEX_COLOR.test(c) ? c : fallback)

export type SvgSource = Pick<TraceResult, 'width' | 'height' | 'shapes' | 'mode'> &
  Partial<Pick<TraceResult, 'estimatedStrokeWidth'>>

/** Uniform centerline width for `detected`/`custom` modes; null when every stroke uses its own width. */
export function uniformCenterlineWidth(source: SvgSource, settings: ExportSettings): number | null {
  if (settings.centerlineWidth === 'per-path') return null
  if (settings.centerlineWidth === 'detected' && source.estimatedStrokeWidth && source.estimatedStrokeWidth > 0) {
    return source.estimatedStrokeWidth
  }
  return settings.strokeWidth
}

/** Width (source px) a centerline stroke is drawn and exported with. */
export function centerlineWidthFor(shape: VectorShape, source: SvgSource, settings: ExportSettings): number {
  return uniformCenterlineWidth(source, settings) ?? shape.strokeWidth ?? source.estimatedStrokeWidth ?? settings.strokeWidth
}

/**
 * Serializes traced geometry to a standalone SVG 1.1 document.
 * Coordinates are in source-image pixels (the viewBox); width/height carry the physical size.
 */
export function buildSvg(source: SvgSource, settings: ExportSettings, title = 'VectorTrace output'): string {
  const { width, height, shapes } = source
  if (!(width > 0) || !(height > 0)) throw new Error('Cannot export an SVG with empty dimensions.')
  const precision = Math.max(0, Math.min(3, Math.round(settings.precision)))
  const size = computeOutputSize(width, height, settings.unit, settings.dpi)
  const dimFmt = (v: number): string => formatNumber(v, 3) + (size.unit === 'px' ? '' : size.unit)
  const fill = safeColor(settings.fillColor, '#000000')
  const stroke = safeColor(settings.strokeColor, '#000000')
  const strokeWidth = formatNumber(Math.max(0.01, settings.strokeWidth), 3)

  const areas = shapes.filter((s) => s.kind === 'area')
  const strokes = shapes.filter((s) => s.kind === 'stroke')

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${dimFmt(size.width)}" height="${dimFmt(size.height)}" viewBox="0 0 ${formatNumber(width, 3)} ${formatNumber(height, 3)}" preserveAspectRatio="xMidYMid meet">`,
    `<title>${escapeXml(title)}</title>`,
    `<desc>Traced with VectorTrace (${source.mode} mode). ${shapes.length} object(s).</desc>`,
  ]

  if (areas.length > 0) {
    const useFill = settings.style !== 'stroke'
    const useStroke = settings.style !== 'fill'
    const attrs = [
      `fill="${useFill ? fill : 'none'}"`,
      'fill-rule="evenodd"',
      useStroke ? `stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"` : 'stroke="none"',
    ].join(' ')
    lines.push(`<g id="traced-shapes" ${attrs}>`)
    for (const shape of areas) lines.push(`<path d="${shapeToPathData(shape, precision)}"/>`)
    lines.push('</g>')
  }

  if (strokes.length > 0) {
    const uniform = uniformCenterlineWidth(source, settings)
    const groupWidth = uniform !== null ? ` stroke-width="${formatNumber(Math.max(0.01, uniform), 3)}"` : ''
    lines.push(`<g id="traced-centerlines" fill="none" stroke="${stroke}"${groupWidth} stroke-linecap="round" stroke-linejoin="round">`)
    for (const shape of strokes) {
      const own =
        uniform === null ? ` stroke-width="${formatNumber(Math.max(0.01, centerlineWidthFor(shape, source, settings)), 2)}"` : ''
      lines.push(`<path${own} d="${shapeToPathData(shape, precision)}"/>`)
    }
    lines.push('</g>')
  }

  lines.push('</svg>')
  return lines.join('\n') + '\n'
}

export function svgFileName(sourceName: string): string {
  const base = sourceName.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').trim() || 'trace'
  return `${base}-vectortrace.svg`
}
