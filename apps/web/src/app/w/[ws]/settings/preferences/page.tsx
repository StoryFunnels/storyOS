'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { usePreferences, useUpdatePreferences } from '@/lib/preferences';
import type { UserPreferences } from '@/lib/preferences';
import { formatDate, formatDateTime, friendlyDateExample, DEFAULT_REGIONAL } from '@/lib/format';
import { MenuSelect } from '@/components/ui/menu-select';
import { Segmented } from '@/components/ui/segmented';
import { SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRow } from '@/components/settings/settings-chrome';

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

type Regional = UserPreferences['regional'];
/** A function, not a constant: the Friendly example is drawn from today's date in the viewer's own order (ticket #1283 item 1). */
const dateOptions = (now: Date): { value: Regional['dateFormat']; label: string }[] => [
  { value: 'system', label: `Friendly (${friendlyDateExample(now)})` },
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

/**
 * Preferences (ticket #1189, Dara's #974 design): one box, one row per preference, the words on the left and the control on the
 * right. Every choice the page offered is still offered. A choice of two or three short options is the drawn segmented control,
 * as in the design: the theme and the time format (ticket #1283 item 2). The date format (four options, one of them a sentence) and
 * the first day of the week (four, including a day the design leaves out) keep the product's own menu, the same `MenuSelect` the
 * rest of Settings uses instead of the browser's native select (Dara's ruling on ticket #1191).
 */
export default function PreferencesPage() {
  const { preference, setPreference } = useTheme();
  const prefs = usePreferences();
  const update = useUpdatePreferences();
  const regional = prefs.data?.regional ?? DEFAULT_REGIONAL;

  const setRegional = (patch: Partial<Regional>) =>
    update.mutate({ regional: patch }, { onError: () => toast.error('Could not save — try again') });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Preferences" lead="Only for you, on this browser" />

      <SettingsPageBody>
        <SettingsBox>
          <SettingsRow title="Theme" description="System follows your device setting. Applies on this browser.">
            <Segmented
              label="Theme"
              value={preference}
              onChange={setPreference}
              options={THEMES.map(({ value, label, icon: Icon }) => ({
                value,
                label: (
                  <span className="flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                  </span>
                ),
              }))}
            />
          </SettingsRow>
          <SettingsRow
            title="Date format"
            description={`How dates display across the app. Now: ${formatDate(new Date(), { ...regional }, { relative: false })}`}
          >
            <MenuSelect
              label="Date format"
              value={regional.dateFormat}
              options={dateOptions(new Date())}
              disabled={prefs.isLoading}
              onChange={(v) => setRegional({ dateFormat: v as Regional['dateFormat'] })}
              className="max-w-none min-w-44"
            />
          </SettingsRow>
          <SettingsRow title="Time format" description={`12-hour or 24-hour clock. Now: ${formatDateTime(new Date(), regional, { relative: false })}`}>
            <Segmented
              label="Time format"
              value={regional.timeFormat}
              onChange={(v) => setRegional({ timeFormat: v })}
              options={TIME_OPTIONS.map((o) => ({ ...o, disabled: prefs.isLoading }))}
            />
          </SettingsRow>
          <SettingsRow title="Week starts on" description="The first day of the week, where one is shown.">
            <MenuSelect
              label="Week starts on"
              value={regional.firstDayOfWeek}
              options={WEEK_OPTIONS}
              disabled={prefs.isLoading}
              onChange={(v) => setRegional({ firstDayOfWeek: v as Regional['firstDayOfWeek'] })}
              className="max-w-none min-w-44"
            />
          </SettingsRow>
        </SettingsBox>
      </SettingsPageBody>
    </div>
  );
}
