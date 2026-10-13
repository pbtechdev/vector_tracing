export interface Point {
  x: number
  y: number
}

export type TraceMode = 'outline' | 'lineart' | 'silhouette' | 'centerline'

export interface TraceSettings {
  mode: TraceMode
  /** Global threshold, 0–255. Pixels darker than this become foreground. */
  threshold: number
  /** Pick the threshold automatically with Otsu's method. */
  autoThreshold: boolean
  /** 0–10. Controls contour smoothing iterations (and morphology for silhouettes). */
  smoothing: number
  /** 0–100. Higher = tighter curve fit and more nodes. */
  detail: number
  /** Degrees, 60–175. Interior angles sharper than this are kept as corners. */
  cornerAngle: number
  /** Minimum object/hole area in source-image pixels; smaller specks are removed. */
  minObjectSize: number
  invert: boolean
  /** Use luminance; when off, the darkest RGB channel is used so saturated colours count as ink. */
  grayscale: boolean
  /** Flood-fill the background from the image border instead of using the threshold. */
  removeBackground: boolean
  /** Colour distance (0–255) for background removal. */
  backgroundTolerance: number
  /** Silhouette only: fill every interior hole. */
  fillHoles: boolean
  /** Longest side used for processing, in pixels. */
  maxProcessingSize: number
  /** Centerline: extra branch length (source px) pruned beyond the automatic, width-relative limit. */
  spurLength: number
  /** Centerline: how open stroke ends are restored after thinning. */
  lineEnds: LineEndMode
  /** Centerline: continue strokes straight through junctions instead of splitting there. */
  joinStrokes: boolean
  /** Centerline: max bend (degrees) for continuing a stroke through a junction. */
  joinAngle: number
  /** Centerline: bridge gaps up to this length (source px) between aligned line ends. 0 = off. */
  gapClosing: number
  /** Fit straight edges and put sharp corners where they meet (gear teeth, polygons). */
  straightEdges: boolean
  /** Fit exact circles and circular arcs (holes, bores, fillets). */
  fitArcs: boolean
  /** Rebuild small or blurry images at 4× with the bundled neural sharpener before tracing. */
  aiSharpen: boolean
}

export interface SharpenInfo {
  applied: boolean
  /** Why sharpening was not applied. */
  reason?: string
  durationMs: number
  tiles: number
  skippedTiles: number
}

/**
 * `cap`: end where a round-capped stroke of the detected width reproduces the original end.
 * `tip`: extend to the very tip of the stroke (plotters, engraving).
 * `none`: keep the raw skeleton ends.
 */
export type LineEndMode = 'cap' | 'tip' | 'none'

export type PathSegment =
  | { type: 'L'; to: Point }
  | { type: 'C'; c1: Point; c2: Point; to: Point }

export interface SubPath {
  start: Point
  segments: PathSegment[]
  closed: boolean
}

/** One exported <path>. Closed shapes may contain holes as extra subpaths. */
export interface VectorShape {
  kind: 'area' | 'stroke'
  subpaths: SubPath[]
  /** Measured stroke width (source px) for centerline strokes. */
  strokeWidth?: number
}

export interface TraceStats {
  shapeCount: number
  subpathCount: number
  nodeCount: number
  curveCount: number
  lineCount: number
  /** Detected geometric primitives (straight edges, arcs, full circles). */
  primitives: { lines: number; arcs: number; circles: number }
}

export interface TraceResult {
  mode: TraceMode
  /** Source image dimensions; all geometry is in this coordinate space. */
  width: number
  height: number
  processingWidth: number
  processingHeight: number
  shapes: VectorShape[]
  stats: TraceStats
  thresholdUsed: number
  /** Fraction of processed pixels classified as foreground. */
  foregroundRatio: number
  /** Suggested stroke width (source px) for centerline output. */
  estimatedStrokeWidth: number
  /** The binary bitmap that was traced, at processing resolution (1 = foreground). */
  bitmap: Uint8Array
  durationMs: number
  warnings: string[]
  /** Present when AI sharpening was requested. */
  sharpen?: SharpenInfo
}

export type FillStyle = 'fill' | 'stroke' | 'fill-stroke'
export type ExportUnit = 'px' | 'mm' | 'in'

/** How centerline stroke widths are chosen. */
export type StrokeWidthMode = 'detected' | 'per-path' | 'custom'

export interface ExportSettings {
  style: FillStyle
  fillColor: string
  strokeColor: string
  /** Stroke width in source pixels (outlines, and centerlines in `custom` mode). */
  strokeWidth: number
  centerlineWidth: StrokeWidthMode
  unit: ExportUnit
  dpi: number
  /** Decimal places for coordinates (0–3). */
  precision: number
}

export interface RasterInput {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface TraceProgress {
  stage: string
  /** 0–1 */
  fraction: number
}

export type WorkerRequest = {
  type: 'trace'
  id: number
  raster: RasterInput
  sourceWidth: number
  sourceHeight: number
  settings: TraceSettings
  /** The raster is at sharpener input size and must be sharpened 4× before tracing. */
  sharpen: boolean
  /** Set when sharpening was requested but not possible for this image. */
  sharpenSkipped?: string
}

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: TraceProgress }
  | { type: 'result'; id: number; result: TraceResult }
  | { type: 'error'; id: number; message: string }
