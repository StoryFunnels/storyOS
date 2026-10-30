'use client';

import { Check, ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { buildRunsOnMenu, runsOnLine } from '@/lib/runners/runs-on';
import { describeRunnerShort } from '@/lib/runners/status';
import type { RunnerDto } from '@/lib/runners/types';

/**
 * Ticket #1139 AC3 — "Runs on <machine> · <tool> [Change]", on the agent page and on the hire card (the prototype's `.runson`).
 *
 * `runners` is ALREADY the agent owner's list (`ownerRunners`, ADR-0021 Q2), so this component cannot show someone else's
 * machine: it has no other list to draw. When `canChange` is false (an admin on a colleague's agent) the line is plain text with
 * no Change button, because neither listing nor assigning another person's Runner is possible. There is no API-key item: it is
 * not in v1 (Dara, ticket #1139), and `buildRunsOnMenu` cannot produce one.
 */
export function RunsOnLine({
  assigned,
  runners,
  canChange,
  onPick,
  onAdd,
  now,
  pending,
  masked = false,
}: {
  assigned: { id: string; name: string } | null;
  runners: readonly RunnerDto[];
  canChange: boolean;
  onPick: (runnerId: string) => void;
  onAdd: () => void;
  now: Date;
  pending?: boolean;
  /** A viewer who may not be told the machine or tool (a guest): "Runs on a Runner", no Change. */
  masked?: boolean;
}) {
  const line = runsOnLine(assigned, runners, masked);
  const items = buildRunsOnMenu(runners, assigned?.id);
  return (
    <div className="flex flex-wrap items-center gap-2 text-body text-ink-secondary" data-testid="runs-on">
      <span>
        Runs on{' '}
        {line.masked ? (
          <b className="font-semibold text-ink">a Runner</b>
        ) : line.kind === 'none' ? (
          <b className="font-semibold text-ink">No Runner yet</b>
        ) : (
          <>
            <b className="font-semibold text-ink">{line.machine}</b>
            {line.tool ? <> · {line.tool}</> : null}
          </>
        )}
      </span>
      {canChange && !masked && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" size="sm" disabled={pending} aria-haspopup="menu">
              Change
              <ChevronDown className="h-[11px] w-[11px]" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[272px]">
            {items.map((item) =>
              item.kind === 'runner' ? (
                <DropdownMenuItem key={item.runner.id} onSelect={() => onPick(item.runner.id)} className="items-start gap-2">
                  <span className="mt-px w-[13px] shrink-0 text-primary-text">{item.selected ? <Check className="h-[13px] w-[13px]" aria-hidden /> : null}</span>
                  <span className="min-w-0">
                    <b className="block text-body font-medium text-ink">{item.runner.name}</b>
                    <span className="block text-meta leading-[1.4] text-muted">{describeRunnerShort(item.runner, now)}</span>
                  </span>
                </DropdownMenuItem>
              ) : null,
            )}
            {items.length > 1 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={onAdd} className="items-start gap-2">
              <span className="mt-px w-[13px] shrink-0 text-primary-text">
                <Plus className="h-[13px] w-[13px]" aria-hidden />
              </span>
              <span className="min-w-0">
                <b className="block text-body font-medium text-ink">Add a Runner…</b>
                <span className="block text-meta leading-[1.4] text-muted">Use your Claude Code or Cursor subscription</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
