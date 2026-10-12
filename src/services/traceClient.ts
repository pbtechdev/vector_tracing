import type { RasterInput, TraceProgress, TraceResult, TraceSettings, WorkerResponse } from '../types/vectorTrace'

export class TraceCancelledError extends Error {
  constructor() {
    super('Trace cancelled')
    this.name = 'TraceCancelledError'
  }
}

interface PendingJob {
  id: number
  resolve: (r: TraceResult) => void
  reject: (e: Error) => void
  onProgress?: (p: TraceProgress) => void
}

export interface TraceJob {
  raster: RasterInput
  sourceWidth: number
  sourceHeight: number
  settings: TraceSettings
}

/**
 * Runs traces in a dedicated Web Worker. Starting a new trace while one is running
 * terminates the old worker, so a stale result can never arrive after a newer request.
 */
export class TraceClient {
  private worker: Worker | null = null
  private pending: PendingJob | null = null
  private nextId = 1

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('../workers/trace.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data)
    worker.onerror = (event) => {
      event.preventDefault()
      const job = this.pending
      this.pending = null
      this.terminate()
      job?.reject(new Error(event.message || 'The tracing worker crashed. The image may be too large.'))
    }
    this.worker = worker
    return worker
  }

  private handleMessage(msg: WorkerResponse): void {
    const job = this.pending
    if (!job || msg.id !== job.id) return
    if (msg.type === 'progress') {
      job.onProgress?.(msg.progress)
      return
    }
    this.pending = null
    if (msg.type === 'result') job.resolve(msg.result)
    else job.reject(new Error(msg.message))
  }

  trace(job: TraceJob, onProgress?: (p: TraceProgress) => void): Promise<TraceResult> {
    this.cancel()
    const id = this.nextId++
    const worker = this.ensureWorker()
    return new Promise<TraceResult>((resolve, reject) => {
      this.pending = { id, resolve, reject, onProgress }
      // Copy the pixels so the caller's cached raster survives the transfer.
      const data = new Uint8ClampedArray(job.raster.data)
      worker.postMessage(
        {
          type: 'trace',
          id,
          raster: { data, width: job.raster.width, height: job.raster.height },
          sourceWidth: job.sourceWidth,
          sourceHeight: job.sourceHeight,
          settings: job.settings,
        },
        [data.buffer],
      )
    })
  }

  /** Aborts the running trace, if any. */
  cancel(): void {
    if (!this.pending) return
    const job = this.pending
    this.pending = null
    this.terminate()
    job.reject(new TraceCancelledError())
  }

  private terminate(): void {
    this.worker?.terminate()
    this.worker = null
  }

  dispose(): void {
    this.cancel()
    this.terminate()
  }
}
