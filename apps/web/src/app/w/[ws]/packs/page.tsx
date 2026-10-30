'use client';


import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Package,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PackVisual, packCountsLine, registryVertical } from '@/components/pack-visual';
import { useDateFormat } from '@/lib/preferences';
import {
  InstallDialog,
  PACK_FILTERS,
  useInstalledPacks,
  useMarketplace,
  useRegistry,
  type InstallSummary,
  type PackSource,
} from '@/components/pack-install-dialog';

/**
 * Business Packs — gallery + one-click install (MN-219 / #161), the
 * Community Marketplace browse view, and update-available surfacing
 * (MN-220).
 *
 * Builds entirely on the #148/#160/#161 API plus MN-220's additions:
 * `GET /packs/registry` (built-in gallery), `GET /packs/marketplace`
 * (published community packs), `POST .../packs/preview` (dry run + collision
 * detection), `POST .../packs/install` (idempotent, collision-aware),
 * `POST .../packs/:id/uninstall`, and `GET .../packs/installed`'s new
 * `latest_version`/`update_available`. Nothing here re-implements install
 * logic — a marketplace pack installs through the exact same dialog and the
 * exact same `install`/`preview` endpoints as a built-in one, just given a
 * different manifest.
 */

function InstalledRow({
  ws,
  pack,
  source,
  onUpdate,
}: {
  ws: string;
  pack: InstallSummary;
  source: PackSource;
  onUpdate: (slug: string, source: PackSource) => void;
}) {
  const fmt = useDateFormat();
  const qc = useQueryClient();
  const uninstall = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/packs/{installId}/uninstall' as never,
        { params: { path: { ws, installId: pack.id } } } as never,
      );
      if (error) throw error;
      return data as unknown as { removed: unknown[]; kept: { name: string; reason?: string }[] };
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['packs-installed', ws] });
      void qc.invalidateQueries({ queryKey: ['onboarding', ws] });
      toast.success(
        data.kept.length > 0
          ? `Uninstalled — kept ${data.kept.length} item(s) you'd changed since install`
          : 'Uninstalled cleanly',
      );
    },
    onError: () => toast.error('Uninstall failed'),
  });

  return (
    <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border-default bg-card p-3">
      <div>
        <p className="text-body font-medium text-ink">{pack.name}</p>
        <p className="text-label text-muted">
          v{pack.version} · installed {fmt.date(pack.installed_at)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {pack.update_available && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onUpdate(pack.slug, source)}
          >
            <Sparkles className="h-3.5 w-3.5" /> Update to v{pack.latest_version}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={uninstall.isPending}
          onClick={() => {
            if (
              window.confirm(
                `Uninstall ${pack.name}? Anything you've changed since install is kept.`,
              )
            ) {
              uninstall.mutate();
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Every registry slug — used to tell a tracked install's source apart for the "Update" action. */
function useRegistrySlugs(): Set<string> {
  const registry = useRegistry();
  return new Set((registry.data ?? []).map((p) => p.slug));
}

export default function PacksPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const registry = useRegistry();
  const marketplace = useMarketplace();
  const installed = useInstalledPacks(ws);
  const registrySlugs = useRegistrySlugs();
  const [open, setOpen] = useState<{ slug: string; source: PackSource } | null>(null);
  const [query, setQuery] = useState('');
  const [vertical, setVertical] = useState('all');
  const canInstall = workspace.data?.role === 'admin';
  const installedBySlug = new Map((installed.data ?? []).map((pack) => [pack.slug, pack]));
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (text: string) =>
    normalizedQuery.length === 0 || text.toLowerCase().includes(normalizedQuery);
  const visibleRegistry = (registry.data ?? []).filter(
    (pack) =>
      (vertical === 'all' || registryVertical(pack.slug) === vertical) &&
      matchesQuery(`${pack.name} ${pack.summary} ${pack.highlights.join(' ')}`),
  );
  const visibleMarketplace = (marketplace.data ?? []).filter(
    (pack) =>
      (vertical === 'all' || pack.vertical === vertical) &&
      matchesQuery(`${pack.name} ${pack.summary} ${pack.vertical} ${pack.attribution ?? ''}`),
  );
  const noMatches =
    !registry.isLoading &&
    !marketplace.isLoading &&
    visibleRegistry.length === 0 &&
    visibleMarketplace.length === 0;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-10">
      <Link
        href={`/w/${ws}`}
        className="mb-4 flex items-center gap-1 text-label text-muted hover:text-ink"
      >
        <ArrowLeft className="h-3 w-3" /> Home
      </Link>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Package className="h-5 w-5" /> Business Packs
        </h1>
        {canInstall && (
          <Link
            href={`/w/${ws}/packs/submit`}
            className="flex items-center gap-1.5 text-label text-muted hover:text-ink"
          >
            <Upload className="h-3.5 w-3.5" /> Submit a pack
          </Link>
        )}
      </div>
      <p className="mb-8 text-sm text-muted">
        A whole running system in one click — databases, views, automations and agents, ready to
        use.
      </p>

      {(installed.data?.length ?? 0) > 0 && (
        <div className="mb-8">
          <p className="mb-2 text-label font-semibold uppercase tracking-wider text-muted">
            Installed
          </p>
          <div className="flex flex-col gap-2">
            {installed.data!.map((pack) => (
              <InstalledRow
                key={pack.id}
                ws={ws}
                pack={pack}
                source={registrySlugs.has(pack.slug) ? 'registry' : 'marketplace'}
                onUpdate={(slug, source) => setOpen({ slug, source })}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mb-6 rounded-[var(--radius-card)] border border-border-default bg-card p-3">
        <div className="relative">
          {/* #706 — KEEPS faint: the magnifier is a non-text graphic inside the
              search field, judged at 3:1, which faint clears. The field's own
              placeholder carries the instruction and is not faint. */}
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-faint" />
          <Input
            aria-label="Search Business Packs"
            placeholder="Search packs, workflows, or industries"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>
        <div className="mt-3 flex gap-1 overflow-x-auto pb-1" aria-label="Filter packs">
          {PACK_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`shrink-0 rounded-full px-2.5 py-1 text-meta ${
                vertical === filter.value
                  ? 'bg-primary text-[var(--text-on-dark)]'
                  : 'bg-hover text-muted hover:text-ink'
              }`}
              onClick={() => setVertical(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-2 text-label font-semibold uppercase tracking-wider text-muted">Gallery</p>
      <div className="mb-8 grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-3">
        {visibleRegistry.map((pack) => {
          const installState = installedBySlug.get(pack.slug);
          return (
            <div
              key={pack.slug}
              className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-4"
            >
              <PackVisual pack={pack} />
              <div className="flex items-start justify-between gap-2">
                <p className="text-prose font-medium text-ink">{pack.name}</p>
                {installState && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-micro font-medium text-ink">
                    {installState.update_available ? 'Update available' : 'Installed'}
                  </span>
                )}
              </div>
              <p className="line-clamp-3 text-body text-muted">{pack.summary}</p>
              {/* #824 — the counts, demoted from the hero to one quiet line. Gallery-only
                  chrome: the new-workspace card has no room for it (see PackVisual). */}
              <p className="font-mono text-micro text-muted">{packCountsLine(pack.preview)}</p>
              <Button
                type="button"
                className="mt-auto self-start"
                variant={installState ? 'secondary' : 'primary'}
                disabled={!canInstall}
                onClick={() => setOpen({ slug: pack.slug, source: 'registry' })}
              >
                {canInstall
                  ? installState?.update_available
                    ? 'View update'
                    : installState
                      ? 'View details'
                      : 'View & install'
                  : 'Admin required to install'}
              </Button>
            </div>
          );
        })}
        {registry.data?.length === 0 && !normalizedQuery && vertical === 'all' && (
          <p className="text-body text-muted">No packs in the gallery yet.</p>
        )}
      </div>

      <p
        id="community-marketplace"
        className="mb-1 scroll-mt-6 text-label font-semibold uppercase tracking-wider text-muted"
      >
        Community Marketplace
      </p>
      <p className="mb-2 text-label text-muted">
        Curated packs published by other builders — reviewed before they&rsquo;re listed here.
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-3">
        {visibleMarketplace.map((pack) => {
          const installState = installedBySlug.get(pack.slug);
          return (
            <div
              key={pack.slug}
              className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-4"
            >
              {pack.screenshots[0] ? (
                <img
                  src={pack.screenshots[0]}
                  alt={`${pack.name} preview`}
                  className="h-28 w-full rounded-[var(--radius-control)] border border-border-default object-cover"
                />
              ) : (
                <div className="flex h-28 items-center justify-center rounded-[var(--radius-control)] border border-border-default bg-gradient-to-br from-violet-100 to-blue-50">
                  <Sparkles className="h-7 w-7 text-muted" />
                </div>
              )}
              <div className="flex items-center justify-between">
                <p className="text-prose font-medium text-ink">{pack.name}</p>
                <div className="flex items-center gap-1">
                  {installState && (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-micro font-medium text-ink">
                      {installState.update_available ? 'Update' : 'Installed'}
                    </span>
                  )}
                  <span className="rounded-full bg-hover px-2 py-0.5 text-meta text-ink-secondary">
                    {pack.vertical}
                  </span>
                </div>
              </div>
              <p className="line-clamp-3 text-body text-muted">{pack.summary}</p>
              <p className="text-meta text-muted">
                v{pack.latest_version} · {pack.license}
                {pack.attribution ? ` · by ${pack.attribution}` : ''}
              </p>
              <Button
                type="button"
                className="mt-auto self-start"
                disabled={!canInstall}
                onClick={() => setOpen({ slug: pack.slug, source: 'marketplace' })}
              >
                {canInstall
                  ? installState?.update_available
                    ? 'View update'
                    : installState
                      ? 'View details'
                      : 'View & install'
                  : 'Admin required to install'}
              </Button>
            </div>
          );
        })}
        {marketplace.data?.length === 0 && !normalizedQuery && vertical === 'all' && (
          <p className="text-body text-muted">No community packs published yet.</p>
        )}
      </div>

      {noMatches && (
        <div className="mt-4 rounded-[var(--radius-card)] border border-dashed border-border-default p-8 text-center">
          <p className="text-body font-medium text-ink">No packs match this search</p>
          <button
            type="button"
            className="mt-1 text-label text-muted underline underline-offset-2"
            onClick={() => {
              setQuery('');
              setVertical('all');
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      {open && (
        <InstallDialog
          ws={ws}
          slug={open.slug}
          source={open.source}
          installed={installedBySlug.get(open.slug)}
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
        />
      )}
    </div>
  );
}
