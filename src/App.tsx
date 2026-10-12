import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { CanvasWorkspace, type ViewMode } from './components/CanvasWorkspace'
import { ImageUploader } from './components/ImageUploader'
import { OutputPanel } from './components/OutputPanel'
import { Toolbar } from './components/Toolbar'
import { TraceSettings } from './components/TraceSettings'
import { Section } from './components/ui/controls'
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_TRACE_SETTINGS, MODE_DEFAULT_STYLE } from './constants/defaults'
import { useImageUpload } from './hooks/useImageUpload'
import { useVectorTrace } from './hooks/useVectorTrace'
import { buildSvg, svgFileName } from './services/svgExporter'
import type { ExportSettings, TraceMode, TraceSettings as Settings } from './types/vectorTrace'

const LIVE_PREVIEW_DELAY_MS = 450

function sameSettings(a: Settings, b: Settings): boolean {
  return (Object.keys(a) as (keyof Settings)[]).every((k) => a[k] === b[k])
}

function downloadText(text: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function App() {
  const upload = useImageUpload()
  const { image } = upload
  const tracer = useVectorTrace(image)
  const { result, status, trace } = tracer

  const [settings, setSettings] = useState<Settings>(DEFAULT_TRACE_SETTINGS)
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const [viewMode, setViewMode] = useState<ViewMode>('original')
  const [livePreview, setLivePreview] = useState(true)
  const [armed, setArmed] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  /** Settings of the most recent trace request; used for live preview and the "stale" hint. */
  const [tracedWith, setTracedWith] = useState<Settings | null>(null)
  const [prevImage, setPrevImage] = useState(image)
  const [prevResult, setPrevResult] = useState(result)

  if (prevImage !== image) {
    setPrevImage(image)
    setArmed(false)
    setTracedWith(null)
    setViewMode('original')
  }
  if (prevResult !== result) {
    setPrevResult(result)
    if (result && viewMode === 'original') setViewMode('traced')
  }

  const tracing = status === 'tracing'

  const runTrace = useCallback(
    (s: Settings) => {
      setTracedWith(s)
      setArmed(true)
      void trace(s)
    },
    [trace],
  )

  // Live preview: retrace after settings settle, once the user has traced this image.
  useEffect(() => {
    if (!livePreview || !armed || !image) return
    if (tracedWith && sameSettings(tracedWith, settings)) return
    const t = setTimeout(() => runTrace(settings), LIVE_PREVIEW_DELAY_MS)
    return () => clearTimeout(t)
  }, [settings, livePreview, armed, image, runTrace, tracedWith])

  const patchSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), [])
  const patchExport = useCallback((patch: Partial<ExportSettings>) => setExportSettings((s) => ({ ...s, ...patch })), [])

  const onModeChange = useCallback((mode: TraceMode) => {
    setSettings((s) => ({ ...s, mode }))
    setExportSettings((s) => ({ ...s, style: MODE_DEFAULT_STYLE[mode] }))
  }, [])

  const deferredExport = useDeferredValue(exportSettings)
  const svgBytes = useMemo(() => {
    if (!result) return null
    return new Blob([buildSvg(result, deferredExport)]).size
  }, [result, deferredExport])

  const onExport = useCallback(() => {
    if (!result || !image) return
    try {
      setExportError(null)
      const svg = buildSvg(result, exportSettings, image.name)
      downloadText(svg, svgFileName(image.name), 'image/svg+xml')
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.')
    }
  }, [result, image, exportSettings])

  const { clearResult } = tracer
  const { clear: clearImage, load: loadImage } = upload
  const onReset = useCallback(() => {
    clearResult()
    clearImage()
    setSettings(DEFAULT_TRACE_SETTINGS)
    setExportSettings(DEFAULT_EXPORT_SETTINGS)
    setViewMode('original')
    setExportError(null)
  }, [clearResult, clearImage])

  const onFile = useCallback((file: File) => void loadImage(file), [loadImage])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === 'Enter' && image && !tracing) {
        e.preventDefault()
        runTrace(settings)
      } else if (e.key.toLowerCase() === 's' && result) {
        e.preventDefault()
        onExport()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [image, tracing, settings, result, runTrace, onExport])

  const stale = result !== null && tracedWith !== null && !sameSettings(tracedWith, settings) && !tracing

  return (
    <div className="flex h-full min-h-screen flex-col bg-slate-950 text-slate-100 lg:h-screen">
      <a href="#workspace" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-sky-500 focus:px-3 focus:py-1 focus:text-slate-950">
        Skip to canvas
      </a>
      <Toolbar
        onFile={onFile}
        canTrace={!!image && !upload.loading}
        tracing={tracing}
        onTrace={() => runTrace(settings)}
        onCancel={tracer.cancel}
        canExport={!!result && result.shapes.length > 0}
        onExport={onExport}
        canReset={!!image || !sameSettings(settings, DEFAULT_TRACE_SETTINGS)}
        onReset={onReset}
      />
      {exportError && (
        <p role="alert" className="border-b border-rose-800 bg-rose-950 px-4 py-2 text-sm text-rose-100">
          Export failed: {exportError}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[300px_minmax(0,1fr)_290px]">
        <aside aria-label="Image and trace settings" className="order-2 overflow-y-auto border-slate-800 bg-slate-950 lg:order-1 lg:border-r">
          <Section title="Image">
            <ImageUploader image={image} loading={upload.loading} error={upload.error} onFile={onFile} />
          </Section>
          <TraceSettings
            settings={settings}
            onChange={patchSettings}
            onModeChange={onModeChange}
            onResetDefaults={() => setSettings((s) => ({ ...DEFAULT_TRACE_SETTINGS, mode: s.mode }))}
            livePreview={livePreview}
            onLivePreviewChange={setLivePreview}
            thresholdUsed={result?.thresholdUsed ?? null}
          />
        </aside>
        <main id="workspace" className="order-1 flex min-h-[60vh] min-w-0 flex-col lg:order-2 lg:min-h-0">
          <CanvasWorkspace
            image={image}
            result={result}
            exportSettings={exportSettings}
            tracing={tracing}
            progress={tracer.progress}
            error={tracer.error}
            onFile={onFile}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </main>
        <aside aria-label="Output information and export" className="order-3 overflow-y-auto border-slate-800 bg-slate-950 lg:border-l">
          <OutputPanel
            image={image}
            result={result}
            mode={settings.mode}
            stale={stale}
            exportSettings={exportSettings}
            onExportChange={patchExport}
            svgBytes={svgBytes}
            onExport={onExport}
          />
        </aside>
      </div>
    </div>
  )
}
