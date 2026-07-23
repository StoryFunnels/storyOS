'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { PACK_LISTING_VERTICALS } from '@storyos/schemas';
import { api, apiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The author flow's second step (MN-220): export an existing pack (#160's
 * `POST .../packs/export`, already shipped) then submit it, with listing
 * metadata, for review.
 *
 * Deliberately two steps, not one form: export is a read-only preview of
 * exactly what will be submitted (the same manifest a person could inspect,
 * save, or hand-install elsewhere), and submission only ever acts on a
 * manifest that's already been shown back to its author — the same
 * "show, then act" shape `PacksPage`'s install dialog already uses for
 * preview → install.
 */

interface PackManifestPreview {
  slug: string;
  name: string;
  version: string;
  summary: string;
  license: string;
  attribution?: string;
  requires: { connections: string[]; ai: string };
  databases: Array<{ name: string }>;
  views: Array<{ name: string }>;
  automations: Array<{ name: string }>;
  agents: Array<{ name: string }>;
}

interface Submission {
  id: string;
  slug: string;
  name: string;
  version: string;
  vertical: string;
  status: 'pending' | 'approved' | 'rejected';
  review_notes?: string;
  submitted_at: string;
}

const STATUS_STYLE: Record<Submission['status'], string> = {
  pending: 'bg-warning/10 text-warning',
  approved: 'bg-success/10 text-success',
  rejected: 'bg-error/10 text-error',
};

function useMySubmissions(ws: string) {
  return useQuery({
    queryKey: ['pack-submissions', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/packs/submissions' as never, {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as Submission[];
    },
  });
}

export default function SubmitPackPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const submissions = useMySubmissions(ws);

  const [form, setForm] = useState({
    slug: '',
    name: '',
    version: '1.0.0',
    summary: '',
    space: '',
    license: 'All rights reserved',
    attribution: '',
  });
  const [manifest, setManifest] = useState<PackManifestPreview | null>(null);
  const [vertical, setVertical] = useState<(typeof PACK_LISTING_VERTICALS)[number]>('other');
  const [screenshots, setScreenshots] = useState('');

  const exportPack = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/packs/export' as never, {
        params: { path: { ws } },
        body: {
          slug: form.slug,
          name: form.name,
          version: form.version,
          summary: form.summary,
          space: form.space,
          license: form.license,
          attribution: form.attribution || undefined,
        } as never,
      } as never);
      if (error) throw error;
      return data as unknown as PackManifestPreview;
    },
    onSuccess: (data) => {
      setManifest(data);
      toast.success('Exported — review below, then submit for review.');
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Export failed')),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/packs/submissions' as never, {
        params: { path: { ws } },
        body: {
          manifest,
          vertical,
          screenshots: screenshots
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        } as never,
      } as never);
      if (error) throw error;
      return data as unknown as Submission;
    },
    onSuccess: () => {
      toast.success('Submitted for review');
      setManifest(null);
      setForm({ slug: '', name: '', version: '1.0.0', summary: '', space: '', license: 'All rights reserved', attribution: '' });
      setScreenshots('');
      void qc.invalidateQueries({ queryKey: ['pack-submissions', ws] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Submission failed')),
  });

  const canExport = form.slug && form.name && form.summary && form.space;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-10">
      <Link
        href={`/w/${ws}/packs`}
        className="mb-4 flex items-center gap-1 text-[12px] text-muted hover:text-ink"
      >
        <ArrowLeft className="h-3 w-3" /> Business Packs
      </Link>
      <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold text-ink">
        <Upload className="h-5 w-5" /> Submit a pack
      </h1>
      <p className="mb-8 text-sm text-muted">
        Export a space you&rsquo;ve built as a pack, add listing details, and submit it for review. Nothing
        is published until a StoryOS reviewer approves it — v1 is curated, not open.
      </p>

      {!manifest ? (
        <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-4">
          <p className="text-[13px] font-semibold text-ink">1. Export</p>
          <Field label="Space to export" hint="The exact name of the space in this workspace">
            <Input value={form.space} onChange={(e) => setForm({ ...form, space: e.target.value })} placeholder="Sales" />
          </Field>
          <Field label="Slug" hint="Lowercase, dashes only — the stable identity across versions">
            <Input
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              placeholder="sales-os"
            />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Sales OS" />
          </Field>
          <Field label="Version" hint="Semver, e.g. 1.0.0">
            <Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          </Field>
          <Field label="Summary">
            <textarea
              className="min-h-16 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-2 text-sm text-ink"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              placeholder="Leads and tasks with a pipeline board"
            />
          </Field>
          <Field label="License" hint="Free text — shown verbatim on the listing">
            <Input value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />
          </Field>
          <Field label="Attribution" hint="Who to credit, e.g. your name or company">
            <Input
              value={form.attribution}
              onChange={(e) => setForm({ ...form, attribution: e.target.value })}
              placeholder="Acme Consulting"
            />
          </Field>
          <Button
            type="button"
            className="mt-1 self-start"
            disabled={!canExport || exportPack.isPending}
            onClick={() => exportPack.mutate()}
          >
            {exportPack.isPending ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting…
              </span>
            ) : (
              'Export'
            )}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-4">
          <p className="text-[13px] font-semibold text-ink">2. Listing details</p>
          <div className="rounded-[var(--radius-control)] border border-border-default bg-canvas p-3 text-[12px] text-ink-secondary">
            <p className="font-medium text-ink">
              {manifest.name} v{manifest.version}
            </p>
            <p>{manifest.summary}</p>
            <p className="mt-1 text-faint">
              {manifest.databases.length} database{manifest.databases.length === 1 ? '' : 's'} ·{' '}
              {manifest.views.length} view{manifest.views.length === 1 ? '' : 's'} ·{' '}
              {manifest.automations.length} automation{manifest.automations.length === 1 ? '' : 's'} ·{' '}
              {manifest.agents.length} agent{manifest.agents.length === 1 ? '' : 's'}
            </p>
          </div>

          <Field label="Vertical">
            <select
              className="h-9 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-sm text-ink"
              value={vertical}
              onChange={(e) => setVertical(e.target.value as typeof vertical)}
            >
              {PACK_LISTING_VERTICALS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Screenshots" hint="One URL per line">
            <textarea
              className="min-h-20 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-2 text-sm text-ink"
              value={screenshots}
              onChange={(e) => setScreenshots(e.target.value)}
              placeholder={'https://example.com/screenshot-1.png'}
            />
          </Field>
          <div className="mt-1 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setManifest(null)}>
              Back
            </Button>
            <Button type="button" disabled={submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Submitting…
                </span>
              ) : (
                'Submit for review'
              )}
            </Button>
          </div>
        </div>
      )}

      {(submissions.data?.length ?? 0) > 0 && (
        <div className="mt-8">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Your submissions</p>
          <div className="flex flex-col gap-2">
            {submissions.data!.map((s) => (
              <div
                key={s.id}
                className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-border-default bg-card p-3"
              >
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-medium text-ink">
                    {s.name} v{s.version}
                  </p>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[s.status]}`}>
                    {s.status}
                  </span>
                </div>
                <p className="text-[12px] text-muted">
                  {s.vertical} · submitted {new Date(s.submitted_at).toLocaleDateString()}
                </p>
                {s.review_notes && <p className="text-[12px] text-ink-secondary">&ldquo;{s.review_notes}&rdquo;</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}
