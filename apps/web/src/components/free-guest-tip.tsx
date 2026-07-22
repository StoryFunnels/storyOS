'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';

/**
 * MN-271 (#271): "viewers and guests are always free" (ADR-0009) is a billing
 * rule with no UI moment — nothing tells a user building a client portal or
 * form that inviting their client costs nothing. This surfaces it right where
 * something shareable gets created, without blocking that flow.
 *
 * Dismissible and non-blocking by design: an inline tip, not a modal or a
 * step in the creation flow. Dismissal is per-surface (`dismissKey` scopes the
 * localStorage entry) so closing it on one form/portal doesn't hide it
 * everywhere else.
 */
export function FreeGuestTip({
  dismissKey,
  href,
  children,
}: {
  /** Scopes the dismissal — e.g. a space/database id or a form's db id. */
  dismissKey: string;
  /** Deep link to Settings → Members, optionally prefilled (see members page). */
  href: string;
  children: React.ReactNode;
}) {
  const key = `storyos:free-guest-tip-dismissed:${dismissKey}`;
  const [dismissed, setDismissed] = useState(true); // default hidden until localStorage read, avoids a flash

  useEffect(() => {
    setDismissed(typeof window !== 'undefined' && window.localStorage.getItem(key) === '1');
  }, [key]);

  if (dismissed) return null;

  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-border-default bg-accent-soft px-3 py-2 text-[12px] text-ink">
      <span className="flex-1">
        {children}{' '}
        <Link href={href} className="font-medium text-accent underline-offset-2 hover:underline">
          Invite a guest →
        </Link>
      </span>
      <button
        type="button"
        className="shrink-0 text-faint hover:text-ink"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => {
          window.localStorage.setItem(key, '1');
          setDismissed(true);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
