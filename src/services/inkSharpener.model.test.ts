import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Point, RasterInput } from '../types/vectorTrace'
import { settings } from '../test/helpers'
import { type InferFn, SHARPEN_SCALE, sharpenedTraceSettings, sharpenInput, sharpenRaster } from './inkSharpener'
import { traceRaster } from './vectorization'

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** Anti-aliased low-res rendering of a stroked polyline, then blurred: a soft, tiny scan. */
function blurryStroke(w: number, h: number, line: Point[], halfWidth: number): RasterInput {
  const ss = 4
  const cov = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const p = { x: x + (i + 0.5) / ss, y: y + (j + 0.5) / ss }
          if (line.some((v, k) => k < line.length - 1 && segDist(p, v, line[k + 1]) < halfWidth)) n++
        }
      }
      cov[y * w + x] = n / (ss * ss)
    }
  }
  const k = [0.25, 0.5, 0.25]
  const blur = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let t = -1; t <= 1; t++) {
          const sx = Math.min(w - 1, Math.max(0, x + t * dx))
          const sy = Math.min(h - 1, Math.max(0, y + t * dy))
          s += k[t + 1] * src[sy * w + sx]
        }
        out[y * w + x] = s
      }
    }
    return out
  }
  const soft = blur(blur(cov, 1, 0), 0, 1)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(250 - 230 * soft[i])
    data.set([v, v, v, 255], i * 4)
  }
  return { data, width: w, height: h }
}

let infer: InferFn

beforeAll(async () => {
  const ort = await import('onnxruntime-web')
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync('public/models/ink-sharpener-x4.onnx')))
  infer = async (input, w, h) => (await session.run({ image: new ort.Tensor('float32', input, [1, 1, h, w]) })).ink.data as Float32Array
})

describe('bundled ink sharpener model', () => {
  it('turns a tiny blurry zigzag into straight strokes with sharp vertices', async () => {
    // 8 px period, 4 px tall, ~1.6 px stroke: the case where plain tracing flattens it to a line.
    const zz: Point[] = []
    for (let x = 4; x <= 76; x += 4) zz.push({ x, y: (x / 4) % 2 === 0 ? 10 : 14 })
    const raster = blurryStroke(80, 24, zz, 0.8)
    const s = settings({ mode: 'centerline' })

    const missOf = (shapes: ReturnType<typeof traceRaster>['shapes']): number => {
      const nodes = shapes.flatMap((sh) => sh.subpaths.flatMap((p) => [p.start, ...p.segments.map((q) => q.to)]))
      return Math.max(...zz.slice(1, -1).map((v) => Math.min(...nodes.map((n) => Math.hypot(n.x - v.x, n.y - v.y)))))
    }

    const plain = traceRaster({ raster, sourceWidth: 80, sourceHeight: 24, settings: s })
    const sharp = await sharpenRaster(sharpenInput(raster, s), raster.width, raster.height, infer)
    expect(sharp.raster.width).toBe(80 * SHARPEN_SCALE)
    const ai = traceRaster({ raster: sharp.raster, sourceWidth: 80, sourceHeight: 24, settings: sharpenedTraceSettings(s), detailScale: 1 })
    if (process.env.DUMP) {
      const { writeGrayPng } = await import('../test/png')
      const g = (r: RasterInput) => Array.from({ length: r.width * r.height }, (_, i) => r.data[i * 4])
      writeGrayPng('/tmp/zz-in.png', g(raster), raster.width, raster.height)
      writeGrayPng('/tmp/zz-ai.png', g(sharp.raster), sharp.raster.width, sharp.raster.height)
      console.log('plain', missOf(plain.shapes), 'ai', missOf(ai.shapes), ai.shapes.map((x) => x.subpaths.map((p) => p.segments.map((q) => q.type).join(''))))
    }

    expect(missOf(plain.shapes)).toBeGreaterThan(1.5)
    expect(missOf(ai.shapes)).toBeLessThan(1)
    // Every point of the AI trace lies on the true zigzag.
    for (const sh of ai.shapes) {
      for (const p of sh.subpaths) {
        for (const q of [p.start, ...p.segments.map((g) => g.to)]) {
          expect(Math.min(...zz.slice(0, -1).map((v, i) => segDist(q, v, zz[i + 1])))).toBeLessThan(0.8)
        }
      }
    }
  }, 30000)
})
