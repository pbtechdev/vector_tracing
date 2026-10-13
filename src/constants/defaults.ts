import type { ExportSettings, FillStyle, LineEndMode, TraceMode, TraceSettings } from '../types/vectorTrace'

export const DEFAULT_TRACE_SETTINGS: TraceSettings = {
  mode: 'centerline',
  threshold: 128,
  autoThreshold: true,
  smoothing: 4,
  detail: 70,
  cornerAngle: 125,
  minObjectSize: 16,
  invert: false,
  grayscale: true,
  removeBackground: false,
  backgroundTolerance: 40,
  fillHoles: false,
  maxProcessingSize: 2400,
  spurLength: 4,
  lineEnds: 'cap',
  joinStrokes: true,
  joinAngle: 40,
  gapClosing: 0,
  straightEdges: true,
  fitArcs: true,
  aiSharpen: false,
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  style: 'stroke',
  fillColor: '#000000',
  strokeColor: '#000000',
  strokeWidth: 1,
  centerlineWidth: 'detected',
  unit: 'px',
  dpi: 96,
  precision: 2,
}

export const MODE_DEFAULT_STYLE: Record<TraceMode, FillStyle> = {
  outline: 'stroke',
  lineart: 'fill',
  silhouette: 'fill',
  centerline: 'stroke',
}

export interface ModeInfo {
  id: TraceMode
  label: string
  description: string
}

export const TRACE_MODES: ModeInfo[] = [
  {
    id: 'centerline',
    label: 'Centerline',
    description:
      'Finds the centre of every stroke and traces it as a single open path (or closed loop) with its measured width. Ideal for line drawings, handwriting, sketches, plotting, engraving and single-line fonts.',
  },
  {
    id: 'outline',
    label: 'Outline',
    description:
      'Traces outer boundaries and holes of every dark region as closed paths. Exported as outlines by default.',
  },
  {
    id: 'lineart',
    label: 'Line art',
    description:
      'Uses local (adaptive) thresholding so shading and paper tone are not filled in; large solid areas become outlined rings rather than filled blobs. Each stroke becomes a filled shape bounded by two contours (its inner and outer edge), not a single centre line.',
  },
  {
    id: 'silhouette',
    label: 'Silhouette',
    description:
      'Cleans the foreground with morphological closing and produces solid closed shapes with holes — suited to cutting and engraving.',
  },
]

export const LINE_END_MODES: { id: LineEndMode; label: string; hint: string }[] = [
  { id: 'cap', label: 'Match stroke (round cap)', hint: 'Ends stop half a stroke width before the tip, so a round-capped stroke reproduces the original length.' },
  { id: 'tip', label: 'Extend to tip', hint: 'Lines run all the way to the visible tip — best for pen plotters and single-line engraving.' },
  { id: 'none', label: 'Raw skeleton', hint: 'Keeps the thinned skeleton ends unchanged (shorter than the original strokes).' },
]

export const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const
export const MAX_FILE_BYTES = 40 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 80_000_000
