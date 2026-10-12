import { DEFAULT_TRACE_SETTINGS } from '../constants/defaults'
import type { Point, RasterInput, SubPath, TraceSettings } from '../types/vectorTrace'

type Rgba = [number, number, number, number]

export function makeRaster(width: number, height: number, pixel: (x: number, y: number) => Rgba): RasterInput {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width, height }
}

export const BLACK: Rgba = [0, 0, 0, 255]
export const WHITE: Rgba = [255, 255, 255, 255]

/** Black where `inside` is true, white elsewhere. */
export function shapeRaster(width: number, height: number, inside: (x: number, y: number) => boolean): RasterInput {
  return makeRaster(width, height, (x, y) => (inside(x + 0.5, y + 0.5) ? BLACK : WHITE))
}

export function bitmapFrom(rows: string[]): { data: Uint8Array; width: number; height: number } {
  const height = rows.length
  const width = rows[0].length
  const data = new Uint8Array(width * height)
  rows.forEach((row, y) => [...row].forEach((c, x) => (data[y * width + x] = c === '#' ? 1 : 0)))
  return { data, width, height }
}

export function settings(overrides: Partial<TraceSettings> = {}): TraceSettings {
  return { ...DEFAULT_TRACE_SETTINGS, mode: 'outline', autoThreshold: false, threshold: 128, minObjectSize: 0, ...overrides }
}

/** Evaluates points along every segment of a subpath. */
export function sampleSubPath(path: SubPath, perSegment = 8): Point[] {
  const out: Point[] = []
  let cur = path.start
  for (const seg of path.segments) {
    for (let i = 1; i <= perSegment; i++) {
      const t = i / perSegment
      if (seg.type === 'L') {
        out.push({ x: cur.x + (seg.to.x - cur.x) * t, y: cur.y + (seg.to.y - cur.y) * t })
      } else {
        const mt = 1 - t
        out.push({
          x: mt ** 3 * cur.x + 3 * mt * mt * t * seg.c1.x + 3 * mt * t * t * seg.c2.x + t ** 3 * seg.to.x,
          y: mt ** 3 * cur.y + 3 * mt * mt * t * seg.c1.y + 3 * mt * t * t * seg.c2.y + t ** 3 * seg.to.y,
        })
      }
    }
    cur = seg.to
  }
  return out
}
