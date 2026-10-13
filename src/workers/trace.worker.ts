import { sharpenedTraceSettings, sharpenInput, sharpenRaster } from '../services/inkSharpener'
import { getSharpenModel } from '../services/sharpenModel'
import { traceRaster } from '../services/vectorization'
import type { RasterInput, SharpenInfo, WorkerRequest, WorkerResponse } from '../types/vectorTrace'

interface TraceWorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as TraceWorkerScope

/** The last sharpened raster; retracing with new curve settings reuses it. */
let cache: { key: string; raster: RasterInput; info: SharpenInfo } | null = null

function cacheKey(req: WorkerRequest): string {
  const { raster, settings: s } = req
  let h = 2166136261
  const step = Math.max(1, Math.floor(raster.data.length / 65536))
  for (let i = 0; i < raster.data.length; i += step) h = Math.imul(h ^ raster.data[i], 16777619)
  return [raster.width, raster.height, h >>> 0, s.grayscale, s.invert, s.removeBackground, s.backgroundTolerance].join('|')
}

scope.onmessage = async (event) => {
  const req = event.data
  if (req.type !== 'trace') return
  const progress = (stage: string, fraction: number) => scope.postMessage({ type: 'progress', id: req.id, progress: { stage, fraction } })
  try {
    let raster = req.raster
    let settings = req.settings
    let sharpen: SharpenInfo | undefined
    let fresh = false
    if (req.sharpen) {
      const key = cacheKey(req)
      if (cache?.key !== key) {
        fresh = true
        const t0 = performance.now()
        progress('Loading AI sharpener', 0)
        const infer = await getSharpenModel()
        const input = sharpenInput(raster, settings)
        const res = await sharpenRaster(input, raster.width, raster.height, infer, { onProgress: (f) => progress('AI sharpening', 0.9 * f) })
        cache = { key, raster: res.raster, info: { applied: true, durationMs: performance.now() - t0, tiles: res.tiles, skippedTiles: res.skippedTiles } }
      }
      raster = cache.raster
      sharpen = cache.info
      settings = sharpenedTraceSettings(settings)
    } else if (req.sharpenSkipped) {
      sharpen = { applied: false, reason: req.sharpenSkipped, durationMs: 0, tiles: 0, skippedTiles: 0 }
    }
    const result = traceRaster({ raster, sourceWidth: req.sourceWidth, sourceHeight: req.sourceHeight, settings }, (p) =>
      scope.postMessage({ type: 'progress', id: req.id, progress: sharpen?.applied ? { ...p, fraction: 0.9 + 0.1 * p.fraction } : p }),
    )
    result.sharpen = sharpen
    if (fresh && sharpen) result.durationMs += sharpen.durationMs
    scope.postMessage({ type: 'result', id: req.id, result }, [result.bitmap.buffer as ArrayBuffer])
  } catch (err) {
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) })
  }
}
