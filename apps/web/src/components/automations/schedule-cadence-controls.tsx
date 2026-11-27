'use client';

import { useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { MenuSelect } from '@/components/ui/menu-select';
import { DEFAULT_SCHEDULE_MINUTES, halfHourTimes, minutesDraft, minutesHelper } from '@/lib/schedule-form';
import { cn } from '@/lib/utils';

/**
 * Ticket #1318 — the automation editor's "how often" row: a themed menu (every … minutes / hour / day / week), the interval box when
 * minutes is chosen, the time of day for a daily or weekly rule, and the one-line note on when it will run (or why it cannot).
 *
 * A pure view over the form's state, so a rule saved with a minutes interval (API or MCP) can be rendered and read in a test. The
 * limits and the refusal wording are the API's own (`minutesDraft` -> `scheduleProblems`).
 */
export function ScheduleCadenceControls({
  trigger,
  every,
  onEvery,
  at,
  onAt,
  minutesText,
  onMinutesText,
}: {
  /** The rule as saved, if any: supplies the time zone and the active window the note names, and an off-grid saved time. */
  trigger?: { at?: string; timezone?: string; between?: { from: string; to: string } };
  every: string;
  onEvery: (every: string) => void;
  at: string;
  onAt: (at: string) => void;
  minutesText: string;
  onMinutesText: (text: string) => void;
}) {
  const check = minutesDraft(minutesText);
  const box = useRef<HTMLInputElement>(null);
  const focusBox = useRef(false);
  useEffect(() => {
    if (every === 'minutes' && focusBox.current) {
      focusBox.current = false;
      box.current?.focus();
      box.current?.select();
    }
  }, [every]);

  return (
    <>
      <MenuSelect
        label="How often"
        align="start"
        value={every}
        onChange={(v) => {
          onEvery(v);
          if (v === 'minutes') {
            // Picking minutes lands the cursor in the box with a usable default, so the choice is never an empty interval.
            if (minutesText.trim() === '') onMinutesText(String(DEFAULT_SCHEDULE_MINUTES));
            focusBox.current = true;
          }
        }}
        options={[
          { value: 'minutes', label: every === 'minutes' && check.value !== null ? `every ${check.value} minutes` : 'every … minutes' },
          { value: 'hour', label: 'every hour' },
          { value: 'day', label: 'every day' },
          { value: 'week', label: 'every week' },
        ]}
      />
      {every === 'minutes' && (
        <Input
          ref={box}
          className={cn('h-7 w-16 text-center', check.error && 'border-error')}
          inputMode="numeric"
          aria-label="Minutes between runs"
          aria-invalid={check.error ? true : undefined}
          value={minutesText}
          onChange={(e) => onMinutesText(e.target.value)}
          data-testid="schedule-minutes"
        />
      )}
      {every !== 'hour' && every !== 'minutes' && (
        <MenuSelect
          label="Time of day"
          align="start"
          value={at}
          onChange={onAt}
          options={halfHourTimes(trigger?.at).map((t) => ({ value: t, label: t }))}
        />
      )}
      {every === 'minutes' &&
        (check.error ? (
          <p role="alert" className="basis-full text-label text-error" data-testid="schedule-minutes-error">
            {check.error}
          </p>
        ) : (
          check.value !== null && (
            <p className="basis-full text-label text-muted" data-testid="schedule-minutes-note">
              {minutesHelper(check.value, trigger?.timezone ?? 'server time', trigger?.between?.from)}
            </p>
          )
        ))}
    </>
  );
}
