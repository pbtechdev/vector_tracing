import { useId } from 'react'
import type { UploadedImage } from '../hooks/useImageUpload'
import { computeOutputSize, formatNumber } from '../services/svgExporter'
import type { ExportSettings, ExportUnit, FillStyle, StrokeWidthMode, TraceMode, TraceResult } from '../types/vectorTrace'
import { Button, Icon, Section, Slider } from './ui/controls'
import { ICONS } from './ui/icons'

interface OutputPanelProps {
  image: UploadedImage | null
  result: TraceResult | null
  /** Currently selected mode (used before the first trace). */
  mode: TraceMode
  stale: boolean
  exportSettings: ExportSettings
  onExportChange: (patch: Partial<ExportSettings>) => void
  svgBytes: number | null
  onExport: () => void
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 py-0.5 text-sm">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-mono text-slate-100 tabular-nums">{value}</dd>
    </div>
  )
}

const STYLES: { id: FillStyle; label: string }[] = [
  { id: 'fill', label: 'Fill' },
  { id: 'stroke', label: 'Outline' },
  { id: 'fill-stroke', label: 'Both' },
]

const WIDTH_MODES: { id: StrokeWidthMode; label: string }[] = [
  { id: 'detected', label: 'Detected' },
  { id: 'per-path', label: 'Per stroke' },
  { id: 'custom', label: 'Custom' },
]

const UNITS: ExportUnit[] = ['px', 'mm', 'in']

