import type { RasterInput, TraceSettings } from '../types/vectorTrace'

/** Binary image: 1 = foreground (ink), 0 = background. Row-major. */
export interface Bitmap {
  data: Uint8Array
  width: number
  height: number
}

export interface Intensity {
  /** 0 (dark) – 255 (light), alpha-composited over white. */
  gray: Uint8Array
  /** 1 where the pixel is at least half opaque. */
  opaque: Uint8Array
}

export function computeIntensity(raster: RasterInput, useLuminance: boolean): Intensity {
  const { data, width, height } = raster
  const n = width * height
  if (data.length < n * 4) throw new Error('Raster data is smaller than width × height × 4.')
  const gray = new Uint8Array(n)
  const opaque = new Uint8Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const a = data[p + 3] / 255
    const v = useLuminance ? 0.299 * r + 0.587 * g + 0.114 * b : Math.min(r, g, b)
    gray[i] = Math.round(v * a + 255 * (1 - a))
    opaque[i] = data[p + 3] >= 128 ? 1 : 0
  }
  return { gray, opaque }
}

/**
 * Otsu's method. Returns a threshold T such that `gray < T` is the dark class.
 * Only pixels where `mask` is 1 are considered (all pixels when omitted).
 */
export function otsuThreshold(gray: Uint8Array, mask?: Uint8Array): number {
  const hist = new Float64Array(256)
  let total = 0
  for (let i = 0; i < gray.length; i++) {
    if (mask && !mask[i]) continue
    hist[gray[i]]++
    total++
  }
  if (total === 0) return 128
  let sumAll = 0
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]

  let sumB = 0
  let wB = 0
  let best = -1
  let bestT = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      bestT = t
    }
  }
  return Math.min(255, Math.max(1, bestT + 1))
}

export function thresholdGlobal(gray: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < threshold ? 1 : 0
  return out
}

/**
 * Foreground where the pixel is darker than its local mean by `offset`
 * and darker than the global `ceiling`. Prevents large shaded areas from filling.
 */
export function thresholdAdaptive(
  gray: Uint8Array,
  width: number,
  height: number,
  windowRadius: number,
  offset: number,
  ceiling: number,
): Uint8Array {
  const iw = width + 1
  const integral = new Float64Array(iw * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x]
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + rowSum
    }
  }
  const out = new Uint8Array(width * height)
  const r = Math.max(1, Math.round(windowRadius))
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(width, x + r + 1)
      const sum = integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0]
      const mean = sum / ((x1 - x0) * (y1 - y0))
      const v = gray[y * width + x]
      out[y * width + x] = v < ceiling && v < mean - offset ? 1 : 0
    }
  }
  return out
}

/**
 * Flood-fills from the image border over pixels similar to the dominant border colour
 * (or transparent). Returns 1 for background pixels.
 */
