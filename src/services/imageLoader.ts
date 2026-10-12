import type { RasterInput } from '../types/vectorTrace'

export interface ProcessingSize {
  width: number
  height: number
  /** Processing pixels per source pixel. */
  scale: number
}

const MIN_PROCESSING_SIDE = 600
const UPSCALE_TARGET = 1200
const MAX_UPSCALE = 4

/**
 * Chooses the raster size used for tracing. Large images are downscaled to `maxSide`;
 * small images are upscaled (smooth interpolation gives better sub-pixel edges).
 * The aspect ratio is preserved; geometry is mapped back to source pixels afterwards.
 */
export function computeProcessingSize(width: number, height: number, maxSide: number): ProcessingSize {
  if (!(width > 0) || !(height > 0)) throw new Error('Image dimensions must be positive.')
  const longest = Math.max(width, height)
  let scale = 1
  if (longest > maxSide) scale = maxSide / longest
  else if (longest < MIN_PROCESSING_SIDE) scale = Math.min(MAX_UPSCALE, UPSCALE_TARGET / longest, maxSide / longest)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

export type DecodedImage = ImageBitmap

export async function decodeImage(file: Blob): Promise<DecodedImage> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('The image could not be decoded. The file may be corrupt or use an unsupported encoding.')
  }
}

/** Draws the image at the given size and returns its RGBA pixels. */
export function rasterize(source: CanvasImageSource, width: number, height: number): RasterInput {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  const img = ctx.getImageData(0, 0, width, height)
  return { data: img.data, width, height }
}
