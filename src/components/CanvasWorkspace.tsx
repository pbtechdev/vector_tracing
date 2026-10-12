import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UploadedImage } from '../hooks/useImageUpload'
import { bitmapToCanvas, checkerPattern, drawNodes, drawVectors, preparePaths } from '../services/canvasRenderer'
import type { ExportSettings, TraceProgress, TraceResult } from '../types/vectorTrace'
import { useFileDrop } from '../hooks/useFileDrop'
import { UploadButton } from './ImageUploader'
import { Icon } from './ui/controls'
import { ICONS } from './ui/icons'

export type ViewMode = 'original' | 'traced' | 'split' | 'bitmap'

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'traced', label: 'Traced' },
  { id: 'split', label: 'Split' },
  { id: 'bitmap', label: 'Bitmap' },
]

interface View {
  zoom: number
  x: number
  y: number
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 64

interface CanvasWorkspaceProps {
  image: UploadedImage | null
  result: TraceResult | null
  exportSettings: ExportSettings
  tracing: boolean
  progress: TraceProgress | null
  error: string | null
  onFile: (file: File) => void
  viewMode: ViewMode
  onViewModeChange: (v: ViewMode) => void
}

export function CanvasWorkspace({
  image,
  result,
  exportSettings,
  tracing,
  progress,
  error,
  onFile,
  viewMode,
  onViewModeChange,
}: CanvasWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  const [showSource, setShowSource] = useState(true)
  const [showVector, setShowVector] = useState(true)
  const [showNodes, setShowNodes] = useState(false)
  const [hairline, setHairline] = useState(false)
  const [split, setSplit] = useState(0.5)
  const hasStrokes = result?.shapes.some((s) => s.kind === 'stroke') ?? false
  const dragRef = useRef<{ kind: 'pan' | 'split'; sx: number; sy: number; view: View } | null>(null)
  const { dragging, handlers } = useFileDrop(onFile)

  const paths = useMemo(() => (result ? preparePaths(result) : null), [result])
  const bitmapCanvas = useMemo(() => (result ? bitmapToCanvas(result) : null), [result])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!image || size.w === 0 || size.h === 0) return
    const pad = 32
    const zoom = Math.max(MIN_ZOOM, Math.min((size.w - pad * 2) / image.width, (size.h - pad * 2) / image.height, MAX_ZOOM))
    setView({ zoom, x: (size.w - image.width * zoom) / 2, y: (size.h - image.height * zoom) / 2 })
  }, [image, size.w, size.h])

  // Fit whenever a new image arrives or the viewport is first measured.
  const fittedFor = useRef<UploadedImage | null>(null)
  useEffect(() => {
    if (image && size.w > 0 && fittedFor.current !== image) {
      fittedFor.current = image
      fit()
    }
  }, [image, size.w, fit])

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
      const k = zoom / v.zoom
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }, [])

  const actualSize = useCallback(() => {
    if (!image) return
    setView({ zoom: 1, x: (size.w - image.width) / 2, y: (size.h - image.height) / 2 })
  }, [image, size.w, size.h])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt, image])

  // Render.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || size.w === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const raf = requestAnimationFrame(() => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)
      const { zoom, x, y } = view
      const w = image.width
      const h = image.height

      const drawBase = () => {
        ctx.fillStyle = checkerPattern(ctx) ?? '#ffffff'
        ctx.fillRect(x, y, w * zoom, h * zoom)
      }

      const withImageSpace = (fn: () => void) => {
        ctx.save()
        ctx.translate(x, y)
        ctx.scale(zoom, zoom)
        ctx.imageSmoothingEnabled = zoom < 2
        fn()
        ctx.restore()
      }

      const drawOriginal = (alpha: number) =>
        withImageSpace(() => {
          ctx.globalAlpha = alpha
          ctx.drawImage(image.bitmap, 0, 0, w, h)
        })

      const drawTraced = () => {
        if (showSource) drawOriginal(0.3)
        if (paths && showVector) withImageSpace(() => drawVectors(ctx, paths, exportSettings, zoom, 1, hairline))
        if (paths && showNodes) withImageSpace(() => drawNodes(ctx, paths.nodes, zoom))
      }

      drawBase()
      if (viewMode === 'original' || !result) {
        drawOriginal(1)
      } else if (viewMode === 'traced') {
        drawTraced()
      } else if (viewMode === 'bitmap') {
        if (showSource) drawOriginal(0.25)
        if (bitmapCanvas) {
          withImageSpace(() => {
            ctx.imageSmoothingEnabled = false
            ctx.globalAlpha = 0.85
            ctx.drawImage(bitmapCanvas, 0, 0, w, h)
          })
        }
        if (paths && showVector) {
          withImageSpace(() => drawVectors(ctx, paths, { ...exportSettings, style: 'stroke', strokeColor: '#0ea5e9', strokeWidth: 0 }, zoom))
        }
      } else {
        const sxScreen = x + w * zoom * split
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, sxScreen, size.h)
        ctx.clip()
        drawOriginal(1)
        ctx.restore()
        ctx.save()
        ctx.beginPath()
        ctx.rect(sxScreen, 0, size.w - sxScreen, size.h)
        ctx.clip()
        drawTraced()
        ctx.restore()
        ctx.save()
        ctx.strokeStyle = '#0ea5e9'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(sxScreen, Math.max(0, y))
        ctx.lineTo(sxScreen, Math.min(size.h, y + h * zoom))
        ctx.stroke()
        ctx.fillStyle = '#0ea5e9'
        const hy = Math.min(Math.max(y + (h * zoom) / 2, 16), size.h - 16)
        ctx.beginPath()
        ctx.arc(sxScreen, hy, 9, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [image, result, paths, bitmapCanvas, view, size, viewMode, showSource, showVector, showNodes, hairline, exportSettings, split])

  const splitScreenX = image ? view.x + image.width * view.zoom * split : 0

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!image) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const kind = viewMode === 'split' && result && Math.abs(px - splitScreenX) < 12 ? 'split' : 'pan'
    dragRef.current = { kind, sx: e.clientX, sy: e.clientY, view }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d || !image) {
      if (image && viewMode === 'split' && result) {
        const rect = e.currentTarget.getBoundingClientRect()
        e.currentTarget.style.cursor = Math.abs(e.clientX - rect.left - splitScreenX) < 12 ? 'ew-resize' : 'grab'
      }
      return
    }
    if (d.kind === 'pan') {
      setView({ ...d.view, x: d.view.x + e.clientX - d.sx, y: d.view.y + e.clientY - d.sy })
    } else {
      const rect = e.currentTarget.getBoundingClientRect()
      const rel = (e.clientX - rect.left - view.x) / (image.width * view.zoom)
      setSplit(Math.min(1, Math.max(0, rel)))
    }
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 100 : 30
    const cx = size.w / 2
    const cy = size.h / 2
    switch (e.key) {
      case 'ArrowLeft':
        setView((v) => ({ ...v, x: v.x + step }))
        break
      case 'ArrowRight':
        setView((v) => ({ ...v, x: v.x - step }))
        break
      case 'ArrowUp':
        setView((v) => ({ ...v, y: v.y + step }))
        break
      case 'ArrowDown':
        setView((v) => ({ ...v, y: v.y - step }))
        break
      case '+':
      case '=':
        zoomAt(1.25, cx, cy)
        break
      case '-':
      case '_':
        zoomAt(0.8, cx, cy)
        break
      case '0':
        fit()
        break
      case '1':
        actualSize()
        break
      default:
        return
    }
    e.preventDefault()
  }

  const toggleBtn = (active: boolean) =>
    `rounded px-2 py-1 text-xs font-medium ${active ? 'bg-slate-700 text-slate-50' : 'text-slate-300 hover:bg-slate-800'}`

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-900">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-800 px-3 py-2" role="toolbar" aria-label="Canvas view controls">
        <div role="radiogroup" aria-label="View mode" className="flex rounded-md border border-slate-700 bg-slate-950 p-0.5">
          {VIEW_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={viewMode === m.id}
              disabled={!image || (m.id !== 'original' && !result)}
              onClick={() => onViewModeChange(m.id)}
              className={`rounded px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:text-slate-600 ${
                viewMode === m.id ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1" aria-label="Zoom">
          <button type="button" className={toggleBtn(false)} onClick={() => zoomAt(0.8, size.w / 2, size.h / 2)} disabled={!image} aria-label="Zoom out">
            <Icon path={ICONS.zoomOut} />
          </button>
          <span className="w-14 text-center font-mono text-xs text-slate-300 tabular-nums" aria-live="polite">
            {image ? `${Math.round(view.zoom * 100)}%` : '–'}
          </span>
          <button type="button" className={toggleBtn(false)} onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} disabled={!image} aria-label="Zoom in">
            <Icon path={ICONS.zoomIn} />
          </button>
          <button type="button" className={toggleBtn(false)} onClick={fit} disabled={!image} title="Fit to viewport (0)">
            <span className="flex items-center gap-1">
              <Icon path={ICONS.fit} /> Fit
            </span>
          </button>
          <button type="button" className={toggleBtn(false)} onClick={actualSize} disabled={!image} title="Actual size (1)">
            1:1
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button type="button" aria-pressed={showSource} className={toggleBtn(showSource)} onClick={() => setShowSource((v) => !v)} disabled={!image}>
            Source image
          </button>
          <button type="button" aria-pressed={showVector} className={toggleBtn(showVector)} onClick={() => setShowVector((v) => !v)} disabled={!result}>
            Vector paths
          </button>
          <button type="button" aria-pressed={showNodes} className={toggleBtn(showNodes)} onClick={() => setShowNodes((v) => !v)} disabled={!result}>
            Nodes
          </button>
          {hasStrokes && (
            <button
              type="button"
              aria-pressed={hairline}
              className={toggleBtn(hairline)}
              onClick={() => setHairline((v) => !v)}
              title="Show centerlines as thin lines instead of at their stroke width"
            >
              Hairline
            </button>
          )}
        </div>

        {viewMode === 'split' && result && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            Split
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(split * 100)}
              onChange={(e) => setSplit(Number(e.target.value) / 100)}
              className="vt-range w-24"
              aria-label="Split position"
            />
          </label>
        )}
      </div>

      <div ref={containerRef} className="relative min-h-[360px] flex-1 overflow-hidden" {...handlers}>
        {image ? (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="img"
            aria-label={`Canvas showing ${viewMode} view of ${image.name}. Drag to pan, scroll to zoom, arrow keys pan, plus and minus zoom, 0 fits.`}
            className="absolute inset-0 h-full w-full cursor-grab touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-400 active:cursor-grabbing"
            style={{ width: size.w, height: size.h }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div
              className={`flex max-w-md flex-col items-center rounded-xl border-2 border-dashed px-10 py-12 text-center ${
                dragging ? 'border-sky-400 bg-sky-950/30' : 'border-slate-700'
              }`}
            >
              <Icon path={ICONS.image} className="mb-3 h-10 w-10 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-100">Drop an image to start tracing</h2>
              <p className="mt-1 mb-4 text-sm text-slate-400">
                Logos, line drawings, scans and silhouettes work best. Everything is processed in your browser.
              </p>
              <UploadButton onFile={onFile} variant="primary">
                <Icon path={ICONS.upload} /> Upload Image
              </UploadButton>
            </div>
          </div>
        )}

        {image && dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-sky-950/60 text-lg font-medium text-sky-100">
            Drop to replace image
          </div>
        )}

        {tracing && (
          <div className="pointer-events-none absolute top-3 left-1/2 w-72 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-950/95 px-4 py-3 shadow-xl" role="status" aria-live="polite">
            <div className="mb-2 flex items-center justify-between text-xs text-slate-200">
              <span>{progress?.stage ?? 'Tracing'}…</span>
              <span className="font-mono tabular-nums">{Math.round((progress?.fraction ?? 0) * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-slate-800">
              <div className="h-full bg-sky-400 transition-[width]" style={{ width: `${Math.max(4, (progress?.fraction ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}

        {error && !tracing && (
          <div role="alert" className="absolute top-3 left-1/2 max-w-md -translate-x-1/2 rounded-lg border border-rose-800 bg-rose-950/95 px-4 py-3 text-sm text-rose-100 shadow-xl">
            Tracing failed: {error}
          </div>
        )}

        {image && !result && !tracing && !error && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-slate-950/90 px-4 py-1.5 text-xs text-slate-200 shadow">
            Choose a mode and click <strong>Trace Image</strong> to generate vector paths.
          </div>
        )}
      </div>
    </div>
  )
}
