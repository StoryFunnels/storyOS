'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, MessageSquare, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_URL, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDatabases, useSpaces } from '@/lib/queries';

interface Connection {
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

type YouTubeTemplate = {
  slug: 'youtube-videos' | 'youtube-comments' | 'youtube-metrics';
  databaseKey: 'youtube_videos' | 'youtube_comments' | 'youtube_metrics';
  name: string;
  description: string;
  source: string;
  Icon: LucideIcon;
};

const YOUTUBE_TEMPLATES: YouTubeTemplate[] = [
  {
    slug: 'youtube-videos',
    databaseKey: 'youtube_videos',
    name: 'YouTube Videos',
    description: 'Video ids, titles, publish dates, duration, privacy and URLs.',
    source: 'YouTube — videos',
    Icon: Video,
  },
  {
    slug: 'youtube-comments',
    databaseKey: 'youtube_comments',
    name: 'YouTube Comments',
    description: 'Comments, replies, authors, likes and direct permalinks.',
    source: 'YouTube — comments',
    Icon: MessageSquare,
  },
  {
    slug: 'youtube-metrics',
    databaseKey: 'youtube_metrics',
    name: 'YouTube Metrics',
    description: 'Daily snapshots of views, likes and comment counts.',
    source: 'YouTube — daily metrics',
    Icon: BarChart3,
  },
];

export default function YouTubeIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const queryClient = useQueryClient();
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);
  const [selectedTemplate, setSelectedTemplate] = useState<YouTubeTemplate | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [created, setCreated] = useState<{ id: string; name: string; source: string } | null>(null);
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

  const createDatabase = useMutation({
    mutationFn: async () => {
      if (!selectedTemplate) throw new Error('Choose a YouTube template');
      const response = await fetch(
        `${API_URL}/api/v1/workspaces/${ws}/templates/${selectedTemplate.slug}/apply`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            space_id: spaceId,
            database_name: databaseName.trim(),
            include_samples: false,
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Database creation failed (${response.status})`);
      }
      const result = (await response.json()) as { databases: Record<string, string> };
      return {
        id: result.databases[selectedTemplate.databaseKey]!,
        name: databaseName.trim(),
        source: selectedTemplate.source,
      };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['databases', ws] });
      setCreated(result);
      setSelectedTemplate(null);
      toast.success(`${result.name} is ready for the ${result.source} source`);
    },
    onError: (error) =>
      toast.error(apiErrorMessage(error, 'Could not create the YouTube database')),
  });

  function chooseTemplate(template: YouTubeTemplate) {
    const names = new Set((databases.data ?? []).map((database) => database.name));
    let candidate = template.name;
    let suffix = 2;
    while (names.has(candidate)) candidate = `${template.name} ${suffix++}`;
    setSelectedTemplate(template);
    setDatabaseName(candidate);
    setSpaceId(spaces.data?.[0]?.id ?? '');
  }

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
          <Link href={`/w/${ws}/settings/connections`}>
            <Button variant="secondary">Manage connection</Button>
          </Link>
        </div>
      </section>

      {connected && (
        <section className="mt-5 rounded-[var(--radius-card)] border border-border-default bg-card p-5">
          <h2 className="text-sm font-semibold text-ink">Start with a YouTube database</h2>
          <p className="mt-1 text-[13px] text-muted">
            Choose one of the three YouTube-specific templates. It is created here — you never
            have to search the general template gallery.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {YOUTUBE_TEMPLATES.map((template) => (
              <div
                key={template.slug}
                className="flex flex-col rounded-[var(--radius-control)] border border-border-default p-3"
              >
                <template.Icon className="h-5 w-5 text-ink" />
                <h3 className="mt-2 text-[13px] font-semibold text-ink">{template.name}</h3>
                <p className="mt-1 flex-1 text-[12px] leading-4 text-muted">
                  {template.description}
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="secondary"
                  onClick={() => chooseTemplate(template)}
                >
                  Create database
                </Button>
              </div>
            ))}
          </div>
          {created && (
            <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius-control)] bg-accent-soft p-3 sm:flex-row sm:items-center">
              <p className="flex-1 text-[13px] text-ink">
                <strong>{created.name}</strong> is ready. Open it, choose <strong>Sources</strong>,
                and add <strong>{created.source}</strong>; map to the matching fields.
              </p>
              <Link href={`/w/${ws}/d/${created.id}`}>
                <Button size="sm">Open database</Button>
              </Link>
            </div>
          )}
        </section>
      )}

      <Dialog open={Boolean(selectedTemplate)} onOpenChange={(open) => !open && setSelectedTemplate(null)}>
        <DialogContent title={`Create ${selectedTemplate?.name ?? 'YouTube database'}`}>
          <p className="mb-4 text-[13px] text-muted">
            Installs only the fields and views maintained for {selectedTemplate?.source}.
          </p>
          <div className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <Label>Space</Label>
              <select
                className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-[13px] text-ink"
                value={spaceId}
                onChange={(event) => setSpaceId(event.target.value)}
              >
                <option value="">Choose space</option>
                {(spaces.data ?? []).map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="youtube-database-name">Database name</Label>
              <Input
                id="youtube-database-name"
                value={databaseName}
                maxLength={100}
                onChange={(event) => setDatabaseName(event.target.value)}
              />
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              disabled={!spaceId || !databaseName.trim() || createDatabase.isPending}
              onClick={() => createDatabase.mutate()}
            >
              {createDatabase.isPending ? 'Creating…' : 'Create database'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
