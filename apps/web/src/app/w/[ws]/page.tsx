'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, CheckCircle2, Circle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDatabases, useSpaces, useWorkspace } from '@/lib/queries';
import { TEMPLATE_ICONS, TemplateGalleryDialog, useTemplateRegistry } from '@/components/template-gallery';
import { Button } from '@/components/ui/button';

export default function WorkspaceHome() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const workspace = useWorkspace(ws);
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);

  const settings = (workspace.data as unknown as { settings?: { sample_record_ids?: string[] } })
    ?.settings;
  const sampleCount = settings?.sample_record_ids?.length ?? 0;

  const removeSamples = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/templates/sample-data', {
        params: { path: { ws } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Sample data removed');
      void qc.invalidateQueries();
    },
  });

  const membersProbe = useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as unknown[];
    },
    retry: false,
  });

  const registry = useTemplateRegistry();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [gallerySlug, setGallerySlug] = useState<string | undefined>(undefined);
  const canInstall = workspace.data?.role !== 'guest';

  const firstDb = databases.data?.[0];
  const steps = [
    { label: 'Create a database', done: (databases.data?.length ?? 0) > 0, href: undefined },
    {
      label: 'Open it and add a few records',
      done: false,
      href: firstDb ? `/w/${ws}/d/${firstDb.id}` : undefined,
    },
    { label: 'Invite a teammate', done: (membersProbe.data?.length ?? 1) > 1, href: `/w/${ws}/settings/members` },
    { label: 'Build a board view', done: false, href: firstDb ? `/w/${ws}/d/${firstDb.id}` : undefined },
  ];

  return (
    <div className="mx-auto max-w-2xl p-10">
      {sampleCount > 0 && (
        <div className="mb-6 flex items-center justify-between rounded-[var(--radius-card)] border border-border-default bg-accent-soft px-4 py-3">
          <span className="text-[13px] text-ink">
            This workspace contains {sampleCount} sample records to explore.
          </span>
          <Button size="sm" variant="secondary" onClick={() => removeSamples.mutate()}>
            Remove sample data
          </Button>
        </div>
      )}

      <h1 className="mb-1 text-xl font-semibold text-ink">
        Welcome to {workspace.data?.name ?? 'StoryOS'}
      </h1>
      <p className="mb-8 text-sm text-muted">
        Model anything as related databases — client work, content, planning. It all lives in the
        sidebar.
      </p>

      <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
        <p className="mb-3 text-[12px] font-medium uppercase tracking-wider text-faint">
          Getting started
        </p>
        <div className="flex flex-col gap-2.5">
          {steps.map((step) => (
            <div key={step.label} className="flex items-center gap-2.5">
              {step.done ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <Circle className="h-4 w-4 text-faint" />
              )}
              {step.href && !step.done ? (
                <Link href={step.href} className="text-[13px] text-ink underline-offset-2 hover:underline">
                  {step.label}
                </Link>
              ) : (
                <span className="text-[13px] text-ink-secondary">{step.label}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {canInstall && (
        <div className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[12px] font-medium uppercase tracking-wider text-faint">
              Start something new
            </p>
            <button
              type="button"
              className="text-[12px] text-muted underline-offset-2 hover:underline"
              onClick={() => {
                setGallerySlug(undefined);
                setGalleryOpen(true);
              }}
            >
              Browse all templates
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(registry.data?.intents ?? []).map((intent) => {
              const Icon = TEMPLATE_ICONS[intent.template] ?? Blocks;
              return (
                <button
                  key={intent.id}
                  type="button"
                  className="flex items-start gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-3 text-left hover:bg-hover"
                  onClick={() => {
                    setGallerySlug(intent.template);
                    setGalleryOpen(true);
                  }}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  <span>
                    <span className="block text-[13px] font-medium text-ink">{intent.label}</span>
                    <span className="block text-[12px] text-muted">{intent.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {galleryOpen && (
            <TemplateGalleryDialog
              key={gallerySlug ?? 'all'}
              ws={ws}
              spaces={spaces.data ?? []}
              open={galleryOpen}
              onOpenChange={setGalleryOpen}
              initialSlug={gallerySlug}
            />
          )}
        </div>
      )}

      {(spaces.data?.length ?? 0) > 0 && (databases.data?.length ?? 0) === 0 && (
        <p className="mt-6 text-[13px] text-muted">
          Create your first database from the sidebar — hover a space and hit “+”.
        </p>
      )}
    </div>
  );
}
