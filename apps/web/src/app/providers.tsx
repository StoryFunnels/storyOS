'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/lib/theme';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { registerServiceWorker } from '@/lib/service-worker';
import { captureReferralCode } from '@/lib/referral';

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
        <ConfirmProvider>{children}</ConfirmProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
