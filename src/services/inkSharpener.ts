import type { RasterInput, TraceSettings } from '../types/vectorTrace'
import { backgroundMask, computeIntensity } from './imagePreprocessing'

/** Output pixels per input pixel of the sharpening model. */
export const SHARPEN_SCALE = 4

/**
 * Runs the model on one tile: `input` is width×height grayscale in [0, 1] (1 = paper); the result
 * is (4·width)×(4·height) ink logits.
 */
export type InferFn = (input: Float32Array, width: number, height: number) => Promise<Float32Array>

export interface SharpenOptions {
  /** Tile side in input pixels (the model sees tile + 2·overlap). */
  tile?: number
  /** Context on each side so tile seams are invisible. */
  overlap?: number
  onProgress?: (fraction: number) => void
}

export interface SharpenResult {
  raster: RasterInput
  tiles: number
  skippedTiles: number
}

/** Longest output side the sharpener will produce; larger images are traced without it. */
const MAX_SHARPEN_OUTPUT = 4800

/**
 * Size to rasterize the source at before 4× sharpening, or null when the image is already large
 * enough that sharpening would add little and cost a lot.
 */
export function sharpenInputSize(width: number, height: number, maxSide: number): { width: number; height: number; scale: number } | null {
  const longest = Math.max(width, height)
  const outLongest = Math.min(SHARPEN_SCALE * longest, Math.max(maxSide, MAX_SHARPEN_OUTPUT))
  const scale = Math.min(1, outLongest / SHARPEN_SCALE / longest)
  if (scale < 0.5) return null
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/** The model's input: 1 = paper, 0 = ink, honouring invert, alpha and background removal. */
export function sharpenInput(raster: RasterInput, settings: TraceSettings): Float32Array {
  const n = raster.width * raster.height
  const out = new Float32Array(n)
  if (settings.removeBackground) {
    const bg = backgroundMask(raster, settings.backgroundTolerance)
    for (let i = 0; i < n; i++) out[i] = bg[i] ? 1 : 0
    return out
  }
  const { gray, opaque } = computeIntensity(raster, settings.grayscale)
  for (let i = 0; i < n; i++) {
    const v = gray[i] / 255
    out[i] = !opaque[i] ? 1 : settings.invert ? 1 - v : v
  }
  return out
}

/** Settings for tracing the sharpened bitmap: it is already ink-dark on white at a 50 % threshold. */
export function sharpenedTraceSettings(settings: TraceSettings): TraceSettings {
  return { ...settings, invert: false, grayscale: true, removeBackground: false, autoThreshold: false, threshold: 128 }
}

/**
 * 4× ink sharpening of a whole raster, tile by tile. Flat tiles (blank paper or solid ink) skip
 * the model, which keeps documents with lots of white space fast.
 */
export async function sharpenRaster(input: Float32Array, width: number, height: number, infer: InferFn, opts: SharpenOptions = {}): Promise<SharpenResult> {
  const tile = opts.tile ?? 160
  const overlap = opts.overlap ?? 12
  const S = SHARPEN_SCALE
  const W = width * S
  const H = height * S
  const prob = new Float32Array(W * H)
  const cols = Math.ceil(width / tile)
  const rows = Math.ceil(height / tile)
  let done = 0
  let skipped = 0
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * tile
      const y0 = ty * tile
      const x1 = Math.min(width, x0 + tile)
      const y1 = Math.min(height, y0 + tile)
      const ax = Math.max(0, x0 - overlap)
      const ay = Math.max(0, y0 - overlap)
      const bx = Math.min(width, x1 + overlap)
      const by = Math.min(height, y1 + overlap)
      const tw = bx - ax
      const th = by - ay
      const patch = new Float32Array(tw * th)
      let lo = 1
      let hi = 0
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const v = input[(ay + y) * width + ax + x]
          patch[y * tw + x] = v
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      if (hi - lo < 0.08) {
        const fill = (lo + hi) / 2 < 0.5 ? 1 : 0
        for (let y = y0 * S; y < y1 * S; y++) prob.fill(fill, y * W + x0 * S, y * W + x1 * S)
        skipped++
      } else {
        const logits = await infer(patch, tw, th)
        const ow = tw * S
        for (let y = y0 * S; y < y1 * S; y++) {
          const row = (y - ay * S) * ow - ax * S
          for (let x = x0 * S; x < x1 * S; x++) prob[y * W + x] = 1 / (1 + Math.exp(-logits[row + x]))
        }
      }
      done++
      opts.onProgress?.(done / (rows * cols))
    }
  }
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const v = Math.round(255 * (1 - prob[i]))
    data[p] = v
    data[p + 1] = v
    data[p + 2] = v
    data[p + 3] = 255
  }
  return { raster: { data, width: W, height: H }, tiles: rows * cols, skippedTiles: skipped }
}
