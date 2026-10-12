import { describe, expect, it } from 'vitest'
import { computeProcessingSize } from './imageLoader'

describe('computeProcessingSize', () => {
  it('downscales large images to the max side while preserving aspect ratio', () => {
    const s = computeProcessingSize(6000, 3000, 2400)
    expect(s).toEqual({ width: 2400, height: 1200, scale: 0.4 })
  })

  it('keeps mid-sized images at native resolution', () => {
    expect(computeProcessingSize(1600, 900, 2400)).toEqual({ width: 1600, height: 900, scale: 1 })
  })

  it('upscales small images (max 4×) for smoother sub-pixel edges', () => {
    const s = computeProcessingSize(100, 50, 2400)
    expect(s.width).toBe(400)
    expect(s.height).toBe(200)
    const m = computeProcessingSize(400, 300, 2400)
    expect(m.width / m.height).toBeCloseTo(400 / 300, 2)
  })

  it('never produces a zero-sized raster and rejects invalid sizes', () => {
    const thin = computeProcessingSize(10000, 1, 2400)
    expect(thin.height).toBeGreaterThanOrEqual(1)
    expect(() => computeProcessingSize(0, 10, 2400)).toThrow()
    expect(() => computeProcessingSize(Number.NaN, 10, 2400)).toThrow()
  })
})
