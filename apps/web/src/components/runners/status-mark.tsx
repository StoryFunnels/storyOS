import type { ReactNode } from 'react';
import type { StatusTone } from '@/lib/runners/status';
import { cn } from '@/lib/utils';

/**
 * Ticket #1139 — the dot and the label that say what a Runner or a run is doing (the prototype's `.rstat`).
 *
 * Gold appears ONLY on `go` (a run in progress, pulsing) and `ask` (a run waiting for your approval): gold means the agent is
 * acting or asking (#831, #1163). Everything else is deliberately calm: waiting and offline are grey, the limit wait is amber
 * (`--warning`, with `--warning-text` for the words so they clear contrast), a failure uses the error colour and a cancel is a
 * hollow grey ring. `status.ts` pins which tones are gold; this file only paints them.
 *
 * The state is also WORDS, never colour alone: the label is always rendered.
 */
const TONE: Record<StatusTone, { text: string; dot: string }> = {
  on: { text: 'text-success', dot: 'bg-success' },
  off: { text: 'text-muted', dot: 'bg-faint' },
  limit: { text: 'text-warning-text', dot: 'bg-warning' },
  go: { text: 'text-accent-text', dot: 'bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)] motion-safe:animate-pulse' },
  // The prototype draws "Needs your approval" as a tinted pill (its `.rstat.ask` also matches an unrelated `.ask` rule, 13px with a
  // tinted wash). Ievgen approved what was RENDERED, so the pill is built; see the ticket for the one-line question to Dara.
  ask: { text: 'text-accent-text rounded-[var(--radius-control)] bg-active px-[11px] py-2 text-body leading-[15px]', dot: 'bg-accent' },
  done: { text: 'text-muted', dot: 'bg-success' },
  fail: { text: 'text-error', dot: 'bg-error' },
  cancel: { text: 'text-muted', dot: 'border-[1.5px] border-faint bg-transparent' },
};

export function StatusMark({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  const t = TONE[tone];
  return (
    <span data-tone={tone} className={cn('inline-flex items-center gap-1.5 text-label font-semibold leading-[14px]', t.text, className)}>
      <i aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', t.dot)} />
      {children}
    </span>
  );
}
