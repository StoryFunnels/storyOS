'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export default function PreferencesPage() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Preferences</h1>
      <p className="mb-6 text-[13px] text-muted">Personal settings — they apply on this browser.</p>

      <section>
        <h2 className="mb-1 text-sm font-medium text-ink">Appearance</h2>
        <p className="mb-3 text-[13px] text-muted">
          Choose a theme. System follows your device setting.
        </p>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="inline-flex gap-1 rounded-[var(--radius-card)] border border-border-default bg-card p-1"
        >
          {OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = preference === value;
            return (
              <button
                key={value}
                role="radio"
                aria-checked={active}
                onClick={() => setPreference(value)}
                className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] transition-colors ${
                  active
                    ? 'bg-active font-medium text-ink'
                    : 'text-ink-secondary hover:bg-hover'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
