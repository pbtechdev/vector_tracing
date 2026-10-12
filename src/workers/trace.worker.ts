import { traceRaster } from '../services/vectorization'
import type { WorkerRequest, WorkerResponse } from '../types/vectorTrace'

interface TraceWorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as TraceWorkerScope

scope.onmessage = (event) => {
  const req = event.data
  if (req.type !== 'trace') return
  try {
    const result = traceRaster(
      { raster: req.raster, sourceWidth: req.sourceWidth, sourceHeight: req.sourceHeight, settings: req.settings },
      (progress) => scope.postMessage({ type: 'progress', id: req.id, progress }),
    )
    scope.postMessage({ type: 'result', id: req.id, result }, [result.bitmap.buffer as ArrayBuffer])
  } catch (err) {
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) })
  }
}
