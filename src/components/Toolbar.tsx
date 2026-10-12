import { UploadButton } from './ImageUploader'
import { Button, Icon } from './ui/controls'
import { ICONS } from './ui/icons'

interface ToolbarProps {
  onFile: (file: File) => void
  canTrace: boolean
  tracing: boolean
  onTrace: () => void
  onCancel: () => void
  canExport: boolean
  onExport: () => void
  canReset: boolean
  onReset: () => void
}

export function Toolbar({ onFile, canTrace, tracing, onTrace, onCancel, canExport, onExport, canReset, onReset }: ToolbarProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#0ea5e9" />
          <path d="M7 23C11 23 11 9 16 9s5 14 9 14" fill="none" stroke="#020617" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="7" cy="23" r="2.2" fill="#fff" stroke="#020617" strokeWidth="1.5" />
          <circle cx="25" cy="23" r="2.2" fill="#fff" stroke="#020617" strokeWidth="1.5" />
          <circle cx="16" cy="9" r="2.2" fill="#fff" stroke="#020617" strokeWidth="1.5" />
        </svg>
        <h1 className="text-lg font-semibold tracking-tight text-slate-50">VectorTrace</h1>
        <span className="hidden text-xs text-slate-400 sm:inline">Bitmap → editable vector paths</span>
      </div>
      <nav aria-label="Main actions" className="flex flex-wrap items-center gap-2">
        <UploadButton onFile={onFile}>
          <Icon path={ICONS.upload} /> Upload Image
        </UploadButton>
        {tracing ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel trace
          </Button>
        ) : (
          <Button variant="primary" onClick={onTrace} disabled={!canTrace} title="Trace image (Ctrl+Enter)">
            <Icon path={ICONS.trace} /> Trace Image
          </Button>
        )}
        <Button variant="secondary" onClick={onExport} disabled={!canExport} title="Export SVG (Ctrl+S)">
          <Icon path={ICONS.download} /> Export SVG
        </Button>
        <Button variant="danger" onClick={onReset} disabled={!canReset} title="Clear the image and restore default settings">
          <Icon path={ICONS.reset} /> Reset
        </Button>
      </nav>
    </header>
  )
}
