'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface Connection {
  id: string;
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

export default function GoogleCalendarIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const searchParams = useSearchParams();
  const connections = useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: Connection[] }).data;
    },
  });

  useEffect(() => {
    if (searchParams.get('connected') === 'google-calendar') {
      toast.success('Google Calendar connected');
    }
  }, [searchParams]);

  const connection = connections.data?.find((item) => item.provider === 'google-calendar');

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link
        className="text-[12px] text-muted hover:text-ink"
        href={`/w/${ws}/settings/integrations`}
      >
        ← Integrations
      </Link>
      <div className="mt-5 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] bg-hover">
          <CalendarDays className="h-6 w-6 text-ink" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">Google Calendar</h1>
          <p className="text-[13px] text-muted">Connect a calendar-scoped Google account.</p>
        </div>
      </div>

      <div className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        {connection?.status === 'active' ? (
          <>
            <p className="text-sm font-medium text-ink">Google Calendar is connected</p>
            <p className="mt-1 text-[13px] text-muted">
              Calendar discovery and database field mapping are the next part of this integration.
            </p>
            <Link className="mt-4 inline-block" href={`/w/${ws}/settings/connections`}>
              <Button variant="secondary">Manage connection</Button>
            </Link>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-ink">Connect your Google account</p>
            <p className="mt-1 text-[13px] text-muted">
              StoryOS requests Calendar access separately from Google sign-in and YouTube
              connections.
            </p>
            <Button
              className="mt-4"
              onClick={() => {
                window.location.href = `${API_URL}/api/v1/workspaces/${ws}/connections/oauth/google-calendar/start`;
              }}
            >
              Connect Google Calendar
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
