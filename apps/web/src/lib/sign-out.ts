'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { authClient } from '@/lib/auth-client';

/**
 * THE sign-out path (#468).
 *
 * There were two, and they had already drifted: `account-menu.tsx` called
 * `posthog.reset()` before signing out and `sidebar.tsx` did not. That divergence
 * is the reason this exists as a hook rather than as two more lines added to each
 * button — #468's fix has to happen on EVERY sign-out, and a second copy is
 * exactly where it would have been forgotten.
 *
 * Note what is deliberately NOT here: clearing the query cache and resetting
 * analytics. Both are driven by the identity change itself, in `IdentitySync`
 * (`app/providers.tsx`), because a session also ends by expiring, by being
 * revoked, or by another tab signing in as someone else — none of which run this
 * function. Putting the cache clear here would fix the button and leave the other
 * three routes leaking the previous user's data.
 */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  return useCallback(async () => {
    await authClient.signOut();
    router.replace('/login');
  }, [router]);
}
