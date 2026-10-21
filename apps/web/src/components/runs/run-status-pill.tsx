import { runStatusLabel, runStatusTone } from '@/lib/run-labels';
import type { RunTone } from '@/lib/run-labels';
import { cn } from '@/lib/utils';

/** Tint + text per tone — the prototype's `.stp.st-*`: a 15–20% wash of the tone with the tone mixed into ink for text. */
const PILL_TONE: Record<RunTone, string> = {
  ok: 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[color-mix(in_srgb,var(--success)_65%,var(--ink))]',
  fail: 'bg-[color-mix(in_srgb,var(--error)_15%,transparent)] text-[color-mix(in_srgb,var(--error)_65%,var(--ink))]',
  wait: 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-[color-mix(in_srgb,var(--accent)_60%,var(--ink))] dark:text-ink',
  run: 'bg-[color-mix(in_srgb,var(--info,var(--accent))_16%,transparent)] text-ink',
  skip: 'bg-hover text-muted',
};

/** A run's state as a pill. The status is the API's own, which says `awaiting_approval` for a run with a waiting approval. */
export function RunStatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[19px] items-center whitespace-nowrap rounded-full px-[7px] text-micro font-semibold',
        PILL_TONE[runStatusTone(status)],
        className,
      )}
    >
      {runStatusLabel(status)}
    </span>
  );
}
