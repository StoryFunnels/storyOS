'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { usePreferences, useUpdatePreferences } from '@/lib/preferences';
import type { UserPreferences } from '@/lib/preferences';
import { formatDate, formatDateTime, DEFAULT_REGIONAL } from '@/lib/format';

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

type Regional = UserPreferences['regional'];
const DATE_OPTIONS: { value: Regional['dateFormat']; label: string }[] = [
  { value: 'system', label: 'System default' },
  { value: 'MDY', label: 'MM/DD/YYYY' },
  { value: 'DMY', label: 'DD/MM/YYYY' },
  { value: 'YMD', label: 'YYYY-MM-DD' },
];
const TIME_OPTIONS: { value: Regional['timeFormat']; label: string }[] = [
  { value: 'system', label: 'System default' },
  { value: '12h', label: '12-hour' },
  { value: '24h', label: '24-hour' },
];
const WEEK_OPTIONS: { value: Regional['firstDayOfWeek']; label: string }[] = [
  { value: 'system', label: 'System default' },
  { value: 'sunday', label: 'Sunday' },
  { value: 'monday', label: 'Monday' },
  { value: 'saturday', label: 'Saturday' },
];

export default function PreferencesPage() {
  const { preference, setPreference } = useTheme();
  const prefs = usePreferences();
  const update = useUpdatePreferences();
  const regional = prefs.data?.regional ?? DEFAULT_REGIONAL;

  const setRegional = (patch: Partial<Regional>) =>
    update.mutate({ regional: patch }, { onError: () => toast.error('Could not save — try again') });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Preferences</h1>
      <p className="mb-6 text-[13px] text-muted">Personal settings for how the app looks and reads.</p>

      <section className="border-b border-border-default pb-8">
        <h2 className="mb-1 text-sm font-medium text-ink">Appearance</h2>
        <p className="mb-3 text-[13px] text-muted">
          Choose a theme. System follows your device setting. Applies on this browser.
        </p>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="inline-flex gap-1 rounded-[var(--radius-card)] border border-border-default bg-card p-1"
        >
          {THEMES.map(({ value, label, icon: Icon }) => {
            const active = preference === value;
            return (
              <button
                key={value}
                role="radio"
                aria-checked={active}
                onClick={() => setPreference(value)}
                className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] transition-colors ${
                  active ? 'bg-active font-medium text-ink' : 'text-ink-secondary hover:bg-hover'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="pt-8">
        <h2 className="mb-1 text-sm font-medium text-ink">Date &amp; time</h2>
        <p className="mb-4 text-[13px] text-muted">
          How dates and times display across the app. Preview:{' '}
          <span className="font-medium text-ink">{formatDateTime(new Date(), regional)}</span>
        </p>
        <div className="flex max-w-md flex-col gap-4">
          <SelectRow
            label="Date format"
            value={regional.dateFormat}
            options={DATE_OPTIONS}
            disabled={prefs.isLoading}
            onChange={(v) => setRegional({ dateFormat: v })}
            preview={formatDate(new Date(), { ...regional, dateFormat: regional.dateFormat })}
          />
          <SelectRow
            label="Time format"
            value={regional.timeFormat}
            options={TIME_OPTIONS}
            disabled={prefs.isLoading}
            onChange={(v) => setRegional({ timeFormat: v })}
          />
          <SelectRow
            label="First day of week"
            value={regional.firstDayOfWeek}
            options={WEEK_OPTIONS}
            disabled={prefs.isLoading}
            onChange={(v) => setRegional({ firstDayOfWeek: v })}
          />
        </div>
      </section>
    </div>
  );
}

function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  preview,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  preview?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-ink-secondary">
        {label}
        {preview && <span className="ml-2 text-[12px] text-faint">{preview}</span>}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-w-40 rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
