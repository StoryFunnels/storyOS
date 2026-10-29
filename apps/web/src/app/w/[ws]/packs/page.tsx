'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Loader2,
  Package,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useSpaces, useWorkspace } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { PackVisual, packCountsLine, registryVertical } from '@/components/pack-visual';
import { InstallList } from '@/components/pack-install-list';
import {
  buildInstallRows,
  notNew,
  packSpaceName,
  sampleRecordCount,
  type InstallRow,
  type RowManifest,
} from '@/lib/pack-install-rows';

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

import type { DiffLine, PackAgentUpdate, PackDatabaseGains } from '@storyos/schemas';
import {
  agentEffect,
  agentResolutions,
  changedFieldsText,
  changesWhatItMayDo,
  itemEffect,
  releaseNotes,
  type AgentChoice,
  type PackItemKind,
} from '@/lib/pack-update';
import { useDateFormat } from '@/lib/preferences';

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
  /** #824 — the hero; read from the pack's own manifest. */
  workflow?: { database: string; field: string; stages: string[][] } | null;
  marks?: { agent: boolean; notifies: boolean };
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
  /** #977 — what an update does to an agent this pack installed earlier (only on a reused agent). */
  agent_update?: PackAgentUpdate;
  /** #982 — what a reused database gains: fields (name + type), options, views, and what is not applied, with the reason. */
  gains?: PackDatabaseGains;
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
  /** `updated` (#977): a reused agent brought up to this version. */
  action: 'created' | 'reused' | 'updated' | 'skipped';
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
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/packs/installed' as never,
        {
          params: { path: { ws } },
        } as never,
      );
      if (error) throw error;
      return data as unknown as InstallSummary[];
    },
  });
}

/**
 * Every `collision` across a preview, keyed by its label — what the resolver
 * UI iterates. #569 — `reuseOnly` marks a label whose collision includes a
 * database: the API's own `applyResolutions` (packs.service.ts) accepts just
 * `reuse` for a database collision — renaming would desynchronize the
 * manifest's symbolic `$db` refs, a correctness risk, not a UI gap — so
 * that's the only choice offered for it. Views, automations and agents
 * accept the full reuse/rename/skip set (verified against that same
 * server-side comment).
 */
interface CollisionEntry {
  name: string;
  reuseOnly: boolean;
}
function collisionEntries(preview: PreviewResult): CollisionEntry[] {
  const kindsByName = new Map<string, Set<'databases' | 'other'>>();
  const record = (items: PreviewItem[], kind: 'databases' | 'other') => {
    for (const item of items) {
      if (item.action !== 'collision') continue;
      const kinds = kindsByName.get(item.name) ?? new Set<'databases' | 'other'>();
      kinds.add(kind);
      kindsByName.set(item.name, kinds);
    }
  };
  record(preview.databases, 'databases');
  record(preview.views, 'other');
  record(preview.automations, 'other');
  record(preview.agents, 'other');
  return [...kindsByName.entries()].map(([name, kinds]) => ({
    name,
    // A name colliding as BOTH a database and something else shares one flat
    // `resolutions[name]` answer server-side — restrict the whole row
    // whenever a database collision is ANY part of it, rather than let it
    // look reusable/renameable when the database half isn't.
    reuseOnly: kinds.has('databases'),
  }));
}

