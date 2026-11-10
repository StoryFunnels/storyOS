'use client';

import { toast } from 'sonner';
import { MenuSelect } from '@/components/ui/menu-select';
import { Switch } from '@/components/ui/switch';
import { SettingsBox, SettingsRow } from '@/components/settings/settings-chrome';
import {
  MY_WORK_EXAMPLE_URL,
  WEEKDAY_OPTIONS,
  browserTimeZone,
  myWorkEmailOf,
  myWorkEmailPatch,
  timeOptions,
  zoneLabel,
} from '@/lib/my-work-email';
import type { MyWorkEmailPrefs } from '@/lib/my-work-email';
import { usePreferences, useUpdatePreferences } from '@/lib/preferences';

const FREQUENCY_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'daily', label: 'Daily, Mon–Fri' },
  { value: 'weekly', label: 'Weekly' },
];

/**
 * "Email me my work" (ticket #1252, Dara's prototype v65): one box on Settings > Notifications. How often (Off / Daily / Weekly), and
 * when it is not Off: the day (Weekly only) and time in the person's zone, and whether to include what they assigned to others.
 * Built on the shared settings chrome and the product's own dropdown menu (MenuSelect), never a native select.
 *
 * Renders nothing until the API has returned the saved group: a default shown before that would pass for the person's choice, and an
 * API without the group (older than PR 1470) cannot be edited from here.
 */
export function MyWorkEmailBox() {
  const prefs = usePreferences();
  const update = useUpdatePreferences();
  const saved = myWorkEmailOf(prefs.data);
  if (!saved) return null;

  const save = (change: Partial<MyWorkEmailPrefs>) =>
    update.mutate(myWorkEmailPatch(change, browserTimeZone()), { onError: () => toast.error('Could not save — try again') });
  const here = browserTimeZone();
  const on = saved.frequency !== 'off';

  return (
    <SettingsBox title="Email me my work" aside="email only, never in your Inbox">
      <SettingsRow
        title="How often"
        description="What is waiting on you and assigned to you, in one email. Daily means Monday to Friday. Overdue first, then due this week, then In Progress. When there is nothing on it, nothing is sent."
      >
        <MenuSelect
          label="How often"
          value={saved.frequency}
          options={FREQUENCY_OPTIONS}
          disabled={update.isPending}
          onChange={(v) => save({ frequency: v as MyWorkEmailPrefs['frequency'] })}
        />
      </SettingsRow>
      {on && (
        <SettingsRow
          title="When"
          description={
            <>
              In your time zone: {zoneLabel(saved.timezone)}.
              {here && saved.timezone !== here && ` Saving a change here uses this browser’s zone, ${zoneLabel(here)}.`}
            </>
          }
        >
          {saved.frequency === 'weekly' && (
            <>
              <span className="text-label text-muted">on</span>
              <MenuSelect
                label="Day"
                value={String(saved.weekday)}
                options={WEEKDAY_OPTIONS}
                disabled={update.isPending}
                onChange={(v) => save({ weekday: Number(v) })}
                className="min-w-[6.5rem]"
              />
            </>
          )}
          <span className="text-label text-muted">at</span>
          <MenuSelect
            label="Time"
            value={saved.time}
            options={timeOptions(saved.time)}
            disabled={update.isPending}
            onChange={(v) => save({ time: v })}
            className="min-w-[5rem]"
          />
        </SettingsRow>
      )}
      {on && (
        <SettingsRow
          title="Include what I assigned to others"
          description="Records you handed to someone else that are still open, overdue first."
          inlineControls
        >
          <Switch
            checked={saved.include_assigned_by_me}
            disabled={update.isPending}
            aria-label="Include what I assigned to others"
            onCheckedChange={(v) => save({ include_assigned_by_me: v })}
          />
        </SettingsRow>
      )}
      <SettingsRow
        title="What the email lists"
        description="Only what you can open, the same list as My Work. Every one ends with Customize these emails · Stop these emails."
      >
        <a href={MY_WORK_EXAMPLE_URL} target="_blank" rel="noopener noreferrer" className="text-label font-medium text-primary-text underline-offset-2 hover:underline">
          See an example {'→'}
        </a>
      </SettingsRow>
    </SettingsBox>
  );
}
