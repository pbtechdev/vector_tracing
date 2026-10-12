import { describe, expect, it } from 'vitest'
import { BLACK, WHITE, bitmapFrom, makeRaster, settings, shapeRaster } from '../test/helpers'
import {
  backgroundMask,
  close,
  computeIntensity,
  filterComponents,
  otsuThreshold,
  preprocess,
  thresholdGlobal,
} from './imagePreprocessing'

describe('computeIntensity', () => {
  it('composites transparent pixels over white and marks them non-opaque', () => {
    const raster = makeRaster(2, 1, (x) => (x === 0 ? [0, 0, 0, 0] : [0, 0, 0, 255]))
    const { gray, opaque } = computeIntensity(raster, true)
    expect(gray[0]).toBe(255)
    expect(opaque[0]).toBe(0)
    expect(gray[1]).toBe(0)
    expect(opaque[1]).toBe(1)
  })

  it('uses luminance or the darkest channel', () => {
    const red = makeRaster(1, 1, () => [255, 0, 0, 255])
    expect(computeIntensity(red, true).gray[0]).toBe(76)
    expect(computeIntensity(red, false).gray[0]).toBe(0)
  })

  it('rejects inconsistent raster sizes', () => {
    expect(() => computeIntensity({ data: new Uint8ClampedArray(4), width: 2, height: 2 }, true)).toThrow()
  })
})

describe('thresholding', () => {
  it('thresholdGlobal marks pixels darker than the threshold', () => {
    const out = thresholdGlobal(new Uint8Array([0, 127, 128, 255]), 128)
    expect([...out]).toEqual([1, 1, 0, 0])
  })

  it('otsu separates a bimodal histogram', () => {
    const gray = new Uint8Array(200)
    gray.fill(30, 0, 100)
    gray.fill(220, 100)
    const t = otsuThreshold(gray)
    expect(t).toBeGreaterThan(30)
    expect(t).toBeLessThanOrEqual(220)
    expect(thresholdGlobal(gray, t).reduce((a, b) => a + b, 0)).toBe(100)
  })
})

describe('preprocess', () => {
  const square = shapeRaster(20, 20, (x, y) => x > 5 && x < 15 && y > 5 && y < 15)

  it('produces a bitmap of the same size with the shape as foreground', () => {
    const { bitmap, foregroundRatio } = preprocess(square, settings())
    expect(bitmap.width).toBe(20)
    expect(bitmap.height).toBe(20)
    expect(bitmap.data[10 * 20 + 10]).toBe(1)
    expect(bitmap.data[0]).toBe(0)
    expect(foregroundRatio).toBeCloseTo(100 / 400, 5)
  })

  it('inverts foreground and background', () => {
    const { bitmap } = preprocess(square, settings({ invert: true }))
    expect(bitmap.data[10 * 20 + 10]).toBe(0)
    expect(bitmap.data[0]).toBe(1)
  })

  it('never treats transparent pixels as foreground, even when inverted', () => {
    const raster = makeRaster(4, 4, (x) => (x < 2 ? [0, 0, 0, 0] : WHITE))
    const { bitmap } = preprocess(raster, settings({ invert: true }))
    expect(bitmap.data[0]).toBe(0)
    expect(bitmap.data[3]).toBe(1)
  })

  it('removes specks smaller than the minimum object size and fills small holes', () => {
    const raster = makeRaster(30, 30, (x, y) => {
      if (x === 2 && y === 2) return BLACK // 1px speck
      const inBlock = x >= 10 && x < 25 && y >= 10 && y < 25
      const pinhole = x === 17 && y === 17
      return inBlock && !pinhole ? BLACK : WHITE
    })
    const { bitmap } = preprocess(raster, settings({ minObjectSize: 4 }))
    expect(bitmap.data[2 * 30 + 2]).toBe(0)
    expect(bitmap.data[17 * 30 + 17]).toBe(1)
    expect(bitmap.data[12 * 30 + 12]).toBe(1)
  })

  it('line-art mode does not fill the interior of large dark areas', () => {
    const raster = shapeRaster(200, 200, (x, y) => x > 50 && x < 150 && y > 50 && y < 150)
    const { bitmap } = preprocess(raster, settings({ mode: 'lineart' }))
    expect(bitmap.data[100 * 200 + 100]).toBe(0)
    expect(bitmap.data[100 * 200 + 51]).toBe(1)
  })

  it('reports a warning for an empty image', () => {
    const blank = makeRaster(10, 10, () => WHITE)
    const { warnings, foregroundRatio } = preprocess(blank, settings())
    expect(foregroundRatio).toBe(0)
    expect(warnings[0]).toMatch(/No foreground/)
  })

  it('throws for zero-sized input', () => {
    expect(() => preprocess({ data: new Uint8ClampedArray(), width: 0, height: 0 }, settings())).toThrow()
  })

  it('silhouette mode can fill all holes', () => {
    const ring = shapeRaster(40, 40, (x, y) => {
      const d = Math.hypot(x - 20, y - 20)
      return d < 15 && d > 8
    })
    const kept = preprocess(ring, settings({ mode: 'silhouette', smoothing: 0 }))
    expect(kept.bitmap.data[20 * 40 + 20]).toBe(0)
    const filled = preprocess(ring, settings({ mode: 'silhouette', smoothing: 0, fillHoles: true }))
    expect(filled.bitmap.data[20 * 40 + 20]).toBe(1)
  })
})

describe('background removal', () => {
  it('flood-fills the border colour but keeps enclosed regions of the same colour', () => {
    // Blue background, red ring with a blue centre.
    const raster = makeRaster(30, 30, (x, y) => {
      const d = Math.hypot(x - 15, y - 15)
      return d < 10 && d > 5 ? [220, 20, 20, 255] : [20, 40, 220, 255]
    })
    const bg = backgroundMask(raster, 30)
    expect(bg[0]).toBe(1)
    expect(bg[15 * 30 + 15]).toBe(0)
    expect(bg[15 * 30 + 7]).toBe(0)
  })
})

describe('morphology and components', () => {
  it('closing bridges a one-pixel gap', () => {
    const bmp = bitmapFrom(['.......', '.##.##.', '.##.##.', '.......'])
    const closed = close(bmp, 1)
    expect(closed.data[1 * 7 + 3]).toBe(1)
  })

  it('filterComponents uses 8-connectivity for foreground', () => {
    const bmp = bitmapFrom(['#...', '.#..', '..#.', '....'])
    const flipped = filterComponents(bmp, 1, (area) => area < 3)
    expect(flipped).toBe(0)
  })
})