function ActionBadge({ action }: { action: PreviewItem['action'] }) {
  const style =
    action === 'collision'
      ? 'bg-[var(--warning-soft)] text-[var(--warning-text)]'
      : action === 'create'
        ? 'bg-primary text-[var(--text-on-dark)]'
        : 'bg-hover text-muted';
  const label =
    action === 'collision' ? 'Name collision' : action === 'create' ? 'New' : 'Reuse existing';
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-meta font-medium ${style}`}
    >
      {label}
    </span>
  );
}

function PreviewSection({
  title,
  kind,
  items,
  choices,
  onChoice,
}: {
  title: string;
  kind: PackItemKind;
  items: PreviewItem[];
  /** #978 AC3 — the agent choices (Keep mine / Take update), by agent name. */
  choices?: Record<string, AgentChoice>;
  onChoice?: (name: string, choice: AgentChoice) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-meta font-medium uppercase tracking-wider text-muted">{title}</p>
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const agent =
            kind === 'agent' && item.agent_update ? agentEffect(item.agent_update) : null;
          return (
            <div key={item.name} className="flex items-start justify-between gap-2 text-body">
              <span className="min-w-0 flex-1">
                <span className="block text-ink-secondary">{item.name}</span>
                {/* #978 — what installing will really do. For an agent this pack installed it comes from the
                    preview's own `agent_update` (#977), never a guess; everything else from lib/pack-update.ts. */}
                {(agent?.headline ?? itemEffect(kind, item.action, item.gains)) && (
                  <span className="block text-label text-muted">
                    {agent ? agent.headline : itemEffect(kind, item.action, item.gains)}
                  </span>
                )}
                {agent?.detail && (
                  <span className="block text-label text-muted">{agent.detail}</span>
                )}
                {agent?.needsChoice && item.agent_update && (
                  <AgentChoiceControl
                    name={item.name}
                    update={item.agent_update}
                    choice={choices?.[item.name] ?? 'keep'}
                    onChoice={(c) => onChoice?.(item.name, c)}
                  />
                )}
              </span>
              <ActionBadge action={item.action} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One section of a line diff: "-" is what the agent says now (yours), "+" what the pack's update says. Never colour alone. */
function DiffBlock({ label, lines }: { label: string; lines: DiffLine[] }) {
  return (
    <div className="mt-1.5">
      <p className="text-meta font-medium uppercase tracking-wider text-muted">{label}</p>
      <div className="mt-0.5 max-h-56 overflow-auto rounded-[var(--radius-control)] border border-border-default bg-card font-mono text-label">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2 whitespace-pre-wrap px-2 py-0.5',
              l.op === 'add' && 'bg-success/10 text-ink',
              l.op === 'remove' && 'bg-error/10 text-ink',
              l.op === 'same' && 'text-muted',
            )}
          >
            <span aria-hidden className="w-3 shrink-0 select-none text-muted">
              {l.op === 'add' ? '+' : l.op === 'remove' ? '−' : ' '}
            </span>
            <span className="min-w-0 break-words">
              <span className="sr-only">
                {l.op === 'add' ? 'Added: ' : l.op === 'remove' ? 'Removed: ' : ''}
              </span>
              {l.text || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * #978 AC3 — an agent the person changed: Keep mine (the default, and what the API does without a resolution) or take
 * the pack's update, with the diff one tap away. A change to what the agent may access, or when it asks for approval,
 * is said out loud: it changes what the agent is allowed to do, not just what it says.
 */
function AgentChoiceControl({
  name,
  update,
  choice,
  onChoice,
}: {
  name: string;
  update: PackAgentUpdate;
  choice: AgentChoice;
  onChoice: (choice: AgentChoice) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const hasDiff = Boolean(update.diff?.goal?.length || update.diff?.instructions?.length);
  return (
    <span className="mt-1.5 block">
      <span className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          aria-label={`What to do with ${name}`}
          value={choice}
          onChange={(e) => onChoice(e.target.value as AgentChoice)}
        >
          <option value="keep">Keep mine</option>
          <option value="update">Take the pack’s update</option>
        </Select>
        {hasDiff && (
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            aria-expanded={showDiff}
            className="text-label font-medium text-primary-text underline"
          >
            {showDiff ? 'Hide changes' : 'Show changes'}
          </button>
        )}
      </span>
      {changesWhatItMayDo(update.changed_fields) && (
        <span className="mt-1 block text-label text-warning-text">
          Taking the update also changes what this agent is allowed to do:{' '}
          {changedFieldsText(
            update.changed_fields.filter((f) => f === 'scopes' || f === 'approval_policy'),
          )}
          .
        </span>
      )}
      {showDiff && update.diff && (
        <span className="block">
          {update.diff.goal?.length ? (
            <DiffBlock label="Goal: yours → the pack’s" lines={update.diff.goal} />
          ) : null}
          {update.diff.instructions?.length ? (
            <DiffBlock label="Instructions: yours → the pack’s" lines={update.diff.instructions} />
          ) : null}
        </span>
      )}
    </span>
  );
}

/**
 * #978 (part 1) — the update header: "v1.4 → v1.5", when it was published, and what changed in every version the update
 * crosses. A pack with no author notes (every built-in pack, and any marketplace pack whose author wrote none) says so
 * rather than leaving the space blank.
 */
function UpdateHeader({
  from,
  to,
  versions,
}: {
  from: string;
  to: string;
  versions: Array<{ version: string; changelog?: string; published_at: string }> | undefined;
}) {
  const fmt = useDateFormat();
  const notes = releaseNotes(versions, from, to);
  return (
    <div
      className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3"
      data-testid="pack-update-header"
    >
      <p className="text-prose font-semibold text-ink">
        v{from} → v{to}
        {notes.latest && (
          <span className="ml-2 text-label font-normal text-muted">
            published {fmt.date(notes.latest.published_at)}
          </span>
        )}
      </p>
      {notes.noNotes ? (
        <p className="mt-1.5 text-body text-muted">No notes from the author.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {notes.latest && (
            <div>
              <p className="text-label font-semibold text-ink">
                What’s new in {notes.latest.version}
              </p>
              <p className="whitespace-pre-line text-body text-ink-secondary">
                {notes.latest.changelog?.trim() || 'No notes from the author.'}
              </p>
            </div>
          )}
          {notes.earlier.length > 0 && (
            <div>
              <p className="text-label font-semibold text-ink">Earlier versions</p>
              <div className="flex flex-col gap-1">
                {notes.earlier.map((v) => (
                  <p key={v.version} className="whitespace-pre-line text-body text-ink-secondary">
                    <span className="font-medium text-ink">{v.version}</span> —{' '}
                    {v.changelog?.trim() || 'No notes from the author.'}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CollisionResolver({
  entries,
  resolutions,
  onChange,
}: {
  entries: CollisionEntry[];
  resolutions: Record<string, Resolution>;
  onChange: (label: string, resolution: Resolution) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
      <p className="mb-2 text-label font-semibold text-ink">
        {entries.length} name{entries.length > 1 ? 's' : ''} already exist in this workspace
      </p>
      <div className="flex flex-col gap-2">
        {entries.map(({ name: label, reuseOnly }) => {
          const resolution = resolutions[label] ?? { action: 'reuse' };
          return (
            <div
              key={label}
              className="flex flex-col gap-1.5 rounded-[var(--radius-control)] bg-card p-2"
            >
              <p className="text-body text-ink">{label}</p>
              {/* #569 — a database collision only ever accepts "reuse" server-side
                  (renaming would desync the manifest's symbolic $db refs); no
                  select is offered rather than one that 422s at submit. */}
              {reuseOnly ? (
                <p className="text-label text-muted">
                  Will reuse the existing database — rename/skip aren't supported for a database
                  name collision yet.
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  {/* #717 bonus — was 12px (a near-miss on the ticket's own
                      grep, not the standard 13px shape); now `sm`'s text-body
                      like every other migrated h-8 select. */}
                  <Select
                    size="sm"
                    value={resolution.action}
                    onChange={(e) =>
                      onChange(label, {
                        ...resolution,
                        action: e.target.value as Resolution['action'],
                      })
                    }
                  >
                    <option value="reuse">Reuse the existing one</option>
                    <option value="rename">Install under a new name</option>
                    <option value="skip">Skip it</option>
                  </Select>
                  {resolution.action === 'rename' && (
                    <Input
                      className="h-8"
                      placeholder="New name"
                      value={resolution.rename_to ?? ''}
                      onChange={(e) =>
                        onChange(label, { ...resolution, rename_to: e.target.value })
                      }
                    />
                  )}
                </div>
              )}
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
  installed,
  onOpenChange,
}: {
  ws: string;
  slug: string;
  source?: PackSource;
  /** #978 — this workspace's install of the pack, if any: when it has an update waiting, the dialog is an UPDATE dialog. */
  installed?: InstallSummary;
  onOpenChange: (open: boolean) => void;
}) {
  // Frozen when the dialog opens: installing refetches the installed list, which would otherwise flip this to "not an
  // update" under the result screen.
  const [update] = useState(() =>
    installed?.update_available && installed.latest_version
      ? { from: installed.version, to: installed.latest_version }
      : null,
  );
  const qc = useQueryClient();
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  // #978 AC3 — an agent the person changed defaults to Keep mine; only an explicit 'update' reaches the API.
  const [agentChoices, setAgentChoices] = useState<Record<string, AgentChoice>>({});
  const [result, setResult] = useState<InstallResult | null>(null);
  // #978 — "Use my <X> database": a name that already exists is a decision, so Install waits for it.
  const [useMine, setUseMine] = useState<Record<string, boolean>>({});
  const spaces = useSpaces(ws);
  // The hero (#824) is read from the pack's own manifest by the registry LIST endpoint; the detail endpoint omits it.
  const card = useRegistry().data?.find((c) => c.slug === slug);

  const entry = useQuery({
    queryKey: ['pack-entry', source, slug],
    queryFn: async () => {
      const path =
        source === 'marketplace'
          ? '/api/v1/packs/marketplace/{slug}'
          : '/api/v1/packs/registry/{slug}';
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
      const entries = collisionEntries(preview.data!);
      const payload = Object.fromEntries(
        entries.map(({ name }) => [name, resolutions[name] ?? { action: 'reuse' }]),
      );
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/packs/install' as never,
        {
          params: { path: { ws } },
          body: {
            manifest: entry.data!.manifest,
            resolutions: { ...payload, ...agentResolutions(preview.data!.agents, agentChoices) },
          } as never,
        } as never,
      );
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

  // #569 — a reuse-only row (any database collision) is never rendered a
  // control, so it never gets an explicit `resolutions[name]`; it's already
  // resolved by default (reuse) and must not block Install waiting for input
  // that's never coming.
  const unresolved = preview.data
    ? collisionEntries(preview.data)
        .filter((e) => !e.reuseOnly)
        .map((e) => e.name)
        .filter((name) => !resolutions[name])
    : [];
  const firstDbId = result?.databases.find((d) => d.action !== 'skipped')?.id;
  const created = (r: InstallResult) =>
    [...r.databases, ...r.views, ...r.automations, ...r.agents, ...r.skills].filter(
      (i) => i.action === 'created',
    );
  // #978 AC3 — what an update did to agents, from the install result itself (`updated`) and from the choice the person
  // made for an agent they had changed (Keep mine sends no resolution, so the API reports it as plain `reused`).
  const updatedAgents = (r: InstallResult) => r.agents.filter((a) => a.action === 'updated');
  const keptAgents = (preview.data?.agents ?? []).filter(
    (a) => a.agent_update?.status === 'edited_needs_choice' && agentChoices[a.name] !== 'update',
  );

  // #978 — the install dialog's one list, in a person's words (lib/pack-install-rows.ts).
  const manifest = entry.data?.manifest as RowManifest | undefined;
  const rows: InstallRow[] = preview.data ? buildInstallRows(preview.data, manifest) : [];
  const spaceName = packSpaceName(manifest);
  const spaceExists = Boolean(
    spaceName && spaces.data?.some((sp) => sp.name.trim().toLowerCase() === spaceName.trim().toLowerCase()),
  );
  const samples = sampleRecordCount(manifest);
  // A database name that already exists must be ticked; a view/automation/agent name uses the select (`unresolved`).
  const dbCollisions = rows.filter((r) => r.kind === 'database' && r.action === 'collision');
  const untickedDb = dbCollisions.filter((r) => !useMine[r.key]);
  // A reused database that has a field the pack cannot add makes the install fail: say so instead of offering Install.
  const blockers = rows.flatMap((r) => (r.item.gains?.not_applied ?? []).filter((n) => n.blocks_install));
  const blocked = untickedDb.length > 0 || blockers.length > 0;
  const blockedWhy = blockers.length
    ? `${blockers[0]!.name}: ${blockers[0]!.reason}`
    : untickedDb.length
      ? `Decide about ${untickedDb[0]!.name} first`
      : unresolved.length
        ? `Choose what to do with ${rows.find((r) => r.key === unresolved[0])?.name ?? unresolved[0]} first`
        : undefined;
  const rowByKey = new Map(rows.map((r) => [`${r.kind}:${r.key}`, r]));
  const doneRows = (r: InstallResult): InstallRow[] => {
    const make = (kind: InstallRow['kind'], list: InstalledEntity[]) =>
      list
        .filter((i) => i.action === 'created')
        .map((i) => {
          const known = rowByKey.get(`${kind}:${i.name}`);
          return (
            known ?? {
              key: i.name,
              kind,
              name: i.name,
              sub: '',
              action: 'create' as const,
              note: null,
              item: { name: i.name, action: 'create' as const },
            }
          );
        });
    return [
      ...make('database', r.databases),
      ...make('view', r.views),
      ...make('automation', r.automations),
      ...make('agent', r.agents),
    ];
  };
  const goToSpace = (r: InstallResult) => {
    const space = r.spaces.find((x) => x.action !== 'skipped');
    window.location.href = space ? `/w/${ws}/s/${space.id}` : `/w/${ws}`;
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={
          result && !update
            ? `${result.name} is ready`
            : entry.data
              ? update
                ? `Update ${entry.data.name}`
                : `Install ${entry.data.name}`
              : update
                ? 'Update pack'
                : 'Install pack'
        }
        className={
          update
            ? 'max-w-[520px]'
            : 'max-h-[calc(100vh-32px)] max-w-[520px] overflow-auto p-[18px] pb-0'
        }
      >
        {result && !update ? (
          <div className="flex flex-col gap-3">
            <p className="text-body text-ink-secondary">
              {spaceName ? (
                <>
                  Your space, <b className="font-medium text-ink">{spaceName}</b>, is in your sidebar
                  with everything below.
                </>
              ) : (
                'Everything below is in your sidebar.'
              )}
              {samples > 0 && ' Its sample records can be removed from Home whenever you like.'}
            </p>
            {doneRows(result).length > 0 ? (
              <InstallList rows={doneRows(result).map((r) => ({ ...r, sub: '', note: null, action: 'create' }))} />
            ) : (
              <p className="text-body text-muted">Everything already existed — nothing new was created.</p>
            )}
            {result.unmet.length > 0 && (
              <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
                <p className="mb-1.5 text-label font-semibold text-ink">Still to connect</p>
                <div className="flex flex-col gap-1">
                  {result.unmet.map((u) => (
                    <p key={u.name} className="text-label text-muted">
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
            <div className="sticky bottom-0 -mx-[18px] mt-1 flex justify-end gap-2 border-t border-border-default bg-card px-[18px] pb-3.5 pt-2.5">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" onClick={() => goToSpace(result)}>
                {spaceName ? `Go to ${spaceName}` : 'Go to my new space'}
              </Button>
            </div>
          </div>
        ) : result ? (
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink-secondary">
              {update
                ? `${result.name} is now v${result.version}. Here’s what changed:`
                : `${result.name} v${result.version} is installed. Here’s what you got:`}
            </p>
            <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
              {created(result).length === 0 &&
              updatedAgents(result).length === 0 &&
              keptAgents.length === 0 ? (
                <p className="text-body text-muted">
                  Everything already existed — nothing new was created.
                </p>
              ) : (
                <>
                  {created(result).map((item) => (
                    <div
                      key={`${item.name}-${item.id}`}
                      className="flex items-center gap-2 text-body"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      <span className="text-ink-secondary">{item.name}</span>
                    </div>
                  ))}
                  {updatedAgents(result).map((item) => (
                    <div key={`updated-${item.id}`} className="flex items-center gap-2 text-body">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      <span className="text-ink-secondary">
                        {item.name} — agent updated to this version
                      </span>
                    </div>
                  ))}
                  {keptAgents.map((item) => (
                    <div key={`kept-${item.name}`} className="flex items-center gap-2 text-body">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted" />
                      <span className="text-ink-secondary">{item.name} — kept your version</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            {result.unmet.length > 0 && (
              <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
                <p className="mb-1.5 text-label font-semibold text-ink">Still to connect</p>
                <div className="flex flex-col gap-1">
                  {result.unmet.map((u) => (
                    <p key={u.name} className="text-label text-muted">
                      {u.detail}{' '}
                      {u.kind === 'connection' && (
                        <Link
                          href={`/w/${ws}/settings/connections`}
                          className="underline underline-offset-2"
                        >
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
                <Button
                  type="button"
                  onClick={() => (window.location.href = `/w/${ws}/d/${firstDbId}`)}
                >
                  Go to my new space
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {entry.isLoading || preview.isLoading ? (
              <div className="flex items-center gap-2 py-8 text-body text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Looking at what this would create…
              </div>
            ) : preview.data && !update ? (
              <>
                {source === 'registry' && card ? (
                  <PackVisual pack={card} />
                ) : entry.data && 'screenshots' in entry.data && entry.data.screenshots[0] ? (
                  <img
                    src={entry.data.screenshots[0]}
                    alt={`${entry.data.name} preview`}
                    className="max-h-52 w-full rounded-[var(--radius-control)] border border-border-default object-cover"
                  />
                ) : null}
                <p className="-mb-1.5 text-body text-ink">
                  {spaceName ? (
                    spaceExists ? (
                      <>
                        Adds to your space, <b className="font-medium">{spaceName}</b>:
                      </>
                    ) : (
                      <>
                        Adds a new space, <b className="font-medium">{spaceName}</b>, with:
                      </>
                    )
                  ) : (
                    'Adds:'
                  )}
                </p>
                <InstallList
                  rows={rows}
                  renderExtra={(row) => {
                    const entryFor = collisionEntries(preview.data!).find((c) => c.name === row.key);
                    const agent =
                      row.kind === 'agent' && row.item.agent_update
                        ? agentEffect(row.item.agent_update)
                        : null;
                    return (
                      <>
                        {agent && (
                          <>
                            <span className="mt-0.5 text-label text-ink-secondary">{agent.headline}</span>
                            {agent.detail && <span className="text-label text-muted">{agent.detail}</span>}
                            {agent.needsChoice && row.item.agent_update && (
                              <AgentChoiceControl
                                name={row.key}
                                update={row.item.agent_update}
                                choice={agentChoices[row.key] ?? 'keep'}
                                onChoice={(c) => setAgentChoices((prev) => ({ ...prev, [row.key]: c }))}
                              />
                            )}
                          </>
                        )}
                        {row.kind === 'database' && row.action === 'collision' && (
                          <label className="mt-1 flex items-center gap-1.5 text-label font-medium text-ink">
                            <input
                              type="checkbox"
                              checked={Boolean(useMine[row.key])}
                              onChange={(e) => setUseMine((prev) => ({ ...prev, [row.key]: e.target.checked }))}
                            />
                            Use my {row.name} database
                          </label>
                        )}
                        {row.action === 'collision' && entryFor && !entryFor.reuseOnly && (
                          <span className="mt-1 flex items-center gap-2">
                            <Select
                              size="sm"
                              aria-label={`What to do with ${row.name}`}
                              value={resolutions[row.key]?.action ?? ''}
                              onChange={(e) =>
                                setResolutions((prev) => ({
                                  ...prev,
                                  [row.key]: { ...prev[row.key], action: e.target.value as Resolution['action'] },
                                }))
                              }
                            >
                              <option value="" disabled>
                                Choose…
                              </option>
                              <option value="reuse">Use the one I have</option>
                              <option value="rename">Install under a new name</option>
                              <option value="skip">Skip it</option>
                            </Select>
                            {resolutions[row.key]?.action === 'rename' && (
                              <Input
                                className="h-8"
                                placeholder="New name"
                                value={resolutions[row.key]?.rename_to ?? ''}
                                onChange={(e) =>
                                  setResolutions((prev) => ({
                                    ...prev,
                                    [row.key]: { ...prev[row.key]!, rename_to: e.target.value },
                                  }))
                                }
                              />
                            )}
                          </span>
                        )}
                      </>
                    );
                  }}
                />
                {samples > 0 && (
                  <p className="-mb-1.5 text-label text-muted">
                    Includes {samples} sample {samples === 1 ? 'record' : 'records'} so the views
                    aren’t empty — remove {samples === 1 ? 'it' : 'them'} in one click from Home
                    (“Remove sample data”).
                  </p>
                )}
                {preview.data.unmet.length > 0 && (
                  <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
                    <p className="mb-1 text-label font-semibold text-ink">You’ll need to connect</p>
                    {preview.data.unmet.map((u) => (
                      <p key={u.name} className="text-label text-muted">
                        {u.detail}
                      </p>
                    ))}
                  </div>
                )}
                <p className="-mb-1 flex items-center gap-1.5 text-label text-muted" data-testid="pack-install-note">
                  <Check className="h-3 w-3 shrink-0" />
                  {notNew(rows).length === 0
                    ? 'All new — nothing already in your workspace changes.'
                    : `${notNew(rows).length === 1 ? 'One thing' : `${notNew(rows).length} things`} already exist in your workspace — see the notes above. Nothing you have is removed.`}
                </p>
                <div className="sticky bottom-0 -mx-[18px] flex justify-end gap-2 border-t border-border-default bg-card px-[18px] pb-3.5 pt-2.5">
                  <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={install.isPending || unresolved.length > 0 || blocked}
                    title={blockedWhy}
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
            ) : preview.data ? (
              <>
                {update && (
                  <UpdateHeader
                    from={update.from}
                    to={update.to}
                    versions={
                      entry.data && 'versions' in entry.data ? entry.data.versions : undefined
                    }
                  />
                )}
                <p className="text-body text-ink-secondary">{entry.data?.summary}</p>
                {entry.data && 'screenshots' in entry.data && entry.data.screenshots[0] && (
                  <img
                    src={entry.data.screenshots[0]}
                    alt={`${entry.data.name} preview`}
                    className="max-h-52 w-full rounded-[var(--radius-control)] border border-border-default object-cover"
                  />
                )}
                {entry.data && 'highlights' in entry.data && entry.data.highlights.length > 0 && (
                  <ul className="grid gap-1 rounded-[var(--radius-control)] bg-hover p-3 text-label text-muted sm:grid-cols-2">
                    {entry.data.highlights.map((highlight) => (
                      <li key={highlight}>• {highlight}</li>
                    ))}
                  </ul>
                )}
                <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto">
                  <PreviewSection
                    title="Databases"
                    kind="database"
                    items={preview.data.databases}
                  />
                  <PreviewSection title="Views" kind="view" items={preview.data.views} />
                  <PreviewSection
                    title="Automations"
                    kind="automation"
                    items={preview.data.automations}
                  />
                  <PreviewSection
                    title="Agents"
                    kind="agent"
                    items={preview.data.agents}
                    choices={agentChoices}
                    onChoice={(name, choice) =>
                      setAgentChoices((prev) => ({ ...prev, [name]: choice }))
                    }
                  />
                </div>
                {preview.data.unmet.length > 0 && (
                  <div className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
                    <p className="mb-1 text-label font-semibold text-ink">You’ll need to connect</p>
                    {preview.data.unmet.map((u) => (
                      <p key={u.name} className="text-label text-muted">
                        {u.detail}
                      </p>
                    ))}
                  </div>
                )}
                <CollisionResolver
                  entries={collisionEntries(preview.data)}
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
                    ) : update ? (
                      `Update to v${update.to}`
                    ) : (
                      'Install pack'
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-body text-muted">Could not load this pack.</p>
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
                  <span className="shrink-0 rounded-full border border-border-default bg-hover px-2 py-0.5 text-micro font-medium text-ink">
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
                    <span className="rounded-full border border-border-default bg-hover px-2 py-0.5 text-micro font-medium text-ink">
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
