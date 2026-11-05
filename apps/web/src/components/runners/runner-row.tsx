'use client';

import { Button } from '@/components/ui/button';
import { ClientLogo } from '@/components/connect-ai-logos';
import { describeRunner } from '@/lib/runners/status';
import type { RunnerDto, RunnerSharingPatch } from '@/lib/runners/types';
import { agentsLine, COPY, shortDate, toolName } from '@/lib/runners/words';
import type { TimeOpts } from '@/lib/runners/words';
import { SharingSection } from './sharing-section';
import { StatusMark } from './status-mark';

/**
 * Ticket #1139 AC4 — one Runner on Settings › Runners: machine, tool, paired date, the agents it runs, its live status, "Sharing
 * your subscription" under Advanced, and Remove.
 *
 * "Sharing your subscription" (working hours, keep a share for me) is real since ticket #1137: `SharingSection` reads and writes
 * the Runner's own rules through `onSaveSharing`. Without that callback, or for a viewer who may not edit, it renders read-only.
 */
const noSave = () => Promise.reject(new Error('Cannot save here.'));

export function RunnerRow({
  runner,
  now,
  onRemove,
  removing,
  tz,
  canEditSharing = false,
  onSaveSharing,
}: {
  runner: RunnerDto;
  now: Date;
  onRemove: () => void;
  removing?: boolean;
  tz?: TimeOpts;
  /** Whether the viewer may change this Runner's sharing rules (`canEditSharing` in lib/runners/sharing.ts). */
  canEditSharing?: boolean;
  onSaveSharing?: (patch: RunnerSharingPatch) => Promise<void>;
}) {
  const status = describeRunner(runner, now, tz);
  const tool = toolName(runner.chosen_tool, runner.tools);
  return (
    <div className="rounded-[var(--radius-card)] border border-border-default bg-card" data-testid="runner-row">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-2 min-h-[46px]">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-hover text-ink-secondary">
          <ClientLogo client={runner.chosen_tool === 'claude-code' ? 'claude' : 'other'} />
        </span>
        <span className="flex min-w-[180px] flex-1 flex-col leading-[1.35]">
          <b className="text-body font-medium leading-[1.35] text-ink">{runner.name}</b>
          <span className="text-label leading-[1.35] text-muted">
            {tool} · paired {shortDate(runner.paired_at, tz)} · {agentsLine(runner.agents)}
          </span>
        </span>
        <StatusMark tone={status.tone}>{status.label}</StatusMark>
      </div>
      <details className="group border-t border-border-default">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-body font-semibold text-ink [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
            ›
          </span>
          Sharing your subscription
          <span className="text-label font-normal text-muted">· keep some for yourself</span>
        </summary>
        <SharingSection runner={runner} editable={canEditSharing} onSave={onSaveSharing ?? noSave} />
      </details>
      <div className="flex flex-wrap items-center gap-3 border-t border-border-default px-3.5 py-2 min-h-[46px]">
        <span className="flex min-w-[180px] flex-1 flex-col leading-[1.35]">
          <b className="text-body font-medium text-ink">Remove this Runner</b>
          <span className="text-label text-muted">{COPY.removeRow}</span>
        </span>
        <Button type="button" variant="secondary" size="sm" className="text-error" disabled={removing} onClick={onRemove}>
          Remove…
        </Button>
      </div>
    </div>
  );
}
