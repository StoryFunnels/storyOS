'use client';

import { Label } from '@/components/ui/label';

export interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
  /**
   * Whether the leading blank ("Choose") option is a real, selectable value.
   *
   * Default `true` keeps the historic behaviour: a selectable
   * `<option value="">` so callers whose empty string means "unset" (optional
   * fields) keep working unchanged.
   *
   * Set `false` for required / always-defaulted controls (#104). In that mode:
   *  - the blank option is only rendered while nothing is selected, and it is
   *    `disabled` so it can never be re-picked — no more selecting an invalid
   *    empty value on a required control;
   *  - an empty change is ignored, so a set value is never silently cleared to
   *    empty (which on dependent pickers also wiped downstream selections).
   */
  allowEmpty?: boolean;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  help,
  allowEmpty = true,
}: SelectFieldProps) {
  const showBlank = allowEmpty || value === '';
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <select
        className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-[13px] text-ink outline-none focus:border-border-strong"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          // Strict mode: never let a re-pick of the blank option clear a value.
          if (!allowEmpty && next === '') return;
          onChange(next);
        }}
      >
        {showBlank && (
          <option value="" disabled={!allowEmpty}>
            {placeholder ?? 'Choose'}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {help && <p className="text-[11px] leading-4 text-muted">{help}</p>}
    </div>
  );
}
