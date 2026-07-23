'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Loader2, Package, Sparkles, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

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

type PackSource = 'registry' | 'marketplace';

interface RegistryCard {
  slug: string;
  name: string;
  summary: string;
  highlights: string[];
}
interface RegistryEntry extends RegistryCard {
  manifest: unknown;
}
interface MarketplaceCard {
  slug: string;
  name: string;
  summary: string;
  vertical: string;
  license: string;
  attribution?: string;
  latest_version: string;
}
interface MarketplaceEntry extends MarketplaceCard {
  manifest: unknown;
  versions: Array<{ version: string; changelog?: string; published_at: string }>;
}
interface PreviewItem {
  name: string;
  action: 'create' | 'reuse' | 'collision';
}
interface UnmetRequirement {
  kind: 'connection' | 'ai';
  name: string;
  detail: string;
}
interface PreviewResult {
  slug: string;
  name: string;
  version: string;
  unmet: UnmetRequirement[];
  databases: PreviewItem[];
  views: PreviewItem[];
  automations: PreviewItem[];
  agents: PreviewItem[];
}
interface InstalledEntity {
  name: string;
  action: 'created' | 'reused' | 'skipped';
  id: string;
}
interface InstallResult {
  slug: string;
  name: string;
  version: string;
  unmet: UnmetRequirement[];
  spaces: InstalledEntity[];
  databases: InstalledEntity[];
  fields: InstalledEntity[];
  relations: InstalledEntity[];
  states: InstalledEntity[];
  agents: InstalledEntity[];
  triggers: InstalledEntity[];
  derived_fields: InstalledEntity[];
  views: InstalledEntity[];
  automations: InstalledEntity[];
  sample_records: InstalledEntity[];
  skills: InstalledEntity[];
}
interface InstallSummary {
  id: string;
  slug: string;
  name: string;
  version: string;
  installed_at: string;
  installed_by: string;
  latest_version: string | null;
  update_available: boolean;
}
type Resolution = { action: 'reuse' | 'rename' | 'skip'; rename_to?: string };

function useRegistry() {
  return useQuery({
    queryKey: ['packs-registry'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/packs/registry' as never, {} as never);
      if (error) throw error;
      return data as unknown as RegistryCard[];
    },
    staleTime: 5 * 60_000,
  });
}

function useMarketplace() {
  return useQuery({
    queryKey: ['packs-marketplace'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/packs/marketplace' as never, {} as never);
      if (error) throw error;
      return data as unknown as MarketplaceCard[];
    },
    staleTime: 60_000,
  });
}

function useInstalledPacks(ws: string) {
  return useQuery({
    queryKey: ['packs-installed', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/packs/installed' as never, {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as InstallSummary[];
    },
  });
}

/** Every `collision` across a preview, keyed by its label — what the resolver UI iterates. */
function collisionLabels(preview: PreviewResult): string[] {
  return [...preview.databases, ...preview.views, ...preview.automations, ...preview.agents]
    .filter((i) => i.action === 'collision')
    .map((i) => i.name);
}

function ActionBadge({ action }: { action: PreviewItem['action'] }) {
  const style =
    action === 'collision'
      ? 'bg-[var(--warning-soft,#fef3c7)] text-[var(--warning,#92400e)]'
      : action === 'create'
        ? 'bg-accent-soft text-[var(--accent)]'
        : 'bg-hover text-muted';
  const label = action === 'collision' ? 'Name collision' : action === 'create' ? 'New' : 'Reuse existing';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>{label}</span>
  );
}

