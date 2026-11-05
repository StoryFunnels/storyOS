'use client';

import { useRef, useState } from 'react';
import { SettingsPill } from '@/components/settings/settings-chrome';
import { MenuSelect } from '@/components/ui/menu-select';
import { segmentedItemVariants } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import {
  browserTimeZone,
  DAYS,
  draftFromServer,
  hoursBody,
  hoursProblem,
  hoursSwitch,
  hoursSummary,
  overnightHint,
  reserveOptions,
  reserveSwitch,
  reserveView,
  timeOptions,
  toggleDay,
  zoneSentence,
} from '@/lib/runners/sharing';
import type { HoursDraft } from '@/lib/runners/sharing';
import type { RunnerDto, RunnerSharingPatch } from '@/lib/runners/types';
import { cn } from '@/lib/utils';

/**
 * Ticket #1137 — "Sharing your subscription", the part of a Runner row that lets a person keep their own Claude or Cursor time.
 * Two rules, each saved the moment it is changed (the Runners page's own pattern: the tool menu and Remove act at once):
 *
 *  - Working hours: the window agents may START in. Built from the product's own menus, never a native time input.
 *  - Keep a share for me: "leave me X%". Where the tool cannot report plan usage (Claude Code) the page SAYS so, in a note that is
 *    always visible, and marks any stored value as not kept. It never implies protection it cannot give.
 *
 * Presentational: the page owns the mutation and hands `onSave`. A refusal from the API (a 422) is shown in the API's words and the
 * field goes back to what the server holds. A draft the API would refuse (no day chosen) is kept on screen and not sent.
 */
