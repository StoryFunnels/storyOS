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
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDatabases, useSpaces } from '@/lib/queries';
import { PROVIDER_FIELD_CATALOG } from '@/lib/source-field-catalog';
import { autoMatchMapping, type ExistingFieldLike } from '@/lib/source-field-match';

interface Connection {
  id: string;
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
}

type YouTubeTemplate = {
  slug: 'youtube-videos' | 'youtube-comments' | 'youtube-metrics';
  databaseKey: 'youtube_videos' | 'youtube_comments' | 'youtube_metrics';
  name: string;
  description: string;
  source: string;
  /** #239 source provider id this template's database is built for. */
  providerSource: 'youtube.videos' | 'youtube.comments' | 'youtube.metrics';
  Icon: LucideIcon;
};

const YOUTUBE_TEMPLATES: YouTubeTemplate[] = [
  {
    slug: 'youtube-videos',
    databaseKey: 'youtube_videos',
    name: 'YouTube Videos',
    description: 'Video ids, titles, publish dates, duration, privacy and URLs.',
    source: 'YouTube — videos',
    providerSource: 'youtube.videos',
    Icon: Video,
  },
  {
    slug: 'youtube-comments',
    databaseKey: 'youtube_comments',
    name: 'YouTube Comments',
    description: 'Comments, replies, authors, likes and direct permalinks.',
    source: 'YouTube — comments',
    providerSource: 'youtube.comments',
    Icon: MessageSquare,
  },
  {
    slug: 'youtube-metrics',
    databaseKey: 'youtube_metrics',
    name: 'YouTube Metrics',
    description: 'Daily snapshots of views, likes and comment counts.',
    source: 'YouTube — daily metrics',
    providerSource: 'youtube.metrics',
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
  const [created, setCreated] = useState<{
    id: string;
    name: string;
    source: string;
    sourceAttached: boolean;
  } | null>(null);
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
  const googleConnection = connections.data?.find(
    (connection) => connection.provider === 'google' && connection.status === 'active',
  );
  const connected = Boolean(googleConnection);

  /**
   * #109 — right after a template database is created, also attach the matching
   * YouTube source and pre-map its fields (reusing the #342 auto-match + the
   * #125 Name mapping), leaving it ready to sync — instead of dumping the user
   * back into the database to add and map a source by hand. Best-effort: any
   * failure here is caught by the caller so the database (already created) still
   * lands and manual source-add stays as the fallback. Channel is left to the
   * connected account's own channel (the provider resolves `mine=true`).
   */
  async function attachYoutubeSource(
    databaseId: string,
    template: YouTubeTemplate,
    connectionId: string,
  ): Promise<void> {
    const { data: dbData, error: dbErr } = await api.GET(
      '/api/v1/workspaces/{ws}/databases/{db}',
      { params: { path: { ws, db: databaseId } } } as never,
    );
    if (dbErr) throw dbErr;
    const fields = ((dbData as unknown as { fields?: ExistingFieldLike[] }).fields ?? []).map((f) => ({
      id: f.id,
      displayName: f.displayName,
      apiName: f.apiName,
      type: f.type,
    }));
    const catalog = PROVIDER_FIELD_CATALOG[template.providerSource] ?? [];
    if (catalog.length === 0) throw new Error('No field catalog for this source');
    const mapping = autoMatchMapping(catalog, fields);

    const fieldIdByKey: Record<string, string> = {};
    for (const item of catalog) {
      const dest = mapping.get(item.key);
      if (!dest) continue;
      if (dest.kind === 'existing') {
        fieldIdByKey[item.key] = dest.field_id;
      } else {
        const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/fields', {
          params: { path: { ws, db: databaseId } },
          body: { display_name: item.label, type: dest.type as never, config: {} },
        } as never);
        if (error) throw error;
        fieldIdByKey[item.key] = (data as unknown as { id: string }).id;
      }
    }

    const keyItem = catalog.find((c) => c.isKey) ?? catalog[0];
    const externalKeyFieldId = keyItem ? fieldIdByKey[keyItem.key] : undefined;
    if (!externalKeyFieldId) throw new Error('Could not resolve the external key field');

    const { error: srcErr } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/sources', {
      params: { path: { ws, db: databaseId } },
      body: {
        name: template.source,
        connection_id: connectionId,
        provider_source: template.providerSource,
        config: {},
        field_mapping: fieldIdByKey,
        external_key_field_id: externalKeyFieldId,
      } as never,
    } as never);
    if (srcErr) throw srcErr;
  }

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
      const databaseId = result.databases[selectedTemplate.databaseKey]!;

      // #109 — chain the source attach. Best-effort: a failure must not fail the
      // whole flow, since the database itself is already created.
      let sourceAttached = false;
      if (googleConnection) {
        try {
          await attachYoutubeSource(databaseId, selectedTemplate, googleConnection.id);
          sourceAttached = true;
        } catch {
          sourceAttached = false;
        }
      }

      return {
        id: databaseId,
        name: databaseName.trim(),
        source: selectedTemplate.source,
        sourceAttached,
      };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['databases', ws] });
      setCreated(result);
      setSelectedTemplate(null);
      toast.success(
        result.sourceAttached
          ? `${result.name} is ready — the ${result.source} source is attached and will sync`
          : `${result.name} is ready for the ${result.source} source`,
      );
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
      <Link
        className="text-[12px] text-muted hover:text-ink"
        href={`/w/${ws}/settings/integrations`}
      >
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

      <IntegrationSetupGuide
        className="mt-6"
        steps={[
          {
            label: 'Connect YouTube',
            description: 'Authorize read-only access to the channel.',
            complete: Boolean(connected),
          },
          {
            label: 'Create a destination',
            description: 'Install a Videos, Comments, or Metrics database template here.',
            complete: Boolean(created),
          },
          {
            label: 'Add the source and sync',
            description:
              'The matching YouTube source is attached and pre-mapped automatically — open the database and press Sync now.',
            complete: Boolean(created?.sourceAttached),
          },
        ]}
      />

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
            Choose one of the three YouTube-specific templates. It is created here — you never have
            to search the general template gallery.
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
                {created.sourceAttached ? (
                  <>
                    <strong>{created.name}</strong> is ready and the <strong>{created.source}</strong>{' '}
                    source is attached and pre-mapped. Open it and press <strong>Sync now</strong> (or
                    wait for its daily schedule). It syncs the connected account&apos;s own channel;
                    change that in the source&apos;s settings if needed.
                  </>
                ) : (
                  <>
                    <strong>{created.name}</strong> is ready. Open it, choose <strong>Sources</strong>,
                    add <strong>{created.source}</strong>, confirm the channel or video input, then
                    press <strong>Sync now</strong>.
                  </>
                )}
              </p>
              <Link href={`/w/${ws}/d/${created.id}`}>
                <Button size="sm">Open database</Button>
              </Link>
            </div>
          )}
        </section>
      )}

      <Dialog
        open={Boolean(selectedTemplate)}
        onOpenChange={(open) => !open && setSelectedTemplate(null)}
      >
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
