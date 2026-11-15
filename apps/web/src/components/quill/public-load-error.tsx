'use client';

import { startTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/ui/button';

/**
 * Ticket #1291 — a public page whose LOAD failed (the API is down or answered 5xx). That is not a 404: the link may be perfectly
 * good, so this says so and offers a retry instead of the "doesn't exist" page. Used as the `error.tsx` of each public route.
 */
/**
 * "Try again". `reset()` alone only re-renders the segment with the error the server already stored, so the page never asks the
 * server again (seen live: the API came back and the button did nothing). The documented recovery is to refresh the route's server
 * data and reset together, inside one transition, so the retry really issues a new request and the boundary clears when it lands.
 */
export function retryLoad(refresh: () => void, reset: () => void, transition: (fn: () => void) => void = startTransition): void {
  transition(() => {
    refresh();
    reset();
  });
}

export function PublicLoadError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportError(error, { boundary: 'public-route' });
  }, [error]);
  return (
    <main className="min-h-screen bg-app">
      <div className="mx-auto flex max-w-[440px] flex-col items-center gap-2.5 px-4 pb-10 pt-[12vh] text-center" data-testid="public-load-error">
        <h1 className="m-0 text-title font-bold leading-[1.25] text-ink">We couldn’t load this page</h1>
        <p className="m-0 text-body text-muted">The link may be fine. Something went wrong on our side, so try again in a moment.</p>
        {error.digest ? <p className="m-0 font-mono text-meta text-faint">Reference: {error.digest}</p> : null}
        <div className="mt-2">
          <Button variant="primary" size="sm" onClick={() => retryLoad(() => router.refresh(), reset)}>
            Try again
          </Button>
        </div>
      </div>
    </main>
  );
}
