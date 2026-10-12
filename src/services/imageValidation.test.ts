import { describe, expect, it } from 'vitest'
import { detectImageFormat, validateFileMetadata, validateImageFile } from './imageValidation'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]
const JPEG_SIG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]
const WEBP_SIG = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]

describe('detectImageFormat', () => {
  it('recognises PNG, JPEG and WebP signatures', () => {
    expect(detectImageFormat(new Uint8Array(PNG_SIG))).toBe('png')
    expect(detectImageFormat(new Uint8Array(JPEG_SIG))).toBe('jpeg')
    expect(detectImageFormat(new Uint8Array(WEBP_SIG))).toBe('webp')
  })

  it('rejects other or truncated data', () => {
    expect(detectImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull() // GIF
    expect(detectImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(detectImageFormat(new Uint8Array())).toBeNull()
  })
})

describe('validateFileMetadata', () => {
  it('accepts supported extensions and MIME types', () => {
    expect(validateFileMetadata('logo.PNG', 'image/png', 100)).toBeNull()
    expect(validateFileMetadata('photo.jpeg', 'image/jpeg', 100)).toBeNull()
    expect(validateFileMetadata('photo.jpg', '', 100)).toBeNull()
    expect(validateFileMetadata('art.webp', 'image/webp', 100)).toBeNull()
  })

  it('rejects unsupported types, empty and oversized files', () => {
    expect(validateFileMetadata('anim.gif', 'image/gif', 100)).toMatch(/Unsupported/)
    expect(validateFileMetadata('doc.pdf', 'application/pdf', 100)).toMatch(/Unsupported/)
    expect(validateFileMetadata('noext', '', 100)).toMatch(/Unsupported/)
    expect(validateFileMetadata('a.png', 'image/png', 0)).toMatch(/empty/)
    expect(validateFileMetadata('a.png', 'image/png', 500 * 1024 * 1024)).toMatch(/too large/)
  })
})

describe('validateImageFile', () => {
  it('accepts a file with a valid signature', async () => {
    const file = new File([new Uint8Array(PNG_SIG)], 'ok.png', { type: 'image/png' })
    await expect(validateImageFile(file)).resolves.toEqual({ ok: true, format: 'png' })
  })

  it('rejects a mislabelled or corrupt file', async () => {
    const file = new File(['this is not an image'], 'fake.png', { type: 'image/png' })
    const result = await validateImageFile(file)
    expect(result.ok).toBe(false)
  })

  it('rejects an unsupported extension before reading', async () => {
    const file = new File([new Uint8Array(PNG_SIG)], 'image.bmp', { type: 'image/bmp' })
    const result = await validateImageFile(file)
    expect(result.ok).toBe(false)
  })
})
