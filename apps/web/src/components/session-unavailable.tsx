'use client';

import { useEffect } from 'react';
import { UPSTREAM_UNAVAILABLE_MESSAGE } from '@/lib/http-error';

const RETRY_MS = 5000;

/**
 * Ticket #948 — shown instead of redirecting to /login when the session check could not reach the
 * API (a deploy or restart: 502/503/504, or a network failure). The user is still signed in as far
 * as we know, so the page waits and re-asks on its own: every few seconds, when the tab becomes
 * visible again, and when the browser comes back online. `retry` is the session store's refetch.
 */
export function SessionUnavailable({ retry }: { retry: () => void }) {
  useEffect(() => {
    const id = window.setInterval(retry, RETRY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', retry);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', retry);
    };
  }, [retry]);

  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-body text-ink">{UPSTREAM_UNAVAILABLE_MESSAGE}</p>
      <p className="text-label text-muted">You are still signed in. This page will reload on its own when StoryOS is back.</p>
      <button
        type="button"
        onClick={retry}
        className="rounded-[var(--radius-control)] border border-border-default px-3 py-1.5 text-label text-ink hover:bg-hover"
      >
        Try again now
      </button>
    </div>
  );
}
