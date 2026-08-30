'use client';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import posthog from 'posthog-js';
import { ThemeProvider } from '@/lib/theme';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { registerServiceWorker } from '@/lib/service-worker';
import { captureReferralCode } from '@/lib/referral';
import { useSession } from '@/lib/auth-client';
import { isIdentityChange } from '@/lib/identity-change';
import type { SeenIdentity } from '@/lib/identity-change';

/**
 * #468 — everything that must happen when the person using this tab changes.
 *
 * This used to be analytics only, and that was the whole bug: the identity change
 * was ALREADY observable at exactly the level the cache lives at, and only PostHog
 * was watching. The data cache was not, so an incoming user was painted the
 * outgoing user's sidebar until a manual reload.
 *
 * It watches the SESSION rather than the sign-out button on purpose. A sign-out
 * click is only one of the ways an identity ends: a session can expire, be
 * revoked, or be replaced by another tab signing in as someone else. Clearing
 * inside the sign-out handler covers one of those; watching the user id covers all
 * of them — and it cannot be forgotten by a second sign-out button, which is
 * precisely how this codebase has shipped one concept as several drifting copies
 * at least six times (#375, #380, #383, #399, #408, #422).
 */
function IdentitySync() {
  const { data: session, isPending } = useSession();
  const queryClient = useQueryClient();
  const seen = useRef<SeenIdentity>(undefined);

  useEffect(() => {
    // Never act on a half-known state: mid-load `data` is undefined, which is
    // indistinguishable from "signed out" until it settles.
    if (isPending) return;
    const current = session?.user?.id ?? null;

    if (isIdentityChange(seen.current, current)) {
      // Order matters: drop the previous person's data BEFORE anything can read
      // it again. `clear()` empties the whole cache, not just the sidebar's keys —
      // every key in this app is workspace-scoped, none is user-scoped, so there
      // is no subset that is safe to keep.
      queryClient.clear();
      posthog.reset();
    }
    seen.current = current;

    if (session?.user) {
      posthog.identify(session.user.id, {
        name: session.user.name,
        email: session.user.email,
      });
    }
  }, [isPending, session?.user?.id, queryClient]);

  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
      }),
  );
  useEffect(() => {
    registerServiceWorker();
    captureReferralCode();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfirmProvider>
          <IdentitySync />
          {children}
        </ConfirmProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
