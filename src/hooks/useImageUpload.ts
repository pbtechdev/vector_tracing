import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_IMAGE_PIXELS } from '../constants/defaults'
import { type DecodedImage, decodeImage } from '../services/imageLoader'
import { type ImageFormat, validateImageFile } from '../services/imageValidation'

export interface UploadedImage {
  name: string
  sizeBytes: number
  format: ImageFormat
  width: number
  height: number
  bitmap: DecodedImage
  /** Object URL for thumbnails; revoked when the image is replaced or cleared. */
  url: string
}

function release(image: UploadedImage | null): void {
  if (!image) return
  URL.revokeObjectURL(image.url)
  image.bitmap.close()
}

export function useImageUpload() {
  const [image, setImage] = useState<UploadedImage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tokenRef = useRef(0)
  const currentRef = useRef<UploadedImage | null>(null)

  const replace = useCallback((next: UploadedImage | null) => {
    release(currentRef.current)
    currentRef.current = next
    setImage(next)
  }, [])

  const load = useCallback(
    async (file: File) => {
      const token = ++tokenRef.current
      setLoading(true)
      setError(null)
      try {
        const validation = await validateImageFile(file)
        if (!validation.ok) throw new Error(validation.error)
        const bitmap = await decodeImage(file)
        if (token !== tokenRef.current) {
          bitmap.close()
          return
        }
        if (bitmap.width === 0 || bitmap.height === 0) {
          bitmap.close()
          throw new Error('The image has no pixels.')
        }
        if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
          const mp = ((bitmap.width * bitmap.height) / 1e6).toFixed(0)
          bitmap.close()
          throw new Error(`The image is too large (${mp} megapixels). Please use an image under ${MAX_IMAGE_PIXELS / 1e6} MP.`)
        }
        replace({
          name: file.name,
          sizeBytes: file.size,
          format: validation.format,
          width: bitmap.width,
          height: bitmap.height,
          bitmap,
          url: URL.createObjectURL(file),
        })
      } catch (err) {
        if (token === tokenRef.current) setError(err instanceof Error ? err.message : 'Failed to load the image.')
      } finally {
        if (token === tokenRef.current) setLoading(false)
      }
    },
    [replace],
  )

  const clear = useCallback(() => {
    tokenRef.current++
    setLoading(false)
    setError(null)
    replace(null)
  }, [replace])

  useEffect(
    () => () => {
      release(currentRef.current)
      currentRef.current = null
    },
    [],
  )

  return { image, loading, error, load, clear, setError }
}
