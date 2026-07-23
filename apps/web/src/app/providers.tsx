'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import posthog from 'posthog-js';
import { ThemeProvider } from '@/lib/theme';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { registerServiceWorker } from '@/lib/service-worker';
import { captureReferralCode } from '@/lib/referral';
import { useSession } from '@/lib/auth-client';

function PostHogSessionSync() {
  const { data: session } = useSession();
  useEffect(() => {
    if (session?.user) {
      posthog.identify(session.user.id, {
        name: session.user.name,
        email: session.user.email,
      });
    }
  }, [session?.user?.id]);
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
          <PostHogSessionSync />
          {children}
        </ConfirmProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
