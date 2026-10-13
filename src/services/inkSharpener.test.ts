import { describe, expect, it } from 'vitest'
import { settings } from '../test/helpers'
import { SHARPEN_SCALE, type InferFn, sharpenInput, sharpenInputSize, sharpenRaster } from './inkSharpener'

/** A stand-in model whose output depends on neighbouring pixels, so tile seams would show. */
const blurModel: InferFn = async (input, w, h) => {
  const S = SHARPEN_SCALE
  const out = new Float32Array(w * S * h * S)
  for (let y = 0; y < h * S; y++) {
    for (let x = 0; x < w * S; x++) {
      const cx = Math.floor(x / S)
      const cy = Math.floor(y / S)
      let sum = 0
      let n = 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const sx = cx + dx
          const sy = cy + dy
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
          sum += input[sy * w + sx]
          n++
        }
      }
      out[y * w * S + x] = (0.5 - sum / n) * 20
    }
  }
  return out
}

function pattern(w: number, h: number): Float32Array {
  const img = new Float32Array(w * h).fill(1)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x * 7 + y * 3) % 11 < 4 && x > 5 && x < w - 5) img[y * w + x] = 0.1
  return img
}

describe('sharpenInputSize', () => {
  it('keeps small images at native size and skips large ones', () => {
    expect(sharpenInputSize(400, 300, 2400)).toEqual({ width: 400, height: 300, scale: 1 })
    expect(sharpenInputSize(2000, 1000, 2400)?.width).toBe(1200)
    expect(sharpenInputSize(3000, 2000, 2400)).toBeNull()
  })
})

describe('sharpenRaster', () => {
  it('produces the same result tile by tile as on the whole image', async () => {
    const w = 70
    const h = 45
    const img = pattern(w, h)
    const whole = await sharpenRaster(img, w, h, blurModel, { tile: 1000, overlap: 0 })
    const tiled = await sharpenRaster(img, w, h, blurModel, { tile: 16, overlap: 3 })
    expect(tiled.raster.width).toBe(w * SHARPEN_SCALE)
    expect(tiled.raster.height).toBe(h * SHARPEN_SCALE)
    expect(tiled.tiles).toBe(15)
    expect(Array.from(tiled.raster.data)).toEqual(Array.from(whole.raster.data))
  })

  it('skips flat tiles without calling the model', async () => {
    const w = 64
    const h = 32
    const img = new Float32Array(w * h).fill(0.97)
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) img[(y + 4) * w + x + 4] = 0.05
    let calls = 0
    const counting: InferFn = (input, tw, th) => {
      calls++
      return blurModel(input, tw, th)
    }
    const res = await sharpenRaster(img, w, h, counting, { tile: 16, overlap: 2 })
    expect(res.tiles).toBe(8)
    expect(calls).toBe(1)
    expect(res.skippedTiles).toBe(7)
    // Paper stays white in skipped tiles.
    const last = res.raster.data.length - 4
    expect(res.raster.data[last]).toBe(255)
  })
})

describe('sharpenInput', () => {
  it('maps ink to 0, paper and transparency to 1, and honours invert', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0])
    const raster = { data, width: 3, height: 1 }
    expect(Array.from(sharpenInput(raster, settings()))).toEqual([0, 1, 1])
    expect(Array.from(sharpenInput(raster, settings({ invert: true })))).toEqual([1, 0, 1])
  })
})
