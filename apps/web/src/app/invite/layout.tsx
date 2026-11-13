import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** Ticket #1302 — the invite link carries a bearer token in its query string, so the page never sends it onward as a Referer. */
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } };

export default function InviteLayout({ children }: { children: ReactNode }) {
  return children;
}
