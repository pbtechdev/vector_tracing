import { ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES, MAX_FILE_BYTES } from '../constants/defaults'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export type ValidationResult =
  | { ok: true; format: ImageFormat }
  | { ok: false; error: string }

/** Identify PNG / JPEG / WebP from the file signature. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'webp'
  }
  return null
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

/** Checks name, MIME type and size without reading file contents. */
export function validateFileMetadata(name: string, mimeType: string, size: number): string | null {
  const ext = extensionOf(name)
  const extOk = (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)
  const mimeOk = mimeType === '' || (ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)
  if (!extOk || !mimeOk) {
    return `Unsupported file type${ext ? ` (${ext})` : ''}. Please upload a PNG, JPG, JPEG or WebP image.`
  }
  if (size === 0) {
    return 'The file is empty.'
  }
  if (size > MAX_FILE_BYTES) {
    return `The file is too large (${(size / 1024 / 1024).toFixed(1)} MB). The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`
  }
  return null
}

export async function validateImageFile(file: File): Promise<ValidationResult> {
  const metaError = validateFileMetadata(file.name, file.type, file.size)
  if (metaError) return { ok: false, error: metaError }

  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const format = detectImageFormat(header)
  if (!format) {
    return {
      ok: false,
      error: 'The file contents do not look like a PNG, JPEG or WebP image. It may be corrupt or mislabelled.',
    }
  }
  return { ok: true, format }
}