export function OutputPanel({ image, result, mode, stale, exportSettings, onExportChange, svgBytes, onExport }: OutputPanelProps) {
  const fillId = useId()
  const strokeId = useId()
  const unitId = useId()
  const dpiId = useId()
  const precisionId = useId()

  const out = image ? computeOutputSize(image.width, image.height, exportSettings.unit, exportSettings.dpi) : null
  const unitDigits = exportSettings.unit === 'px' ? 0 : 2
  const isCenterline = (result?.mode ?? mode) === 'centerline'
  const hasAreas = result?.shapes.some((s) => s.kind === 'area') ?? false
  const openCount = result ? result.shapes.reduce((n, s) => n + s.subpaths.filter((p) => !p.closed).length, 0) : 0

  return (
    <>
      <Section title="Image">
        {image ? (
          <dl>
            <Row label="Source size" value={`${image.width} × ${image.height} px`} />
            <Row label="Aspect ratio" value={formatNumber(image.width / image.height, 3)} />
            {result && <Row label="Processed at" value={`${result.processingWidth} × ${result.processingHeight} px`} />}
            {result && <Row label="Threshold used" value={result.thresholdUsed >= 0 ? String(result.thresholdUsed) : 'n/a'} />}
          </dl>
        ) : (
          <p className="text-sm text-slate-400">No image loaded.</p>
        )}
      </Section>

      <Section title="Trace result">
        {result ? (
          <>
            {stale && <p className="rounded bg-amber-950/50 px-2 py-1 text-xs text-amber-200">Settings changed — retrace to update.</p>}
            <dl>
              <Row label={result.mode === 'centerline' ? 'Strokes (paths)' : 'Objects (paths)'} value={result.stats.shapeCount.toLocaleString()} />
              {result.mode === 'centerline' ? (
                <>
                  <Row label="Open / closed" value={`${openCount.toLocaleString()} / ${(result.stats.subpathCount - openCount).toLocaleString()}`} />
                  <Row label="Median width" value={`${formatNumber(result.estimatedStrokeWidth, 2)} px`} />
                </>
              ) : (
                <Row label="Subpaths" value={result.stats.subpathCount.toLocaleString()} />
              )}
              <Row label="Nodes" value={result.stats.nodeCount.toLocaleString()} />
              <Row label="Curves / lines" value={`${result.stats.curveCount.toLocaleString()} / ${result.stats.lineCount.toLocaleString()}`} />
              {result.sharpen && (
                <Row
                  label="AI sharpen"
                  value={result.sharpen.applied ? `4× · ${(result.sharpen.durationMs / 1000).toFixed(1)} s` : `Skipped — ${result.sharpen.reason ?? 'not available'}`}
                />
              )}
              <Row
                label="Edges / arcs / circles"
                value={`${result.stats.primitives.lines.toLocaleString()} / ${result.stats.primitives.arcs.toLocaleString()} / ${result.stats.primitives.circles.toLocaleString()}`}
              />
              <Row label="Foreground" value={`${(result.foregroundRatio * 100).toFixed(1)}%`} />
              <Row label="Trace time" value={`${Math.round(result.durationMs)} ms`} />
              {svgBytes !== null && <Row label="SVG size" value={svgBytes > 1024 * 1024 ? `${(svgBytes / 1048576).toFixed(2)} MB` : `${(svgBytes / 1024).toFixed(1)} KB`} />}
            </dl>
            {result.warnings.map((w) => (
              <p key={w} className="rounded border border-amber-800/70 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-100">
                {w}
              </p>
            ))}
          </>
        ) : (
          <p className="text-sm text-slate-400">{image ? 'Not traced yet.' : 'Upload an image to begin.'}</p>
        )}
      </Section>

      <Section title="Export settings">
        {!isCenterline && (!result || hasAreas) && (
          <fieldset>
            <legend className="mb-1 text-sm text-slate-200">Shape style</legend>
            <div className="flex rounded-md border border-slate-700 bg-slate-950 p-0.5">
              {STYLES.map((s) => (
                <label
                  key={s.id}
                  className={`vt-mode flex-1 cursor-pointer rounded px-2 py-1 text-center text-xs font-medium ${
                    exportSettings.style === s.id ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <input type="radio" name="export-style" className="sr-only" checked={exportSettings.style === s.id} onChange={() => onExportChange({ style: s.id })} />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {isCenterline && (
          <fieldset>
            <legend className="mb-1 text-sm text-slate-200">Stroke width</legend>
            <div className="flex rounded-md border border-slate-700 bg-slate-950 p-0.5">
              {WIDTH_MODES.map((m) => (
                <label
                  key={m.id}
                  className={`vt-mode flex-1 cursor-pointer rounded px-2 py-1 text-center text-xs font-medium ${
                    exportSettings.centerlineWidth === m.id ? 'bg-sky-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="centerline-width"
                    className="sr-only"
                    checked={exportSettings.centerlineWidth === m.id}
                    onChange={() => onExportChange({ centerlineWidth: m.id })}
                  />
                  {m.label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {exportSettings.centerlineWidth === 'detected'
                ? result
                  ? `All strokes use the median measured width (${formatNumber(result.estimatedStrokeWidth, 2)} px).`
                  : 'All strokes use the median measured width.'
                : exportSettings.centerlineWidth === 'per-path'
                  ? 'Each stroke keeps its own measured width.'
                  : 'All strokes use the width set below — e.g. a hairline for plotters and lasers.'}
            </p>
          </fieldset>
        )}

        <div className="grid grid-cols-2 gap-3">
          {!isCenterline && (
            <div>
              <label htmlFor={fillId} className="mb-1 block text-sm text-slate-200">
                Fill
              </label>
              <input id={fillId} type="color" value={exportSettings.fillColor} onChange={(e) => onExportChange({ fillColor: e.target.value })} className="vt-color h-8 w-full" />
            </div>
          )}
          <div>
            <label htmlFor={strokeId} className="mb-1 block text-sm text-slate-200">
              Stroke
            </label>
            <input id={strokeId} type="color" value={exportSettings.strokeColor} onChange={(e) => onExportChange({ strokeColor: e.target.value })} className="vt-color h-8 w-full" />
          </div>
        </div>

        {(!isCenterline || exportSettings.centerlineWidth === 'custom') && (
          <Slider
            label={isCenterline ? 'Custom stroke width' : 'Stroke width'}
            value={exportSettings.strokeWidth}
            min={0.25}
            max={Math.max(20, Math.ceil(result?.estimatedStrokeWidth ?? 0))}
            step={0.25}
            format={(v) => `${v} px`}
            onChange={(v) => onExportChange({ strokeWidth: v })}
            disabled={!isCenterline && exportSettings.style === 'fill'}
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={unitId} className="mb-1 block text-sm text-slate-200">
              Units
            </label>
            <select
              id={unitId}
              value={exportSettings.unit}
              onChange={(e) => onExportChange({ unit: e.target.value as ExportUnit })}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={dpiId} className="mb-1 block text-sm text-slate-200">
              DPI
            </label>
            <input
              id={dpiId}
              type="number"
              min={1}
              max={2400}
              value={exportSettings.dpi}
              disabled={exportSettings.unit === 'px'}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v > 0) onExportChange({ dpi: Math.min(2400, v) })
              }}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-50"
            />
          </div>
        </div>

        <div>
          <label htmlFor={precisionId} className="mb-1 block text-sm text-slate-200">
            Coordinate precision
          </label>
          <select
            id={precisionId}
            value={exportSettings.precision}
            onChange={(e) => onExportChange({ precision: Number(e.target.value) })}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
          >
            <option value={0}>0 decimals (smallest)</option>
            <option value={1}>1 decimal</option>
            <option value={2}>2 decimals (recommended)</option>
            <option value={3}>3 decimals</option>
          </select>
        </div>

        {out && (
          <dl>
            <Row label="Output size" value={`${formatNumber(out.width, unitDigits)} × ${formatNumber(out.height, unitDigits)} ${out.unit}`} />
          </dl>
        )}

        <Button variant="primary" className="w-full" onClick={onExport} disabled={!result || result.shapes.length === 0}>
          <Icon path={ICONS.download} /> Export SVG
        </Button>
      </Section>

      <Section title="Using in CorelDRAW">
        <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-slate-300">
          <li>Export the SVG above.</li>
          <li>
            In CorelDRAW choose <strong>File → Import</strong> (Ctrl+I), select the SVG and click to place it. Keep the
            original size when prompted.
          </li>
          <li>The paths arrive as editable curves; holes are combined into their shape. Ungroup (Ctrl+U) to edit objects individually.</li>
          <li>
            Use <strong>File → Save As</strong> and choose <strong>CDR</strong> to keep a native CorelDRAW document.
          </li>
        </ol>
        <p className="text-[11px] leading-relaxed text-slate-400">
          VectorTrace exports standard SVG, not native .cdr files. Creating CDR directly would require CorelDRAW itself or a
          dedicated conversion tool.
        </p>
      </Section>
    </>
  )
}
