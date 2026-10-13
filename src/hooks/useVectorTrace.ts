import { useCallback, useEffect, useRef, useState } from 'react'
import { computeProcessingSize, rasterize } from '../services/imageLoader'
import { sharpenInputSize } from '../services/inkSharpener'
import { TraceCancelledError, TraceClient } from '../services/traceClient'
import type { RasterInput, TraceProgress, TraceResult, TraceSettings } from '../types/vectorTrace'
import type { UploadedImage } from './useImageUpload'

export type TraceStatus = 'idle' | 'tracing' | 'done' | 'error'

interface RasterCache {
  image: UploadedImage
  maxSide: number
  sharpen: boolean
  raster: RasterInput
}

export function useVectorTrace(image: UploadedImage | null) {
  const [result, setResult] = useState<TraceResult | null>(null)
  const [status, setStatus] = useState<TraceStatus>('idle')
  const [progress, setProgress] = useState<TraceProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<TraceClient | null>(null)
  const cacheRef = useRef<RasterCache | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const client = new TraceClient()
    clientRef.current = client
    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [])

  // A new image invalidates the previous result and cached raster.
  const [prevImage, setPrevImage] = useState(image)
  if (prevImage !== image) {
    setPrevImage(image)
    setResult(null)
    setStatus('idle')
    setProgress(null)
    setError(null)
  }
  useEffect(() => {
    requestRef.current++
    clientRef.current?.cancel()
    cacheRef.current = null
  }, [image])

  const getRaster = useCallback((img: UploadedImage, maxSide: number, sharpen: boolean): RasterInput => {
    const cached = cacheRef.current
    if (cached && cached.image === img && cached.maxSide === maxSide && cached.sharpen === sharpen) return cached.raster
    const size = sharpen ? sharpenInputSize(img.width, img.height, maxSide)! : computeProcessingSize(img.width, img.height, maxSide)
    const raster = rasterize(img.bitmap, size.width, size.height)
    cacheRef.current = { image: img, maxSide, sharpen, raster }
    return raster
  }, [])

  const trace = useCallback(
    async (settings: TraceSettings) => {
      const client = clientRef.current
      if (!image || !client) return
      const requestId = ++requestRef.current
      setStatus('tracing')
      setError(null)
      setProgress({ stage: 'Preparing image', fraction: 0 })
      try {
        // Yield so the loading state paints before rasterizing on the main thread.
        await new Promise((r) => setTimeout(r, 0))
        if (requestId !== requestRef.current) return
        const sharpen = settings.aiSharpen && sharpenInputSize(image.width, image.height, settings.maxProcessingSize) !== null
        const sharpenSkipped = settings.aiSharpen && !sharpen ? 'The image is already high-resolution.' : undefined
        const raster = getRaster(image, settings.maxProcessingSize, sharpen)
        const res = await client.trace(
          { raster, sourceWidth: image.width, sourceHeight: image.height, settings, sharpen, sharpenSkipped },
          (p) => {
            if (requestId === requestRef.current) setProgress(p)
          },
        )
        if (requestId !== requestRef.current) return
        setResult(res)
        setStatus('done')
        setProgress(null)
      } catch (err) {
        if (err instanceof TraceCancelledError || requestId !== requestRef.current) return
        setStatus('error')
        setProgress(null)
        setError(err instanceof Error ? err.message : 'Tracing failed.')
      }
    },
    [image, getRaster],
  )

  const cancel = useCallback(() => {
    requestRef.current++
    clientRef.current?.cancel()
    setStatus((s) => (s === 'tracing' ? (result ? 'done' : 'idle') : s))
    setProgress(null)
  }, [result])

  const clearResult = useCallback(() => {
    requestRef.current++
    clientRef.current?.cancel()
    setResult(null)
    setStatus('idle')
    setProgress(null)
    setError(null)
  }, [])

  return { result, status, progress, error, trace, cancel, clearResult }
}
