'use client';

import { Button } from '@/components/ui/button';
import { ClientLogo } from '@/components/connect-ai-logos';
import { Switch } from '@/components/ui/switch';
import { describeRunner } from '@/lib/runners/status';
import type { RunnerDto } from '@/lib/runners/types';
import { agentsLine, COPY, limitBrand, shortDate, toolName } from '@/lib/runners/words';
import type { TimeOpts } from '@/lib/runners/words';
import { StatusMark } from './status-mark';

/**
 * Ticket #1139 AC4 — one Runner on Settings › Runners: machine, tool, paired date, the agents it runs, its live status, "Sharing
 * your subscription" under Advanced, and Remove.
 *
 * "Sharing your subscription" (quiet hours, keep a share for me) is DRAWN and NOT WIRED: ticket #1137 builds it. The switches are
 * disabled and the section says so in words, because a working-looking switch that saves nothing is a lie about what an agent
 * will do on someone's own subscription. Nothing here reads or writes a setting.
 */
export function RunnerRow({
  runner,
  now,
  onRemove,
  removing,
  tz,
}: {
  runner: RunnerDto;
  now: Date;
  onRemove: () => void;
  removing?: boolean;
  tz?: TimeOpts;
}) {
  const status = describeRunner(runner, now, tz);
  const tool = toolName(runner.chosen_tool, runner.tools);
  const brand = limitBrand(runner.chosen_tool, runner.tools);
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
        <div className="border-t border-border-default" data-testid="advanced-sharing">
          <p className="m-0 px-3.5 pt-2.5 text-label text-muted">
            <span className="mr-1.5 inline-flex h-[18px] items-center rounded-full border border-dashed border-border-strong px-1.5 text-micro font-[650] tracking-[0.02em] text-muted">
              NOT YET
            </span>
            These are not switched on yet, so they change nothing today.
          </p>
          <div className="flex items-center gap-3 px-3.5 py-2">
            <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
              <b className="text-body font-medium text-ink">Quiet hours</b>
              <span className="text-label text-muted">Agents don’t start while you’re working, 9:00 to 18:00</span>
            </span>
            <Switch checked={false} onCheckedChange={() => {}} disabled aria-label="Quiet hours (not available yet)" />
          </div>
          <div className="flex items-center gap-3 border-t border-border-default px-3.5 py-2">
            <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
              <b className="text-body font-medium text-ink">Keep a share for me</b>
              <span className="text-label text-muted">Agents pause when 80% of your {brand} limit is used</span>
            </span>
            <Switch checked={false} onCheckedChange={() => {}} disabled aria-label="Keep a share for me (not available yet)" />
          </div>
        </div>
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