export function SharingSection({
  runner,
  editable,
  onSave,
  computerZone,
}: {
  runner: RunnerDto;
  editable: boolean;
  /** Rejects with an Error whose message is shown as it is. */
  onSave: (patch: RunnerSharingPatch) => Promise<void>;
  /** Test seam: the computer's own zone. The app passes nothing. */
  computerZone?: string;
}) {
  const zone = computerZone ?? browserTimeZone();
  const server = runner.working_hours ?? null;
  // undefined = follow the server; null = switched off, saving; a draft = being edited.
  const [hours, setHours] = useState<HoursDraft | null | undefined>(undefined);
  const [reserve, setReserve] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // Saves run one after another, in the order the person made them, so the server's last write is their last edit.
  const chain = useRef<Promise<void>>(Promise.resolve());
  // The latest draft, read by handlers instead of the render closure: two quick clicks must build on each other, not on one stale render.
  const latestHours = useRef<HoursDraft | null | undefined>(undefined);
  const serverDraft = server ? draftFromServer(server) : null;

  const shownHours: HoursDraft | null = hours !== undefined ? hours : serverDraft;
  const problem = shownHours ? hoursProblem(shownHours) : null;
  const shownReserve = reserve !== undefined ? reserve : (runner.reserve_percent ?? null);
  const rv = reserveView({ ...runner, reserve_percent: shownReserve });

  function pushHours(next: HoursDraft | null | undefined) {
    latestHours.current = next;
    setHours(next);
  }
  const currentHours = () => (latestHours.current !== undefined ? latestHours.current : serverDraft);

  // Every edit (including one that is not sent because it has a problem) is a new "latest", so an older save finishing can never
  // wipe a newer draft that is still being worked out.
  function save(patch: RunnerSharingPatch, restore: () => void) {
    const mine = seq.current;
    setError(null);
    chain.current = chain.current.then(async () => {
      try {
        await onSave(patch);
        // Only the latest request lets go of the draft: an older answer must not flash an older value over a newer edit.
        if (mine === seq.current) restore();
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Could not save that. Your earlier setting is kept.');
        if (mine === seq.current) restore();
      }
    });
  }

  function editHours(change: (prev: HoursDraft) => HoursDraft) {
    const prev = currentHours();
    if (!prev) return;
    const next = change(prev);
    seq.current++;
    pushHours(next);
    const body = hoursBody(next);
    if (body) save({ working_hours: body }, () => pushHours(undefined));
  }
  function setHoursOn(on: boolean) {
    const s = hoursSwitch(on, zone);
    seq.current++;
    pushHours(s.draft);
    save(s.patch, () => pushHours(undefined));
  }
  function saveReserve(n: number | null) {
    seq.current++;
    setReserve(n);
    save({ reserve_percent: n }, () => setReserve(undefined));
  }

  const row = 'flex items-center gap-3 px-3.5 py-2';
  return (
    <div className="border-t border-border-default" data-testid="advanced-sharing">
      {/* Working hours */}
      <div className={row}>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
          <b className="text-body font-medium leading-[1.35] text-ink">Working hours</b>
          <span className="text-label leading-[1.35] text-muted" data-testid="hours-summary">
            {shownHours && !problem ? hoursSummary(hoursBody(shownHours)) : shownHours ? 'Not saved yet. The hours you last saved stay in force until this is complete.' : hoursSummary(null)}
          </span>
        </span>
        {editable && <Switch checked={shownHours !== null} onCheckedChange={setHoursOn} aria-label="Working hours" />}
      </div>
      {shownHours && !editable && <p className="m-0 px-3.5 pb-2.5 text-label text-muted">{zoneSentence(shownHours.timezone, zone)}</p>}
      {shownHours && editable && (
        <div className="flex flex-col gap-2 px-3.5 pb-2.5" data-testid="hours-editor">
          <div role="group" aria-label="Days" className="flex flex-wrap gap-1">
            {DAYS.map((d) => {
              const on = shownHours.days.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => editHours((prev) => toggleDay(prev, d.key))}
                  className={cn(segmentedItemVariants({ size: 'sm', variant: 'subtle', selected: on }), 'border border-border-default')}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-label text-muted">
            <span>From</span>
            <MenuSelect label="Start time" value={shownHours.start} options={timeOptions(shownHours.start)} onChange={(v) => editHours((prev) => ({ ...prev, start: v }))} className="min-w-[5.5rem]" />
            <span>to</span>
            <MenuSelect label="End time" value={shownHours.end} options={timeOptions(shownHours.end)} onChange={(v) => editHours((prev) => ({ ...prev, end: v }))} className="min-w-[5.5rem]" />
          </div>
          <p className="m-0 text-label text-muted">
            {zoneSentence(shownHours.timezone, zone)}
            {overnightHint(shownHours) ? ` ${overnightHint(shownHours)}` : ''} A run already going when the hours end finishes.
          </p>
          {problem && (
            <p role="alert" className="m-0 text-label text-error" data-testid="hours-problem">
              {problem}
            </p>
          )}
        </div>
      )}

      {/* Keep a share for me */}
      <div className={cn(row, 'border-t border-border-default')}>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
          <b className="flex flex-wrap items-center gap-2 text-body font-medium leading-[1.35] text-ink">
            Keep a share for me
            {rv.pill && <SettingsPill tone={rv.pill.tone}>{rv.pill.label}</SettingsPill>}
          </b>
          <span className="text-label leading-[1.35] text-muted" data-testid="reserve-summary">
            {rv.summary}
          </span>
        </span>
        {editable && shownReserve !== null && (
          <MenuSelect label="Share to keep for you" value={String(shownReserve)} options={reserveOptions(shownReserve)} onChange={(v) => saveReserve(Number(v))} className="min-w-[4.5rem] max-w-[6rem]" />
        )}
        {editable && <Switch checked={shownReserve !== null} onCheckedChange={(on) => saveReserve(reserveSwitch(on))} aria-label="Keep a share for me" />}
      </div>
      {rv.message && (
        <p className="m-0 mx-3.5 mb-2.5 rounded-[var(--radius-control)] border border-border-default bg-hover px-2.5 py-2 text-label leading-[1.45] text-ink-secondary" data-testid="reserve-unmeasurable">
          <b className="font-semibold text-ink">Cannot be measured for this tool.</b> {rv.message}
        </p>
      )}

      {!editable && <p className="m-0 border-t border-border-default px-3.5 py-2 text-label text-muted">Only the person who owns this Runner can change these.</p>}
      {error && (
        <p role="alert" className="m-0 border-t border-border-default px-3.5 py-2 text-label text-error" data-testid="sharing-error">
          {error}
        </p>
      )}
    </div>
  );
}