export function backgroundMask(raster: RasterInput, tolerance: number): Uint8Array {
  const { data, width, height } = raster
  const n = width * height
  const borderIdx: number[] = []
  for (let x = 0; x < width; x++) {
    borderIdx.push(x, (height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    borderIdx.push(y * width, y * width + width - 1)
  }

  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (const i of borderIdx) {
    if (data[i * 4 + 3] >= 128) {
      rs.push(data[i * 4])
      gs.push(data[i * 4 + 1])
      bs.push(data[i * 4 + 2])
    }
  }
  const median = (arr: number[]): number => {
    if (arr.length === 0) return 255
    const s = [...arr].sort((a, b) => a - b)
    return s[s.length >> 1]
  }
  const ref = [median(rs), median(gs), median(bs)]

  const isBg = (i: number): boolean => {
    const p = i * 4
    if (data[p + 3] < 128) return true
    return (
      Math.max(Math.abs(data[p] - ref[0]), Math.abs(data[p + 1] - ref[1]), Math.abs(data[p + 2] - ref[2])) <= tolerance
    )
  }

  const mask = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  for (const i of borderIdx) {
    if (!mask[i] && isBg(i)) {
      mask[i] = 1
      queue[tail++] = i
    }
  }
  while (head < tail) {
    const i = queue[head++]
    const x = i % width
    const y = (i - x) / width
    if (x > 0 && !mask[i - 1] && isBg(i - 1)) {
      mask[i - 1] = 1
      queue[tail++] = i - 1
    }
    if (x < width - 1 && !mask[i + 1] && isBg(i + 1)) {
      mask[i + 1] = 1
      queue[tail++] = i + 1
    }
    if (y > 0 && !mask[i - width] && isBg(i - width)) {
      mask[i - width] = 1
      queue[tail++] = i - width
    }
    if (y < height - 1 && !mask[i + width] && isBg(i + width)) {
      mask[i + width] = 1
      queue[tail++] = i + width
    }
  }
  return mask
}

/**
 * Flips connected components of `target` value for which `shouldFlip(area, touchesBorder)` is true.
 * Foreground (1) uses 8-connectivity and background (0) uses 4-connectivity, matching the contour tracer.
 */
export function filterComponents(
  bitmap: Bitmap,
  target: 0 | 1,
  shouldFlip: (area: number, touchesBorder: boolean) => boolean,
): number {
  const { data, width, height } = bitmap
  const n = width * height
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const members: number[] = []
  const eight = target === 1
  let flipped = 0

  for (let start = 0; start < n; start++) {
    if (seen[start] || data[start] !== target) continue
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    members.length = 0
    let touches = false
    while (sp > 0) {
      const i = stack[--sp]
      members.push(i)
      const x = i % width
      const y = (i - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          if (!eight && dx !== 0 && dy !== 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const j = ny * width + nx
          if (!seen[j] && data[j] === target) {
            seen[j] = 1
            stack[sp++] = j
          }
        }
      }
    }
    if (shouldFlip(members.length, touches)) {
      const v = target === 1 ? 0 : 1
      for (const i of members) data[i] = v
      flipped++
    }
  }
  return flipped
}

function slidingCount(src: Uint8Array, width: number, height: number, r: number, horizontal: boolean, erode: boolean): Uint8Array {
  const out = new Uint8Array(src.length)
  const len = horizontal ? width : height
  const lines = horizontal ? height : width
  const prefix = new Int32Array(len + 1)
  for (let l = 0; l < lines; l++) {
    for (let k = 0; k < len; k++) {
      const idx = horizontal ? l * width + k : k * width + l
      prefix[k + 1] = prefix[k] + src[idx]
    }
    for (let k = 0; k < len; k++) {
      const a = Math.max(0, k - r)
      const b = Math.min(len, k + r + 1)
      const count = prefix[b] - prefix[a]
      const idx = horizontal ? l * width + k : k * width + l
      out[idx] = erode ? (count === b - a ? 1 : 0) : count > 0 ? 1 : 0
    }
  }
  return out
}

export function dilate(bitmap: Bitmap, radius: number): Bitmap {
  if (radius <= 0) return bitmap
  const { width, height } = bitmap
  const h = slidingCount(bitmap.data, width, height, radius, true, false)
  return { width, height, data: slidingCount(h, width, height, radius, false, false) }
}

export function erode(bitmap: Bitmap, radius: number): Bitmap {
  if (radius <= 0) return bitmap
  const { width, height } = bitmap
  const h = slidingCount(bitmap.data, width, height, radius, true, true)
  return { width, height, data: slidingCount(h, width, height, radius, false, true) }
}

/** Morphological closing: bridges small gaps and smooths concavities. */
export function close(bitmap: Bitmap, radius: number): Bitmap {
  return erode(dilate(bitmap, radius), radius)
}

export interface PreprocessResult {
  bitmap: Bitmap
  /** Threshold that was applied, or -1 when background removal replaced thresholding. */
  thresholdUsed: number
  foregroundRatio: number
  warnings: string[]
}

/**
 * Converts a raster into the binary bitmap to trace.
 * @param scale processing pixels per source pixel (used to scale area-based settings).
 */
export function preprocess(raster: RasterInput, settings: TraceSettings, scale = 1): PreprocessResult {
  const { width, height } = raster
  if (width <= 0 || height <= 0) throw new Error('Image has no pixels.')
  const n = width * height
  const warnings: string[] = []
  const { gray, opaque } = computeIntensity(raster, settings.grayscale)

  let fg: Uint8Array
  let thresholdUsed: number
  if (settings.removeBackground) {
    const bg = backgroundMask(raster, settings.backgroundTolerance)
    fg = new Uint8Array(n)
    for (let i = 0; i < n; i++) fg[i] = bg[i] ? 0 : 1
    thresholdUsed = -1
  } else {
    thresholdUsed = settings.autoThreshold ? otsuThreshold(gray, opaque) : settings.threshold
    if (settings.mode === 'lineart') {
      const radius = Math.max(7, Math.round(Math.min(width, height) / 20))
      const offset = 2 + ((100 - settings.detail) / 100) * 18
      fg = thresholdAdaptive(gray, width, height, radius, offset, thresholdUsed)
    } else {
      fg = thresholdGlobal(gray, thresholdUsed)
    }
  }

  for (let i = 0; i < n; i++) {
    let v = fg[i]
    if (settings.invert) v = v ? 0 : 1
    fg[i] = opaque[i] ? v : 0
  }

  let bitmap: Bitmap = { data: fg, width, height }

  if (settings.mode === 'silhouette') {
    const r = Math.round((settings.smoothing / 10) * 3 * Math.max(1, scale))
    if (r > 0) bitmap = close(bitmap, r)
  } else if (settings.mode === 'centerline') {
    // Fills pinholes and edge notches that would otherwise become tiny skeleton loops.
    const r = Math.floor((settings.smoothing / 4) * Math.max(1, scale))
    if (r > 0) bitmap = close(bitmap, Math.min(r, 3))
  }

  const minArea = Math.max(0, settings.minObjectSize) * scale * scale
  if (minArea >= 1) {
    filterComponents(bitmap, 1, (area) => area < minArea)
    filterComponents(bitmap, 0, (area, touches) => !touches && area < minArea)
  }
  if (settings.mode === 'silhouette' && settings.fillHoles) {
    filterComponents(bitmap, 0, (_area, touches) => !touches)
  }

  let count = 0
  for (let i = 0; i < n; i++) count += bitmap.data[i]
  const foregroundRatio = count / n
  if (count === 0) {
    warnings.push('No foreground was found. Try adjusting the threshold, toggling Invert, or lowering noise removal.')
  } else if (foregroundRatio > 0.85) {
    warnings.push('Most of the image is foreground. If the background was traced, try Invert or Remove background.')
  }

  return { bitmap, thresholdUsed, foregroundRatio, warnings }
}
