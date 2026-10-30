'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { renamedAfterInstall } from '@/lib/space-start';
import { expandSpaceInSidebar, landingRoute } from '@/lib/pack-landing';
import { useSidebarMutations, useSpaces } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { PackVisual } from '@/components/pack-visual';
import { PackMap, PackWhy, ReuseChoice } from '@/components/pack-review';
import {
  existingChoices,
  reusedNames,
  reuseNote,
  reuseResolutions,
  type ExistingElsewhere,
  type PackRelation,
  type ReuseSelection,
} from '@/lib/pack-review';
import { InstallList } from '@/components/pack-install-list';
import {
  buildInstallRows,
  notNew,
  packSpaceName,
  sampleRecordCount,
  type InstallRow,
  type RowManifest,
} from '@/lib/pack-install-rows';
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

export type PackSource = 'registry' | 'marketplace';

export interface RegistryCard {
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
  /** #1145 — why a person would want the pack (one sentence), what they can do once it is in, and how its databases link. */
  why?: string | null;
  can?: string[];
  relations?: PackRelation[];
}
export interface RegistryEntry extends RegistryCard {
  manifest: unknown;
}
export interface MarketplaceCard {
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
  /** #1156 — a same-named database in ANOTHER space: the review offers "create a new one here" (default) or "use your existing one". */
  existing_elsewhere?: ExistingElsewhere;
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
export interface InstallSummary {
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

export const PACK_FILTERS = [
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

export function useRegistry() {
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

export function useMarketplace() {
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

export function useInstalledPacks(ws: string) {
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

export function InstallDialog({
  ws,
  slug,
  source = 'registry',
  installed,
  target,
  onOpenChange,
}: {
  ws: string;
  slug: string;
  source?: PackSource;
  /**
   * #1094 — install INTO this existing space (the space page's pack cards) instead of the space the manifest names. Sent as
   * `target_space_id` on preview AND install (#1095), so the review and the install can never disagree about where things land.
   */
  target?: { id: string; name: string };
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
  const router = useRouter();
  // #1167 — set once an install is on its way to the pack's default view, so the button cannot be pressed twice in the gap.
  const [landing, setLanding] = useState(false);
  const { updateSpace } = useSidebarMutations(ws);
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
    queryKey: ['pack-preview', ws, slug, target?.id ?? null],
    enabled: Boolean(entry.data),
    // A refusal (409/422/404 for a target space) is an answer, not a flake: do not retry it three times before saying so.
    retry: target ? false : undefined,
    queryFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/packs/preview' as never,
        {
          params: { path: { ws } },
          body: { manifest: entry.data!.manifest, ...(target ? { target_space_id: target.id } : {}) } as never,
        } as never,
      );
      if (error) throw error;
      return data as unknown as PreviewResult;
    },
  });

  // #1149 — databases that already exist in ANOTHER space. Nothing is reused unless the person picks it: `reuse` is empty by
  // default, so the install sends no reuse resolution and the pack creates its own, as before.
  const [reuse, setReuse] = useState<ReuseSelection>({});
  const choices = preview.data ? existingChoices(preview.data.databases) : [];
  const usable = choices.filter((c) => c.hint.reusable);
  const picked = reuseResolutions(choices, reuse);
  // What "use existing" would add to each reusable database ("Adds Owner, Industry."): the SAME preview, asked as if every
  // reusable one were chosen, so the numbers come from the server's own decision functions, not a guess here.
  const ifReused = useQuery({
    queryKey: ['pack-preview-reuse', ws, slug, target?.id ?? null, usable.map((c) => c.name).join('|')],
    enabled: Boolean(entry.data) && usable.length > 0,
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/packs/preview' as never,
        {
          params: { path: { ws } },
          body: {
            manifest: entry.data!.manifest,
            ...(target ? { target_space_id: target.id } : {}),
            resolutions: reuseResolutions(usable, Object.fromEntries(usable.map((c) => [c.name, true]))),
          } as never,
        } as never,
      );
      if (error) throw error;
      return data as unknown as PreviewResult;
    },
  });
  const addsFor = (name: string): string[] | undefined => {
    const gains = ifReused.data?.databases.find((d) => d.name === name)?.gains;
    return gains ? gains.fields.map((f) => f.name) : undefined;
  };

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
            ...(target ? { target_space_id: target.id } : {}),
            resolutions: { ...payload, ...agentResolutions(preview.data!.agents, agentChoices), ...picked },
          } as never,
        } as never,
      );
      if (error) throw error;
      return data as unknown as InstallResult;
    },
    onSuccess: async (data) => {
      // #1094 — a pack installed into a space still called exactly "Untitled space" names it after the pack. Only on a
      // SUCCESSFUL install (this is onSuccess), through the ordinary rename (PATCH space), and a failed rename never undoes or
      // blocks the install: it is a toast and the install carries on.
      const renamed = target ? renamedAfterInstall(target.name, packSpaceName(entry.data?.manifest as RowManifest | undefined)) : null;
      // #1167 — a pack that declares a default view takes you there instead of to a result list. Never on an update (that
      // dialog's result screen is the point), and null (nowhere better to go) leaves the screen exactly as it was.
      const route = update ? null : landingRoute(ws, entry.data?.manifest as RowManifest | undefined, data);
      if (target && renamed) {
        // When we are about to navigate the rename finishes FIRST, so the sidebar the person lands beside never shows the old name.
        const rename = updateSpace.mutateAsync({ id: target.id, name: renamed });
        const failed = (e: unknown) => toast.error(apiErrorMessage(e, `Installed, but could not rename the space to "${renamed}"`));
        if (route) await rename.catch(failed);
        else void rename.catch(failed);
      }
      void qc.invalidateQueries({ queryKey: ['packs-installed', ws] });
      void qc.invalidateQueries({ queryKey: ['onboarding', ws] });
      void qc.invalidateQueries();
      toast.success(`${data.name} installed`);
      if (route) {
        setLanding(true);
        const spaceId = target?.id ?? data.spaces.find((x) => x.action !== 'skipped')?.id;
        if (spaceId) expandSpaceInSidebar(spaceId);
        router.push(route);
        return;
      }
      setResult(data);
    },
    // With a target space the server's refusal text IS the message (it names the database and the space it lives in): never a
    // generic one in its place.
    // A reuse the server refuses (422) says why in its own words: show those, not a generic line.
    onError: (e) =>
      toast.error(
        target || Object.keys(picked).length > 0
          ? apiErrorMessage(e, 'Install failed — try again')
          : 'Install failed — see the collisions below and try again',
      ),
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
  // Installing into a chosen space: that space is where everything lands, whatever the manifest calls its own.
  const spaceName = target ? target.name : packSpaceName(manifest);
  // #1094 — what the space will be renamed to on a successful install (null: it keeps its name).
  const renameTo = target ? renamedAfterInstall(target.name, packSpaceName(manifest)) : null;
  const spaceExists = target
    ? true
    : Boolean(spaceName && spaces.data?.some((sp) => sp.name.trim().toLowerCase() === spaceName.trim().toLowerCase()));
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
                  {target ? 'Added to' : 'Your space,'} <b className="font-medium text-ink">{spaceName}</b>
                  {target ? ', with everything below.' : ', is in your sidebar with everything below.'}
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
              {target ? (
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              ) : (
                <Button type="button" onClick={() => goToSpace(result)}>
                  {spaceName ? `Go to ${spaceName}` : 'Go to my new space'}
                </Button>
              )}
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
                {/* #1149 — the review leads with WHY, then what you can do, then how it fits together. Each draws nothing when the
                    pack has none of it (a community pack), and the dialog's own gap is the only spacing. */}
                {source === 'registry' && card ? (
                  <>
                    <PackWhy source={card} />
                    <PackMap
                      slug={card.slug}
                      relations={card.relations}
                      databaseCount={card.preview.databases}
                      soleDatabase={card.workflow?.database}
                      heading
                    />
                    <PackVisual pack={card} />
                  </>
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
                        {target ? 'Sets up' : 'Adds to your space,'} <b className="font-medium">{spaceName}</b>
                        {target && renameTo ? (
                          <>
                            , renamed <b className="font-medium">{renameTo}</b>, with:
                          </>
                        ) : target ? (
                          ' with:'
                        ) : (
                          ':'
                        )}
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
                        {row.kind === 'database' &&
                          choices
                            .filter((c) => c.name === row.key)
                            .map((c) => (
                              <ReuseChoice
                                key={c.name}
                                ws={ws}
                                choice={c}
                                newSpace={spaceName ?? 'this space'}
                                selected={reuse[c.name] === true}
                                adds={addsFor(c.name)}
                                onSelect={(useExisting) => setReuse((prev) => ({ ...prev, [c.name]: useExisting }))}
                              />
                            ))}
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
                  {reuseNote(reusedNames(choices, reuse)) ??
                    (notNew(rows).length === 0
                    ? 'All new — nothing already in your workspace changes.'
                    : `${notNew(rows).length === 1 ? 'One thing' : `${notNew(rows).length} things`} already exist in your workspace — see the notes above. Nothing you have is removed.`)}
                </p>
                <div className="sticky bottom-0 -mx-[18px] flex justify-end gap-2 border-t border-border-default bg-card px-[18px] pb-3.5 pt-2.5">
                  <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={install.isPending || landing || unresolved.length > 0 || blocked}
                    title={blockedWhy}
                    onClick={() => install.mutate()}
                  >
                    {install.isPending || landing ? (
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
                    disabled={install.isPending || landing || unresolved.length > 0}
                    onClick={() => install.mutate()}
                  >
                    {install.isPending || landing ? (
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
            ) : target && preview.error ? (
              // #1095 — the server's refusal, verbatim: it names the database and the space it lives in.
              <>
                <p role="alert" className="rounded-[var(--radius-card)] border border-border-default bg-canvas p-3 text-body text-ink">
                  {apiErrorMessage(preview.error, 'This pack cannot be installed into this space.')}
                </p>
                <div className="flex justify-end">
                  <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                    Close
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

