import { type ButtonHTMLAttributes, type ReactNode, useId } from 'react'

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-b border-slate-800 px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">{title}</h2>
        {actions}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  disabled?: boolean
  hint?: string
  format?: (v: number) => string
}

export function Slider({ label, value, min, max, step = 1, onChange, disabled, hint, format }: SliderProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className={disabled ? 'opacity-50' : undefined}>
      <div className="mb-1 flex items-center justify-between text-sm">
        <label htmlFor={id} className="text-slate-200">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-xs text-slate-300 tabular-nums">
          {format ? format(value) : value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className="vt-range w-full"
      />
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      )}
    </div>
  )
}

interface ToggleProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  hint?: string
}

export function Toggle({ label, checked, onChange, disabled, hint }: ToggleProps) {
  const id = useId()
  return (
    <div className={disabled ? 'opacity-50' : undefined}>
      <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3 text-sm text-slate-200">
        <span>{label}</span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="vt-switch"
        />
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-400">
          {hint}
        </p>
      )}
    </div>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sky-500 text-slate-950 hover:bg-sky-400 disabled:bg-slate-700 disabled:text-slate-400',
  secondary: 'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700 disabled:text-slate-500',
  ghost: 'text-slate-200 hover:bg-slate-800 disabled:text-slate-600',
  danger: 'text-rose-300 hover:bg-rose-950 border border-slate-700 disabled:text-slate-600',
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Icon({ path, className = 'h-4 w-4' }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={path} />
    </svg>
  )
}