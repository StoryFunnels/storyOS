import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Ticket #1186 — the page chrome of the Settings pages Dara drew (#974): a heading with a one-line lead, boxes of rows, a status pill,
 * and an "Advanced" disclosure for the power controls. It is the prototype's `.sbox / .srow / .pill2 / details.adv` made once, so the
 * pages built on it (General, Members, Plan & billing, Packs here; the other four Settings tickets after) cannot each draw their own
 * row and drift. Chrome only: what a row holds is the page's business.
 */

export function SettingsPageHeader({ title, lead, action }: { title: string; lead?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-[18px] flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-bold leading-[1.3] tracking-[-0.01em] text-ink">{title}</h1>
        {lead && <p className="mt-1 text-body text-muted">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

/** A page body: one column at the reading width, boxes 18px apart. */
export function SettingsPageBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[18px]">{children}</div>;
}

export function SettingsBox({
  title,
  aside,
  children,
  className,
}: {
  title?: string;
  /** Muted text on the right of the title: a count, a state. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-[var(--radius-card)] border border-border-default bg-card', className)}>
      {title && (
        <h2 className="flex items-center gap-2 border-b border-border-default px-3.5 py-[11px] text-body leading-[normal]! font-[650] text-ink">
          {title}
          {aside && <span className="ml-auto text-label font-medium text-muted">{aside}</span>}
        </h2>
      )}
      {children}
    </section>
  );
}

/** One row: the words on the left (a title and a line saying what it does, always visible), the controls on the right. */
export function SettingsRow({
  title,
  description,
  leading,
  children,
  className,
  inlineControls,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** A small control (a switch) that stays beside the words on a phone instead of dropping under them at full width. */
  inlineControls?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-default px-3.5 py-2 text-body first:border-t-0',
        className,
      )}
    >
      {leading}
      <div className={cn('flex min-w-0 flex-1 flex-col leading-[1.35]', !inlineControls && 'max-sm:basis-full')}>
        <b className="truncate font-medium text-ink">{title}</b>
        {description && <span className="text-label leading-[1.35]! text-muted">{description}</span>}
      </div>
      {children && (
        <div
          className={cn(
            'flex shrink-0 flex-wrap items-center gap-2',
            // On a phone the controls take their own line and share it. A switch is never one of the buttons that stretches (it was
            // drawn 328px wide with its knob at the left): its width is its own.
            !inlineControls && 'max-sm:w-full max-sm:[&>button:not([role=switch])]:flex-1',
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export type SettingsPillTone = 'neutral' | 'ok' | 'warn' | 'bad';

const PILL_TONE: Record<SettingsPillTone, string> = {
  neutral: 'bg-hover text-ink-secondary',
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning-text',
  bad: 'bg-error/10 text-error',
};

export function SettingsPill({ tone = 'neutral', children }: { tone?: SettingsPillTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-[var(--radius-chip)] px-2 text-meta font-semibold',
        PILL_TONE[tone],
      )}
    >
      <i className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

/**
 * The power controls of a page, one click away and never a hover: a labelled disclosure. `summary` says what is inside, so a person
 * need not open it to know whether it is the thing they want.
 */
export function AdvancedSection({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-[var(--radius-card)] border border-border-default bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3.5 py-[11px] text-body leading-[normal]! font-semibold text-ink-secondary group-open:border-b group-open:border-border-default [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        {title}
        <span className="text-label font-medium text-muted max-sm:basis-full max-sm:pl-5">{summary}</span>
      </summary>
      {children}
    </details>
  );
}
