import { type ReactNode, useRef } from 'react'
import { ACCEPT_ATTR, useFileDrop } from '../hooks/useFileDrop'
import type { UploadedImage } from '../hooks/useImageUpload'
import { Button, Icon } from './ui/controls'
import { ICONS } from './ui/icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UploadButton({
  onFile,
  children,
  variant = 'secondary',
  className,
}: {
  onFile: (file: File) => void
  children: ReactNode
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button variant={variant} className={className} onClick={() => inputRef.current?.click()}>
        {children}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
    </>
  )
}

interface ImageUploaderProps {
  image: UploadedImage | null
  loading: boolean
  error: string | null
  onFile: (file: File) => void
}

export function ImageUploader({ image, loading, error, onFile }: ImageUploaderProps) {
  const { dragging, handlers } = useFileDrop(onFile)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="space-y-3">
      <div
        {...handlers}
        className={`rounded-lg border-2 border-dashed p-3 transition-colors ${
          dragging ? 'border-sky-400 bg-sky-950/40' : 'border-slate-700 bg-slate-900'
        }`}
      >
        {image ? (
          <div className="flex items-center gap-3">
            <img src={image.url} alt="" className="vt-checker h-14 w-14 shrink-0 rounded border border-slate-700 object-contain" />
            <div className="min-w-0 text-xs text-slate-300">
              <p className="truncate text-sm font-medium text-slate-100" title={image.name}>
                {image.name}
              </p>
              <p>
                {image.width} × {image.height} px · {image.format.toUpperCase()}
              </p>
              <p>{formatBytes(image.sizeBytes)}</p>
            </div>
          </div>
        ) : (
          <p className="py-2 text-center text-sm text-slate-300">Drop an image here</p>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700"
        >
          <Icon path={ICONS.upload} />
          {loading ? 'Loading…' : image ? 'Replace image' : 'Choose image'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          tabIndex={-1}
          aria-label="Upload image"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file)
            e.target.value = ''
          }}
        />
        <p className="mt-2 text-center text-[11px] text-slate-400">PNG, JPG, JPEG or WebP · processed locally, never uploaded</p>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-rose-800 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
          {error}
        </p>
      )}
    </div>
  )
}
