'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Video } from 'lucide-react';
import { api, API_URL } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface Connection {
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

export default function YouTubeIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
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
  const connected = connections.data?.some(
    (connection) => connection.provider === 'google' && connection.status === 'active',
  );

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link className="text-[12px] text-muted hover:text-ink" href={`/w/${ws}/settings/integrations`}>
        ← Integrations
      </Link>
      <div className="mt-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-hover">
          <Video className="h-6 w-6 text-ink" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-ink">YouTube</h1>
          <p className="text-[13px] text-muted">Bring videos, comments and metrics into StoryOS.</p>
        </div>
      </div>

      <section className="mt-6 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <h2 className="text-sm font-semibold text-ink">
          {connected ? 'YouTube is connected' : 'Connect your YouTube account'}
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          {connected
            ? 'Add a YouTube source from the database where you want videos, comments or metrics to appear.'
            : 'StoryOS requests read-only YouTube access. It cannot publish or modify videos with this connection.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {!connected && (
            <Button
              onClick={() => {
                window.location.href = `${API_URL}/api/v1/workspaces/${ws}/connections/oauth/google/start`;
              }}
            >
              Connect YouTube
            </Button>
          )}
          {connected && (
            <Link href={`/w/${ws}`}>
              <Button>Open workspace and choose a database</Button>
            </Link>
          )}
          <Link href={`/w/${ws}/settings/connections`}>
            <Button variant="secondary">Manage connection</Button>
          </Link>
        </div>
      </section>

      <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
        <h2 className="text-sm font-semibold text-ink">How to use it</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-muted">
          <li>Open or create the database that should receive YouTube data.</li>
          <li>Open Sources and add YouTube videos, comments, or metrics.</li>
          <li>Choose this connection, configure the channel/video inputs, and run the source.</li>
        </ol>
      </section>
    </div>
  );
}
