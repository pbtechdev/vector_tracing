import { LINE_END_MODES, TRACE_MODES } from '../constants/defaults'
import type { LineEndMode, TraceMode, TraceSettings as Settings } from '../types/vectorTrace'
import { Section, Slider, Toggle } from './ui/controls'

interface TraceSettingsProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onModeChange: (mode: TraceMode) => void
  onResetDefaults: () => void
  livePreview: boolean
  onLivePreviewChange: (v: boolean) => void
  thresholdUsed: number | null
}

const RESOLUTIONS = [
  { value: 1200, label: 'Fast (1200 px)' },
  { value: 2400, label: 'Balanced (2400 px)' },
  { value: 4000, label: 'High (4000 px)' },
]

export function TraceSettings({
  settings,
  onChange,
  onModeChange,
  onResetDefaults,
  livePreview,
  onLivePreviewChange,
  thresholdUsed,
}: TraceSettingsProps) {
  const activeMode = TRACE_MODES.find((m) => m.id === settings.mode)
  const thresholdDisabled = settings.autoThreshold || settings.removeBackground

  return (
    <>
      <Section title="Tracing mode">
        <fieldset>
          <legend className="sr-only">Tracing mode</legend>
          <div className="grid grid-cols-2 gap-2">
            {TRACE_MODES.map((m) => (
              <label
                key={m.id}
                className={`vt-mode cursor-pointer rounded-md border px-2 py-2 text-center text-sm transition-colors ${
                  settings.mode === m.id
                    ? 'border-sky-400 bg-sky-950/60 text-sky-100'
                    : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500'
                }`}
              >
                <input
                  type="radio"
                  name="trace-mode"
                  value={m.id}
                  checked={settings.mode === m.id}
                  onChange={() => onModeChange(m.id)}
                  className="sr-only"
                />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
        {activeMode && <p className="text-xs leading-relaxed text-slate-400">{activeMode.description}</p>}
        {settings.mode === 'lineart' && (
          <p className="rounded-md border border-amber-800/70 bg-amber-950/40 px-2.5 py-2 text-xs leading-relaxed text-amber-100">
            Note: contour tracing outlines both edges of a stroke, so each thick line becomes a thin filled shape with an
            inner and outer boundary. Use <strong>Centerline</strong> mode for single-stroke paths.
          </p>
        )}
      </Section>

      {settings.mode === 'centerline' && (
        <Section title="Centerline">
          <div>
            <label htmlFor="vt-line-ends" className="mb-1 block text-sm text-slate-200">
              Line ends
            </label>
            <select
              id="vt-line-ends"
              value={settings.lineEnds}
              onChange={(e) => onChange({ lineEnds: e.target.value as LineEndMode })}
              aria-describedby="vt-line-ends-hint"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
            >
              {LINE_END_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p id="vt-line-ends-hint" className="mt-1 text-xs text-slate-400">
              {LINE_END_MODES.find((m) => m.id === settings.lineEnds)?.hint}
            </p>
          </div>
          <Toggle
            label="Join strokes through junctions"
            checked={settings.joinStrokes}
            onChange={(v) => onChange({ joinStrokes: v })}
            hint={settings.joinStrokes ? 'A “+” becomes two continuous strokes.' : 'Every junction splits strokes into separate paths.'}
          />
          <Slider
            label="Join angle"
            value={settings.joinAngle}
            min={5}
            max={80}
            step={5}
            disabled={!settings.joinStrokes}
            format={(v) => `${v}°`}
            onChange={(v) => onChange({ joinAngle: v })}
            hint="Max bend allowed when continuing a stroke through a junction."
          />
          <Slider
            label="Branch pruning"
            value={settings.spurLength}
            min={0}
            max={60}
            format={(v) => `${v} px`}
            onChange={(v) => onChange({ spurLength: v })}
            hint="Removes short side branches (in addition to automatic, width-based pruning)."
          />
          <Slider
            label="Gap closing"
            value={settings.gapClosing}
            min={0}
            max={60}
            format={(v) => (v === 0 ? 'Off' : `${v} px`)}
            onChange={(v) => onChange({ gapClosing: v })}
            hint="Joins line ends that point at each other across small breaks."
          />
        </Section>
      )}

      <Section
        title="Trace settings"
        actions={
          <button type="button" onClick={onResetDefaults} className="rounded px-1.5 py-0.5 text-xs text-sky-300 hover:bg-slate-800 hover:text-sky-200">
            Reset to defaults
          </button>
        }
      >
        <Toggle
          label="Auto threshold (Otsu)"
          checked={settings.autoThreshold}
          disabled={settings.removeBackground}
          onChange={(v) => onChange({ autoThreshold: v })}
        />
        <Slider
          label={settings.mode === 'lineart' ? 'Threshold (darkest ink limit)' : 'Threshold'}
          value={settings.autoThreshold && thresholdUsed !== null && thresholdUsed >= 0 ? thresholdUsed : settings.threshold}
          min={0}
          max={255}
          disabled={thresholdDisabled}
          onChange={(v) => onChange({ threshold: v })}
          hint={
            settings.removeBackground
              ? 'Not used while Remove background is on.'
              : settings.autoThreshold
                ? 'Chosen automatically. Turn off Auto threshold to adjust.'
                : 'Pixels darker than this value are traced.'
          }
        />
        <Slider
          label="Smoothing"
          value={settings.smoothing}
          min={0}
          max={10}
          onChange={(v) => onChange({ smoothing: v })}
          hint={
            settings.mode === 'silhouette'
              ? 'Also closes small gaps between shapes.'
              : settings.mode === 'centerline'
                ? 'Smooths wobbly strokes and fills pinholes before thinning.'
                : undefined
          }
        />
        <Slider
          label="Detail / curve accuracy"
          value={settings.detail}
          min={0}
          max={100}
          onChange={(v) => onChange({ detail: v })}
          hint="Higher follows the bitmap more closely with more nodes."
        />
        <Slider
          label="Corner sharpness"
          value={settings.cornerAngle}
          min={60}
          max={175}
          step={5}
          format={(v) => `${v}°`}
          onChange={(v) => onChange({ cornerAngle: v })}
          hint="Angles sharper than this stay as corners; higher keeps more corners."
        />
        <Slider
          label="Noise removal (min. size)"
          value={settings.minObjectSize}
          min={0}
          max={500}
          step={1}
          format={(v) => `${v} px²`}
          onChange={(v) => onChange({ minObjectSize: v })}
          hint="Specks and holes smaller than this area are removed."
        />
      </Section>

      <Section title="Image adjustments">
        <Toggle label="Invert colors" checked={settings.invert} onChange={(v) => onChange({ invert: v })} hint="Trace light shapes on a dark background." />
        <Toggle
          label="Grayscale (luminance)"
          checked={settings.grayscale}
          onChange={(v) => onChange({ grayscale: v })}
          hint={settings.grayscale ? 'Brightness decides what is ink.' : 'Darkest colour channel decides — saturated colours count as ink.'}
        />
        <Toggle
          label="Remove background"
          checked={settings.removeBackground}
          onChange={(v) => onChange({ removeBackground: v })}
          hint="Removes the colour connected to the image border; everything else is traced."
        />
        {settings.removeBackground && (
          <Slider
            label="Background tolerance"
            value={settings.backgroundTolerance}
            min={0}
            max={160}
            onChange={(v) => onChange({ backgroundTolerance: v })}
          />
        )}
        {settings.mode === 'silhouette' && (
          <Toggle label="Fill all holes" checked={settings.fillHoles} onChange={(v) => onChange({ fillHoles: v })} hint="Produces solid outlines only." />
        )}
        <div>
          <label htmlFor="vt-resolution" className="mb-1 block text-sm text-slate-200">
            Processing resolution
          </label>
          <select
            id="vt-resolution"
            value={settings.maxProcessingSize}
            onChange={(e) => onChange({ maxProcessingSize: Number(e.target.value) })}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
          >
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">Large images are traced at this size; output keeps the original dimensions.</p>
        </div>
      </Section>

      <Section title="Preview">
        <Toggle
          label="Live preview"
          checked={livePreview}
          onChange={onLivePreviewChange}
          hint="Retrace automatically shortly after a setting changes."
        />
      </Section>
    </>
  )
}
