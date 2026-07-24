'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Database,
  Loader2,
  Package,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
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
  preview: {
    databases: number;
    views: number;
    automations: number;
    agents: number;
  };
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
  screenshots: string[];
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

const PACK_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'agency', label: 'Agency' },
  { value: 'sales', label: 'Sales' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'support', label: 'Support' },
  { value: 'hr', label: 'People' },
  { value: 'finance', label: 'Finance' },
  { value: 'ops', label: 'Operations' },
  { value: 'other', label: 'Other' },
] as const;

function registryVertical(slug: string): string {
  if (slug === 'agency-os' || slug === 'client-portal' || slug === 'consulting-os') return 'agency';
  if (slug === 'content-engine') return 'marketing';
  if (slug === 'dev-project-os') return 'engineering';
  if (slug === 'support-inbox') return 'support';
  if (slug === 'coaching-os') return 'ops';
  return 'other';
}

function PackVisual({ pack }: { pack: RegistryCard }) {
  const vertical = registryVertical(pack.slug);
  const accent =
    vertical === 'agency'
      ? 'from-amber-100 to-orange-50'
      : vertical === 'marketing'
        ? 'from-pink-100 to-violet-50'
        : vertical === 'engineering'
          ? 'from-blue-100 to-cyan-50'
          : vertical === 'support'
            ? 'from-emerald-100 to-teal-50'
            : 'from-stone-100 to-slate-50';
  return (
    <div
      className={`relative h-28 overflow-hidden rounded-[var(--radius-control)] border border-border-default bg-gradient-to-br ${accent} p-3`}
      aria-label={`${pack.name} contains ${pack.preview.databases} databases, ${pack.preview.views} views, ${pack.preview.automations} automations, and ${pack.preview.agents} agents`}
    >
      <div className="absolute -right-5 -top-6 h-20 w-20 rounded-full border border-white/70 bg-white/35" />
      <div className="relative grid h-full grid-cols-2 gap-2">
        <div className="rounded border border-white/80 bg-white/75 p-2 shadow-sm">
          <Database className="h-3.5 w-3.5 text-ink" />
          <p className="mt-2 text-[16px] font-semibold text-ink">{pack.preview.databases}</p>
          <p className="text-[10px] text-muted">databases</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-1 items-center gap-2 rounded border border-white/80 bg-white/70 px-2 shadow-sm">
            <Workflow className="h-3.5 w-3.5 text-ink" />
            <span className="text-[10px] text-muted">
              {pack.preview.automations} automation{pack.preview.automations === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex flex-1 items-center gap-2 rounded border border-white/80 bg-white/70 px-2 shadow-sm">
            <Bot className="h-3.5 w-3.5 text-ink" />
            <span className="text-[10px] text-muted">
              {pack.preview.agents} agent{pack.preview.agents === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

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
                {entry.data && 'screenshots' in entry.data && entry.data.screenshots[0] && (
                  <img
                    src={entry.data.screenshots[0]}
                    alt={`${entry.data.name} preview`}
                    className="max-h-52 w-full rounded-[var(--radius-control)] border border-border-default object-cover"
                  />
                )}
                {entry.data && 'highlights' in entry.data && entry.data.highlights.length > 0 && (
                  <ul className="grid gap-1 rounded-[var(--radius-control)] bg-hover p-3 text-[12px] text-muted sm:grid-cols-2">
                    {entry.data.highlights.map((highlight) => (
                      <li key={highlight}>• {highlight}</li>
                    ))}
                  </ul>
                )}
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

      <div className="mb-6 rounded-[var(--radius-card)] border border-border-default bg-card p-3">
        <div className="relative">
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
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${
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

      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">Gallery</p>
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
                <p className="text-[14px] font-medium text-ink">{pack.name}</p>
                {installState && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-ink">
                    {installState.update_available ? 'Update available' : 'Installed'}
                  </span>
                )}
              </div>
              <p className="line-clamp-3 text-[13px] text-muted">{pack.summary}</p>
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
          <p className="text-[13px] text-muted">No packs in the gallery yet.</p>
        )}
      </div>

      <p
        id="community-marketplace"
        className="mb-1 scroll-mt-6 text-[12px] font-semibold uppercase tracking-wider text-faint"
      >
        Community Marketplace
      </p>
      <p className="mb-2 text-[12px] text-muted">
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
                <p className="text-[14px] font-medium text-ink">{pack.name}</p>
                <div className="flex items-center gap-1">
                  {installState && (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-ink">
                      {installState.update_available ? 'Update' : 'Installed'}
                    </span>
                  )}
                  <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-ink-secondary">
                    {pack.vertical}
                  </span>
                </div>
              </div>
              <p className="line-clamp-3 text-[13px] text-muted">{pack.summary}</p>
              <p className="text-[11px] text-faint">
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
          <p className="text-[13px] text-muted">No community packs published yet.</p>
        )}
      </div>

      {noMatches && (
        <div className="mt-4 rounded-[var(--radius-card)] border border-dashed border-border-default p-8 text-center">
          <p className="text-[13px] font-medium text-ink">No packs match this search</p>
          <button
            type="button"
            className="mt-1 text-[12px] text-muted underline underline-offset-2"
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
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
        />
      )}
    </div>
  );
}
