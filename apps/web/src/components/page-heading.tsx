import type { ReactNode } from 'react';

/**
 * Ticket #1279 item 3 — the page title the design reference draws: 22px/700 with -0.02em tracking, and under it a 13px muted
 * one-line status ("3 unread", "You’re all caught up"). ONE definition, so the next page that adopts the reference title
 * does not hand-write its own size (the audit found 20/600 on Home, 14/600 on Inbox and My work, 24/600 on a record).
 *
 * Only the Inbox uses it so far: moving every page onto one title style is a cross-page change, filed on the ticket, not
 * slipped in here. The subtitle is a real number or nothing — pass `null` while it is loading, never a guess.
 */
export function PageHeading({ title, subtitle, className }: { title: ReactNode; subtitle?: string | null; className?: string }) {
  return (
    <div className={className}>
      <h1 className="text-[22px] font-bold leading-[27px] tracking-[-0.02em] text-ink">{title}</h1>
      {subtitle ? <p className="mt-1 text-body text-muted">{subtitle}</p> : null}
    </div>
  );
}