function PreviewSection({ title, items }: { title: string; items: PreviewItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{title}</p>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="text-ink-secondary">{item.name}</span>
            <ActionBadge action={item.action} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CollisionResolver({
  labels,
  resolutions,
  onChange,
}: {
  labels: string[];
  resolutions: Record<string, Resolution>;
  onChange: (label: string, resolution: Resolution) => void;
}) {
  if (labels.length === 0) return null;
  return (
    <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
      <p className="mb-2 text-[12px] font-semibold text-ink">
        {labels.length} name{labels.length > 1 ? 's' : ''} already exist in this workspace
      </p>
      <div className="flex flex-col gap-2">
        {labels.map((label) => {
          const resolution = resolutions[label] ?? { action: 'reuse' };
          return (
            <div key={label} className="flex flex-col gap-1.5 rounded-[var(--radius-control)] bg-card p-2">
              <p className="text-[13px] text-ink">{label}</p>
              <div className="flex items-center gap-2">
                <select
                  className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[12px] text-ink"
                  value={resolution.action}
                  onChange={(e) =>
                    onChange(label, { ...resolution, action: e.target.value as Resolution['action'] })
                  }
                >
                  <option value="reuse">Reuse the existing one</option>
                  <option value="rename">Install under a new name</option>
                  <option value="skip">Skip it</option>
                </select>
                {resolution.action === 'rename' && (
                  <Input
                    className="h-8"
                    placeholder="New name"
                    value={resolution.rename_to ?? ''}
                    onChange={(e) => onChange(label, { ...resolution, rename_to: e.target.value })}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InstallDialog({
  ws,
  slug,
  source = 'registry',
  onOpenChange,
}: {
  ws: string;
  slug: string;
  source?: PackSource;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [result, setResult] = useState<InstallResult | null>(null);

  const entry = useQuery({
    queryKey: ['pack-entry', source, slug],
    queryFn: async () => {
      const path =
        source === 'marketplace' ? '/api/v1/packs/marketplace/{slug}' : '/api/v1/packs/registry/{slug}';
      const { data, error } = await api.GET(path as never, { params: { path: { slug } } } as never);
      if (error) throw error;
      return data as unknown as RegistryEntry | MarketplaceEntry;
    },
  });

  const preview = useQuery({
    queryKey: ['pack-preview', ws, slug],
    enabled: Boolean(entry.data),
    queryFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/packs/preview' as never,
        { params: { path: { ws } }, body: { manifest: entry.data!.manifest } as never } as never,
      );
      if (error) throw error;
      return data as unknown as PreviewResult;
    },
  });

  const install = useMutation({
    mutationFn: async () => {
      const labels = collisionLabels(preview.data!);
      const payload = Object.fromEntries(labels.map((l) => [l, resolutions[l] ?? { action: 'reuse' }]));
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/packs/install' as never, {
        params: { path: { ws } },
        body: { manifest: entry.data!.manifest, resolutions: payload } as never,
      } as never);
      if (error) throw error;
      return data as unknown as InstallResult;
    },
    onSuccess: (data) => {
      setResult(data);
      void qc.invalidateQueries({ queryKey: ['packs-installed', ws] });
      void qc.invalidateQueries({ queryKey: ['onboarding', ws] });
      void qc.invalidateQueries();
      toast.success(`${data.name} installed`);
    },
    onError: () => toast.error('Install failed — see the collisions below and try again'),
  });

  const unresolved = preview.data ? collisionLabels(preview.data).filter((l) => !resolutions[l]) : [];
  const firstDbId = result?.databases.find((d) => d.action !== 'skipped')?.id;
  const created = (r: InstallResult) =>
    [...r.databases, ...r.views, ...r.automations, ...r.agents, ...r.skills].filter(
      (i) => i.action === 'created',
    );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={entry.data?.name ?? 'Install pack'} className="max-w-xl">
        {result ? (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-ink-secondary">
              {result.name} v{result.version} is installed. Here’s what you got:
            </p>
            <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
              {created(result).length === 0 ? (
                <p className="text-[13px] text-muted">Everything already existed — nothing new was created.</p>
              ) : (
                created(result).map((item) => (
                  <div key={`${item.name}-${item.id}`} className="flex items-center gap-2 text-[13px]">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                    <span className="text-ink-secondary">{item.name}</span>
                  </div>
                ))
              )}
            </div>
            {result.unmet.length > 0 && (
              <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
                <p className="mb-1.5 text-[12px] font-semibold text-ink">Still to connect</p>
                <div className="flex flex-col gap-1">
                  {result.unmet.map((u) => (
                    <p key={u.name} className="text-[12px] text-muted">
                      {u.detail}{' '}
                      {u.kind === 'connection' && (
                        <Link href={`/w/${ws}/settings/connections`} className="underline underline-offset-2">
                          Connect {u.name}
                        </Link>
                      )}
                    </p>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {firstDbId && (
                <Button type="button" onClick={() => (window.location.href = `/w/${ws}/d/${firstDbId}`)}>
                  Go to my new space
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {entry.isLoading || preview.isLoading ? (
              <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Looking at what this would create…
              </div>
            ) : preview.data ? (
              <>
                <p className="text-[13px] text-ink-secondary">{entry.data?.summary}</p>
                <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto">
                  <PreviewSection title="Databases" items={preview.data.databases} />
                  <PreviewSection title="Views" items={preview.data.views} />
                  <PreviewSection title="Automations" items={preview.data.automations} />
                  <PreviewSection title="Agents" items={preview.data.agents} />
                </div>
                {preview.data.unmet.length > 0 && (
                  <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
                    <p className="mb-1 text-[12px] font-semibold text-ink">You’ll need to connect</p>
                    {preview.data.unmet.map((u) => (
                      <p key={u.name} className="text-[12px] text-muted">
                        {u.detail}
                      </p>
                    ))}
                  </div>
                )}
                <CollisionResolver
                  labels={collisionLabels(preview.data)}
                  resolutions={resolutions}
                  onChange={(label, resolution) =>
                    setResolutions((prev) => ({ ...prev, [label]: resolution }))
                  }
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={install.isPending || unresolved.length > 0}
                    onClick={() => install.mutate()}
                  >
                    {install.isPending ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing…
                      </span>
                    ) : (
                      'Install pack'
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-[13px] text-muted">Could not load this pack.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
        <p className="text-[13px] font-medium text-ink">{pack.name}</p>
        <p className="text-[12px] text-muted">
          v{pack.version} · installed {new Date(pack.installed_at).toLocaleDateString()}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {pack.update_available && (
          <Button type="button" variant="secondary" size="sm" onClick={() => onUpdate(pack.slug, source)}>
            <Sparkles className="h-3.5 w-3.5" /> Update to v{pack.latest_version}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={uninstall.isPending}
          onClick={() => {
            if (window.confirm(`Uninstall ${pack.name}? Anything you've changed since install is kept.`)) {
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
  const canInstall = workspace.data?.role === 'admin';

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-10">
      <Link href={`/w/${ws}`} className="mb-4 flex items-center gap-1 text-[12px] text-muted hover:text-ink">
        <ArrowLeft className="h-3 w-3" /> Home
      </Link>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <Package className="h-5 w-5" /> Business Packs
        </h1>
        {canInstall && (
          <Link
            href={`/w/${ws}/packs/submit`}
            className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink"
          >
            <Upload className="h-3.5 w-3.5" /> Submit a pack
          </Link>
        )}
      </div>
      <p className="mb-8 text-sm text-muted">
        A whole running system in one click — databases, views, automations and agents, ready to use.
      </p>

      {(installed.data?.length ?? 0) > 0 && (
        <div className="mb-8">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Installed</p>
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

      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Gallery</p>
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(registry.data ?? []).map((pack) => (
          <div key={pack.slug} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border-default bg-card p-4">
            <p className="text-[14px] font-medium text-ink">{pack.name}</p>
            <p className="text-[13px] text-muted">{pack.summary}</p>
            <ul className="flex flex-col gap-0.5">
              {pack.highlights.map((h) => (
                <li key={h} className="text-[12px] text-muted">• {h}</li>
              ))}
            </ul>
            <Button
              type="button"
              className="mt-2 self-start"
              disabled={!canInstall}
              onClick={() => setOpen({ slug: pack.slug, source: 'registry' })}
            >
              {canInstall ? 'View & install' : 'Admin required to install'}
            </Button>
          </div>
        ))}
        {registry.data?.length === 0 && (
          <p className="text-[13px] text-muted">No packs in the gallery yet.</p>
        )}
      </div>

      <p className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-faint">Community Marketplace</p>
      <p className="mb-2 text-[12px] text-muted">
        Curated packs published by other builders — reviewed before they&rsquo;re listed here.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(marketplace.data ?? []).map((pack) => (
          <div key={pack.slug} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border-default bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-[14px] font-medium text-ink">{pack.name}</p>
              <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-ink-secondary">
                {pack.vertical}
              </span>
            </div>
            <p className="text-[13px] text-muted">{pack.summary}</p>
            <p className="text-[11px] text-faint">
              v{pack.latest_version} · {pack.license}
              {pack.attribution ? ` · by ${pack.attribution}` : ''}
            </p>
            <Button
              type="button"
              className="mt-2 self-start"
              disabled={!canInstall}
              onClick={() => setOpen({ slug: pack.slug, source: 'marketplace' })}
            >
              {canInstall ? 'View & install' : 'Admin required to install'}
            </Button>
          </div>
        ))}
        {marketplace.data?.length === 0 && (
          <p className="text-[13px] text-muted">No community packs published yet.</p>
        )}
      </div>

      {open && (
        <InstallDialog
          ws={ws}
          slug={open.slug}
          source={open.source}
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
        />
      )}
    </div>
  );
}
