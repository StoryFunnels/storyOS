'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { useDatabase } from '@/components/table-view/use-table-data';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { presentAvailability, type ProviderAvailability } from '@/lib/provider-availability';
import { autoMatchMapping } from '@/lib/source-field-match';
import { PROVIDER_FIELD_CATALOG } from '@/lib/source-field-catalog';
import { configFieldLabel, parseListValue, validateConfigField } from '@/lib/source-config-fields';
import {
  buildRecurrence,
  describeRecurrence,
  DEFAULT_RECURRENCE_FORM,
  REPEAT_LABELS,
  WEEKDAY_LABELS,
  type RecurrenceFormState,
  type RecurrenceKind,
  type SourceRecurrence,
} from '@/lib/source-recurrence';

/**
 * #339 — Google Calendar is discoverable from the Sources picker, but its sync
 * is a two-way binding (a different engine from the upsert-only source
 * framework), so selecting it points the user to the Calendar integration
 * rather than duplicating that flow here. A synthetic provider id, never sent
 * to the sources API.
 */
const CALENDAR_POINTER_ID = '__google_calendar__';

interface SourceSummary {
  id: string;
  name: string;
  connection_id: string | null;
  provider_source: string;
  config: Record<string, unknown>;
  field_mapping: Record<string, string>;
  external_key_field_id: string;
  schedule: '15m' | 'hour' | 'day';
  recurrence: SourceRecurrence | null;
  status: 'active' | 'paused' | 'error';
  last_sync_at: string | null;
  created_at: string;
}

interface SourceRunSummary {
  id: string;
  status: 'running' | 'ok' | 'error' | 'skipped_quota' | 'skipped_cap';
  fetched: number;
  created: number;
  updated: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** Provider-owned run metadata (MN-262: Apify's compute-unit usage). */
  stats: Record<string, unknown> | null;
}

type ConfigFieldKind = 'string' | 'number' | 'boolean' | 'array' | 'json';

interface SourceProviderSummary {
  id: string;
  label: string;
  connection_provider: string;
  /** MN-262: the responsibility-framing text shown under the provider picker
   * for providers that run under the user's own third-party account. */
  description: string | null;
  /** MN-262: this provider implements `discover()` — the dialog can offer a
   * "Discover fields" button instead of requiring a static field catalog. */
  supports_discover: boolean;
  config_schema: Record<string, { description: string | null; required: boolean; kind: ConfigFieldKind }>;
}

interface ConnectionSummary {
  id: string;
  provider: string;
  name: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = { active: 'Active', paused: 'Paused', error: 'Error' };

/**
 * #125 — field types a source can NOT write to, so they're never offered as
 * mapping targets: the read-only system columns (`id`, the created/updated
 * timestamps, created_by/updated_by) and the computed/relational types the
 * record write path rejects. Everything else — including the record Name (a
 * `title` field) — is a valid, writable target.
 */
const NON_MAPPABLE_TARGET_TYPES = new Set([
  'id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'lookup',
  'rollup',
  'formula',
  'button',
  'relation',
]);

type MappingDestination =
  | { kind: 'skip' }
  | { kind: 'existing'; field_id: string }
  | { kind: 'new'; type: string };

function useSources(ws: string, db: string) {
  return useQuery({
    queryKey: ['sources', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/sources', {
        params: { path: { ws, db } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: SourceSummary[] }).data;
    },
    enabled: Boolean(ws && db),
  });
}

function useSourceProviders(ws: string, db: string) {
  return useQuery({
    queryKey: ['source-providers', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/sources/providers', {
        params: { path: { ws, db } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: SourceProviderSummary[] }).data;
    },
    enabled: Boolean(ws && db),
  });
}

function useConnections(ws: string) {
  return useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', { params: { path: { ws } } } as never);
      if (error) throw error;
      return (data as unknown as { data: ConnectionSummary[] }).data;
    },
    enabled: Boolean(ws),
  });
}

interface ConnectionProviderSummary {
  id: string;
  availability?: ProviderAvailability;
  availability_note?: string;
}

/**
 * #347 — the connection-provider catalog, only for its server-authoritative
 * `availability` verdict. The Sources picker keys each source provider to its
 * underlying `connection_provider` so a provider that isn't connectable on this
 * deployment (Tier C off Cloud, or a Tier B OAuth app the operator hasn't wired)
 * renders its honest state instead of a dead "pick me" row. Shares the gallery's
 * query cache (same key).
 */
function useConnectionProviders(ws: string) {
  return useQuery({
    queryKey: ['connection-providers', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections/providers', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: ConnectionProviderSummary[] }).data;
    },
    enabled: Boolean(ws),
  });
}

function useSourceRuns(ws: string, db: string, id: string | null) {
  return useQuery({
    queryKey: ['source-runs', ws, db, id],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}/runs', {
        params: { path: { ws, db, id: id! } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: SourceRunSummary[] }).data;
    },
    enabled: Boolean(ws && db && id),
  });
}

interface YoutubeChannel {
  id: string;
  title: string;
  thumbnail?: string;
}

/** #341 — the channels the chosen Google connection owns, feeding the required
 * channel picker. Only enabled once a connection is picked; a failure (no
 * channels, revoked scope, API error) surfaces as `isError`/empty `data` so the
 * dialog can fall back to a free-text id instead of blocking the user. */
function useYoutubeChannels(ws: string, db: string, connectionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['youtube-channels', ws, db, connectionId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}/sources/channels', {
        params: { path: { ws, db }, query: { connection_id: connectionId } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: YoutubeChannel[] }).data;
    },
    enabled: Boolean(ws && db && connectionId && enabled),
    retry: false,
  });
}

/** "Sync from…" (#239): configure a source — provider → connection → config →
 * field mapping → schedule — then list/sync-now/delete existing ones. */
export function SourcesDialog({ ws, db, onDone }: { ws: string; db: string; onDone: () => void }) {
  const qc = useQueryClient();
  const fmt = useDateFormat();
  const confirm = useConfirm();
  const database = useDatabase(ws, db);
  const sources = useSources(ws, db);
  const providers = useSourceProviders(ws, db);
  const connections = useConnections(ws);
  const connectionProviders = useConnectionProviders(ws);

  /** #347 — availability of a source provider, resolved through its underlying
   * connection provider's server verdict (defaults to connectable if the
   * catalog hasn't loaded or a backend predates #345). */
  const availabilityOf = (sourceProvider: SourceProviderSummary | undefined) => {
    const cp = connectionProviders.data?.find((c) => c.id === sourceProvider?.connection_provider);
    return presentAvailability(cp?.availability ?? 'connectable', cp?.availability_note);
  };

  /** #339/#347 — the Calendar pointer's honest state, resolved through the
   * google-calendar connection provider (Tier B oauth_managed). */
  const calendarConnProvider = connectionProviders.data?.find((c) => c.id === 'google-calendar');
  const calendarPresent = presentAvailability(
    calendarConnProvider?.availability ?? 'connectable',
    calendarConnProvider?.availability_note,
  );

  const [step, setStep] = useState<'list' | 'new' | 'runs'>('list');
  const [runsFor, setRunsFor] = useState<SourceSummary | null>(null);

  // --- new-source wizard state ---
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [recurrenceForm, setRecurrenceForm] = useState<RecurrenceFormState>(DEFAULT_RECURRENCE_FORM);
  const [mapping, setMapping] = useState<Map<string, MappingDestination>>(new Map());
  const [keyExternalKey, setKeyExternalKey] = useState<string>('');
  const [busy, setBusy] = useState(false);
  /** MN-262: filled in by "Discover fields" for providers with no static
   * PROVIDER_FIELD_CATALOG entry (e.g. apify.actor — the actor decides the
   * shape, not the provider). */
  const [discoveredCatalog, setDiscoveredCatalog] = useState<
    Array<{ key: string; label: string; suggestedType: string; isKey?: boolean }> | null
  >(null);

  const provider = providers.data?.find((p) => p.id === providerId);
  const catalog = providerId ? PROVIDER_FIELD_CATALOG[providerId] ?? discoveredCatalog ?? [] : [];
  const eligibleConnections = (connections.data ?? []).filter((c) => c.provider === provider?.connection_provider);
  // #125 — the mapping targets are every field the sync engine can actually
  // WRITE. The record Name (a `title` field) is writable — it maps to the
  // promoted title column — and MUST be offered: without it a source's title
  // (a YouTube video's title, an article headline, …) has nowhere to land and
  // records import nameless, unusable. Excluded are the read-only system
  // columns and the computed/relational field types the write path rejects.
  // Created date is deliberately NOT a target: `created_at` is system-managed
  // and the record write path rejects writes to it, so offering it would just
  // fail every sync — surfacing it as mappable would be faking support.
  const existingFields = (database.data?.fields ?? []).filter(
    (f) => !NON_MAPPABLE_TARGET_TYPES.has(f.type),
  );

  // #341 — providers that sync a specific YouTube channel expose a `channel_id`
  // config key; for those we replace the free-text box with a required picker
  // fed by the connected account's own channels.
  const providerHasChannelPicker = Boolean(provider && 'channel_id' in (provider.config_schema ?? {}));
  const channels = useYoutubeChannels(ws, db, connectionId, providerHasChannelPicker);
  // The picker is "active" only when we actually got channels back; an empty
  // list or an error means we fall back to the free-text id below.
  const channelPickerActive = providerHasChannelPicker && (channels.data?.length ?? 0) > 0;
  const channelFallback = providerHasChannelPicker && !channels.isLoading && (channels.isError || (channels.data?.length ?? 0) === 0);

  /** #342 — pre-select an EXISTING field for each provider key where the target
   * database already has a name+type-compatible one, so mapping stops defaulting
   * every row to "+ New … field" and forcing duplicate columns. Falls back to
   * "new" (keeping the type hint) only where nothing reasonable matches. */
  function applyCatalog(cat: Array<{ key: string; label: string; suggestedType: string; isKey?: boolean }>) {
    setMapping(autoMatchMapping(cat, existingFields) as Map<string, MappingDestination>);
    setKeyExternalKey(cat.find((c) => c.isKey)?.key ?? cat[0]?.key ?? '');
  }

  function resetWizard() {
    setName('');
    setProviderId('');
    setConnectionId('');
    setConfig({});
    setRecurrenceForm(DEFAULT_RECURRENCE_FORM);
    setMapping(new Map());
    setKeyExternalKey('');
    setDiscoveredCatalog(null);
  }

  function selectProvider(id: string) {
    setProviderId(id);
    setConnectionId('');
    setConfig({});
    setDiscoveredCatalog(null);
    applyCatalog(PROVIDER_FIELD_CATALOG[id] ?? []);
  }

  const discoverFields = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/sources/discover', {
        params: { path: { ws, db } },
        body: { connection_id: connectionId, provider_source: providerId, config: rawConfigToRecord() },
      } as never);
      if (error) throw error;
      return (data as unknown as { keys: string[] }).keys;
    },
    onSuccess: (keys) => {
      const cat = keys.map((key) => ({ key, label: key, suggestedType: 'text' }));
      setDiscoveredCatalog(cat);
      applyCatalog(cat);
      toast.success(`Found ${cat.length} field${cat.length === 1 ? '' : 's'} — map them below`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not discover fields')),
  });

  /** Best-effort config parse shared by "Discover fields" and source creation
   * — a JSON-kind field (e.g. apify.actor's `input`) is parsed, not sent as a
   * raw string, or the provider's own configSchema would reject it. */
  function rawConfigToRecord(): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(config)) {
      if (!raw.trim()) continue;
      const kind = provider?.config_schema[key]?.kind ?? (key.endsWith('_ids') ? 'array' : 'string');
      if (kind === 'boolean') parsed[key] = raw === 'true';
      else if (kind === 'number') parsed[key] = Number(raw);
      else if (kind === 'json') {
        try {
          parsed[key] = JSON.parse(raw);
        } catch {
          throw new Error(`"${key}" must be valid JSON`);
        }
      } else if (kind === 'array') parsed[key] = parseListValue(raw);
      else parsed[key] = raw.trim();
    }
    return parsed;
  }

  const createField = useMutation({
    mutationFn: async (input: { display_name: string; type: string }) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/fields', {
        params: { path: { ws, db } },
        body: { display_name: input.display_name, type: input.type as never, config: {} },
      } as never);
      if (error) throw error;
      return data as unknown as { id: string; apiName: string };
    },
  });

  const createSource = useMutation({
    mutationFn: async () => {
      // Resolve every 'new' mapping row to a real field id first — a partial
      // failure here must not leave a source pointing at a field that was
      // never actually created.
      const fieldIdByKey = new Map<string, string>();
      for (const item of catalog) {
        const dest = mapping.get(item.key) ?? { kind: 'skip' as const };
        if (dest.kind === 'skip') continue;
        if (dest.kind === 'existing') {
          fieldIdByKey.set(item.key, dest.field_id);
        } else {
          const created = await createField.mutateAsync({ display_name: item.label, type: dest.type });
          fieldIdByKey.set(item.key, created.id);
        }
      }
      const externalKeyFieldId = fieldIdByKey.get(keyExternalKey);
      if (!externalKeyFieldId) throw new Error('Pick a field for the external key column before saving.');

      const parsedConfig = rawConfigToRecord();

      const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/sources', {
        params: { path: { ws, db } },
        body: {
          name: name.trim() || provider?.label || providerId,
          connection_id: connectionId,
          provider_source: providerId,
          config: parsedConfig,
          field_mapping: Object.fromEntries(fieldIdByKey),
          external_key_field_id: externalKeyFieldId,
          recurrence: buildRecurrence(recurrenceForm),
        } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Source created — it will sync on its schedule');
      resetWizard();
      setStep('list');
      void qc.invalidateQueries({ queryKey: ['sources', ws, db] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not create the source')),
  });

  const syncNow = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}/sync-now', {
        params: { path: { ws, db, id } },
      } as never);
      if (error) throw error;
      return data as unknown as SourceRunSummary;
    },
    onSuccess: (run) => {
      const summary =
        run.status === 'ok'
          ? `Synced — ${run.created} created, ${run.updated} updated`
          : run.status === 'skipped_quota'
            ? 'Skipped — today\'s API quota is used up'
            : run.status === 'skipped_cap'
              ? 'Skipped — this month\'s run cap is used up'
              : `Sync failed${run.error ? `: ${run.error}` : ''}`;
      if (run.status === 'ok') toast.success(summary);
      else toast.error(summary);
      void qc.invalidateQueries({ queryKey: ['sources', ws, db] });
      void qc.invalidateQueries({ queryKey: ['source-runs', ws, db] });
      void qc.invalidateQueries({ queryKey: ['records'] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Sync failed')),
  });

  const removeSource = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/sources/{id}', {
        params: { path: { ws, db, id } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sources', ws, db] }),
    onError: () => toast.error('Could not delete the source'),
  });

  const runs = useSourceRuns(ws, db, runsFor?.id ?? null);

  // #113 — per-field config validation (e.g. LinkedIn post_urns must be
  // urn:li:… URNs). First offending field's message, or null when all clean.
  const configError = provider
    ? Object.keys(provider.config_schema ?? {})
        .map((key) => validateConfigField(providerId, key, config[key] ?? ''))
        .find((err): err is string => Boolean(err)) ?? null
    : null;

  const canSubmit =
    Boolean(providerId) &&
    Boolean(connectionId) &&
    Boolean(keyExternalKey) &&
    (mapping.get(keyExternalKey)?.kind ?? 'skip') !== 'skip' &&
    !configError &&
    // #341 — when the channel picker is active a channel MUST be chosen; in the
    // free-text fallback channel_id stays optional (backend defaults to the
    // account's own channel), so it doesn't block.
    (!channelPickerActive || Boolean(config['channel_id']));

  const encodedDestination = (item: (typeof catalog)[number]) => {
    const dest = mapping.get(item.key) ?? { kind: 'skip' as const };
    if (dest.kind === 'skip') return 'skip';
    if (dest.kind === 'existing') return `existing:${dest.field_id}`;
    return `new:${dest.type}`;
  };

  if (step === 'runs' && runsFor) {
    return (
      <DialogContent title={`Runs — "${runsFor.name}"`} className="max-w-xl">
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1">
          {(runs.data ?? []).length === 0 && <p className="text-[13px] text-muted">No syncs yet.</p>}
          {(runs.data ?? []).map((r) => (
            <div key={r.id} className="rounded-[var(--radius-card)] border border-border-default px-3 py-2 text-[13px]">
              <div className="flex items-center justify-between">
                <span className={cn('font-medium', r.status === 'ok' ? 'text-ink' : 'text-error')}>
                  {r.status === 'skipped_quota'
                    ? 'skipped (quota)'
                    : r.status === 'skipped_cap'
                      ? 'skipped (monthly cap)'
                      : r.status}
                </span>
                <span className="text-[11px] text-faint">{fmt.dateTime(r.started_at)}</span>
              </div>
              <p className="mt-0.5 text-[12px] text-muted">
                fetched {r.fetched} · created {r.created} · updated {r.updated}
                {typeof r.stats?.['compute_units'] === 'number' && ` · ${r.stats['compute_units']} compute units`}
              </p>
              {r.error && <p className="mt-0.5 text-[12px] text-error">{r.error}</p>}
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={() => setStep('list')}>
            Back
          </Button>
        </div>
      </DialogContent>
    );
  }

  if (step === 'new') {
    return (
      <DialogContent title={`Sync from… "${database.data?.name ?? ''}"`} className="max-w-2xl">
        <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-1.5">
            <Label>Provider</Label>
            <select
              className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              value={providerId}
              onChange={(e) => selectProvider(e.target.value)}
            >
              <option value="">Choose a provider…</option>
              {(providers.data ?? []).map((p) => {
                // #347 — a provider whose connection isn't connectable on this
                // deployment is shown but not selectable, with the reason inline.
                const present = availabilityOf(p);
                return (
                  <option key={p.id} value={p.id} disabled={!present.actionable}>
                    {p.label}
                    {present.actionable ? '' : ` — ${present.label}`}
                  </option>
                );
              })}
              {/* #339 — Calendar is discoverable here even though its two-way
                  sync lives in the Integrations wizard. Honors availability
                  (google-calendar is Tier B oauth_managed) like any provider. */}
              <optgroup label="Two-way sync">
                <option value={CALENDAR_POINTER_ID} disabled={!calendarPresent.actionable}>
                  Google Calendar
                  {calendarPresent.actionable ? '' : ` — ${calendarPresent.label}`}
                </option>
              </optgroup>
            </select>
          </div>

          {/* #339 — selecting Calendar hands off to the dedicated integration
              rather than duplicating (and risking conflicting with) its binding
              flow on the same database. */}
          {providerId === CALENDAR_POINTER_ID && (
            <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-accent-soft px-4 py-3">
              <div className="flex items-start gap-2">
                <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-ink" />
                <p className="text-[13px] text-ink">
                  Google Calendar syncs two ways — StoryOS records ↔ calendar events — so it&apos;s set
                  up in the Calendar integration, where you pick the calendar and map your date fields.
                </p>
              </div>
              {calendarPresent.actionable ? (
                <Link
                  href={`/w/${ws}/settings/integrations/google-calendar`}
                  className="inline-flex h-8 w-fit items-center rounded-[var(--radius-control)] bg-primary px-3 text-[13px] font-medium text-[var(--text-on-dark)] hover:bg-primary-hover"
                  onClick={onDone}
                >
                  Open Calendar integration →
                </Link>
              ) : (
                <p className="text-[12px] text-muted">{calendarPresent.description}</p>
              )}
            </div>
          )}

          {/* #347 — when the picked provider is gated, explain the honest state
              (upsell / admin-configured) instead of showing config + a dead
              connection dropdown. */}
          {provider &&
            (() => {
              const present = availabilityOf(provider);
              if (present.actionable) return null;
              return (
                <p
                  className={cn(
                    'rounded-[var(--radius-card)] border px-3 py-2 text-[12px]',
                    present.state === 'cloud_only'
                      ? 'border-border-default bg-accent-soft text-ink'
                      : 'border-border-default bg-card text-muted',
                  )}
                >
                  <span className="font-medium">{present.label}.</span> {present.description}
                </p>
              );
            })()}

          {provider?.description && (
            <p className="rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2 text-[12px] text-muted">
              {provider.description}
            </p>
          )}

          {provider && (
            <div className="flex flex-col gap-1.5">
              <Label>Connection</Label>
              {eligibleConnections.length === 0 ? (
                <p className="text-[12px] text-error">
                  No {provider?.connection_provider} connection yet — add one under Settings → Connections first.
                </p>
              ) : (
                <select
                  className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                  value={connectionId}
                  onChange={(e) => {
                    setConnectionId(e.target.value);
                    // #341 — channels are per-connection; drop a stale pick.
                    setConfig((prev) => {
                      if (!('channel_id' in prev)) return prev;
                      const next = { ...prev };
                      delete next['channel_id'];
                      return next;
                    });
                  }}
                >
                  <option value="">Choose a connection…</option>
                  {eligibleConnections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {provider && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="src-name">Name</Label>
              <Input
                id="src-name"
                placeholder={provider?.label}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          {provider &&
            Object.entries(provider?.config_schema ?? {}).map(([key, spec]) => (
              <div key={key} className="flex flex-col gap-1.5">
                {key === 'channel_id' && providerHasChannelPicker ? (
                  // #341 — required channel picker (by name) instead of a raw,
                  // unreliable free-text id. Falls back to a free-text field
                  // only when the account's channels can't be listed.
                  <>
                    <Label htmlFor="src-config-channel_id">Channel</Label>
                    {!connectionId ? (
                      <select
                        id="src-config-channel_id"
                        disabled
                        className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-muted"
                      >
                        <option>Choose a connection first…</option>
                      </select>
                    ) : channels.isLoading ? (
                      <select
                        id="src-config-channel_id"
                        disabled
                        className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-muted"
                      >
                        <option>Loading your channels…</option>
                      </select>
                    ) : channelFallback ? (
                      <>
                        <Input
                          id="src-config-channel_id"
                          type="text"
                          placeholder="Channel id (e.g. UC…)"
                          value={config['channel_id'] ?? ''}
                          onChange={(e) => setConfig((prev) => ({ ...prev, channel_id: e.target.value }))}
                        />
                        <p className="text-[11px] text-faint">
                          {channels.isError
                            ? "Couldn't list this account's channels — enter a channel id manually."
                            : 'This account has no channels — enter a channel id manually.'}
                        </p>
                      </>
                    ) : (
                      <select
                        id="src-config-channel_id"
                        className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                        value={config['channel_id'] ?? ''}
                        onChange={(e) => setConfig((prev) => ({ ...prev, channel_id: e.target.value }))}
                      >
                        <option value="">Choose a channel…</option>
                        {(channels.data ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                ) : spec.kind === 'boolean' ? (
                  <label className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={config[key] === 'true'}
                      onChange={(e) => setConfig((prev) => ({ ...prev, [key]: e.target.checked ? 'true' : 'false' }))}
                    />
                    {configFieldLabel(key)}
                    {spec.description ? <span className="text-[11px] text-faint">— {spec.description}</span> : null}
                  </label>
                ) : (
                  <>
                    {/* #113 — human label, not the raw snake_case key. */}
                    <Label htmlFor={`src-config-${key}`}>
                      {configFieldLabel(key)}
                      {spec.required ? '' : ' (optional)'}
                    </Label>
                    {spec.kind === 'json' ? (
                      <textarea
                        id={`src-config-${key}`}
                        rows={4}
                        placeholder={spec.description ? `${spec.description} (JSON)` : '{}'}
                        className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5 font-mono text-[12px] text-ink"
                        value={config[key] ?? ''}
                        onChange={(e) => setConfig((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    ) : spec.kind === 'array' ? (
                      // #113 — list-shaped fields (e.g. LinkedIn post_urns) get a
                      // per-line box instead of a brittle comma free-text input.
                      <textarea
                        id={`src-config-${key}`}
                        rows={4}
                        placeholder={'One per line' + (spec.description ? ` — ${spec.description}` : '')}
                        className="rounded-[var(--radius-control)] border border-border-default bg-card px-2 py-1.5 font-mono text-[12px] text-ink"
                        value={config[key] ?? ''}
                        onChange={(e) => setConfig((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    ) : (
                      <Input
                        id={`src-config-${key}`}
                        type={spec.kind === 'number' ? 'number' : 'text'}
                        placeholder={spec.description ?? undefined}
                        value={config[key] ?? ''}
                        onChange={(e) => setConfig((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    )}
                    {/* #113 — always-visible help text, plus a per-field validation
                        error when the current value is malformed. */}
                    {(() => {
                      const err = validateConfigField(providerId, key, config[key] ?? '');
                      if (err) return <p className="text-[11px] text-error">{err}</p>;
                      if (spec.kind === 'array' || (spec.description && spec.kind !== 'json'))
                        return spec.description ? (
                          <p className="text-[11px] text-faint">{spec.description}</p>
                        ) : null;
                      return null;
                    })()}
                  </>
                )}
              </div>
            ))}

          {providerId && provider?.supports_discover && (
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!connectionId || discoverFields.isPending}
                onClick={() => discoverFields.mutate()}
              >
                {discoverFields.isPending ? 'Discovering…' : 'Discover fields'}
              </Button>
              <p className="text-[11px] text-faint">
                Runs the actor once (or reads its last successful run) to read a sample item's keys, so mapping is
                point-and-click instead of reading the actor's docs.
              </p>
            </div>
          )}

          {provider && (
            <div className="flex flex-col gap-1.5">
              <Label>Schedule</Label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-8 w-40 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                  value={recurrenceForm.kind}
                  onChange={(e) =>
                    setRecurrenceForm((prev) => ({ ...prev, kind: e.target.value as RecurrenceKind }))
                  }
                >
                  {(Object.keys(REPEAT_LABELS) as RecurrenceKind[]).map((k) => (
                    <option key={k} value={k}>
                      {REPEAT_LABELS[k]}
                    </option>
                  ))}
                </select>

                {recurrenceForm.kind === 'weekly' && (
                  <select
                    aria-label="Day of week"
                    className="h-8 w-36 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                    value={recurrenceForm.weekday}
                    onChange={(e) =>
                      setRecurrenceForm((prev) => ({ ...prev, weekday: Number(e.target.value) }))
                    }
                  >
                    {WEEKDAY_LABELS.map((label, i) => (
                      <option key={label} value={i}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}

                {(recurrenceForm.kind === 'daily' || recurrenceForm.kind === 'weekly') && (
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    at
                    <input
                      type="time"
                      aria-label="Time of day"
                      className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={recurrenceForm.timeOfDay}
                      onChange={(e) =>
                        setRecurrenceForm((prev) => ({ ...prev, timeOfDay: e.target.value }))
                      }
                    />
                    UTC
                  </label>
                )}

                {recurrenceForm.kind === 'hourly' && (
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    at minute
                    <input
                      type="number"
                      min={0}
                      max={59}
                      aria-label="Minute past the hour"
                      className="h-8 w-20 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={recurrenceForm.minute}
                      onChange={(e) =>
                        setRecurrenceForm((prev) => ({ ...prev, minute: Number(e.target.value) }))
                      }
                    />
                  </label>
                )}
              </div>
              <p className="text-[11px] text-faint">
                Runs once per slot at the chosen wall-clock time — daily keeps well under API quotas.
              </p>
            </div>
          )}

          {providerId && catalog.length > 0 && (
            <>
              <p className="text-[13px] text-muted">
                Map each field this source will write. Pick which one is the external key (used to update the
                same record instead of duplicating it).
              </p>
              <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default">
                {catalog.map((item) => (
                  <div key={item.key} className="flex items-center gap-3 border-b border-border-default px-3 py-2 last:border-b-0">
                    <label className="flex items-center gap-1.5 text-[12px] text-muted" title="External key">
                      <input
                        type="radio"
                        name="external-key"
                        checked={keyExternalKey === item.key}
                        disabled={(mapping.get(item.key)?.kind ?? 'skip') === 'skip'}
                        onChange={() => setKeyExternalKey(item.key)}
                      />
                      key
                    </label>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-ink">{item.label}</p>
                      <p className="truncate text-[11px] text-faint">{item.key}</p>
                    </div>
                    <select
                      className="h-8 w-56 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                      value={encodedDestination(item)}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = new Map(mapping);
                        if (v === 'skip') next.set(item.key, { kind: 'skip' });
                        else if (v.startsWith('existing:')) next.set(item.key, { kind: 'existing', field_id: v.slice(9) });
                        else next.set(item.key, { kind: 'new', type: v.slice(4) });
                        setMapping(next);
                        if (v === 'skip' && keyExternalKey === item.key) setKeyExternalKey('');
                      }}
                    >
                      <option value={`new:${item.suggestedType}`}>＋ New {item.suggestedType} field</option>
                      {existingFields.length > 0 && (
                        <optgroup label="Existing field">
                          {existingFields.map((f) => (
                            <option key={f.id} value={`existing:${f.id}`}>
                              {f.displayName}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <option value="skip">Don&apos;t import</option>
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="mt-4 flex justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              resetWizard();
              setStep('list');
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || createSource.isPending || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await createSource.mutateAsync();
              } finally {
                setBusy(false);
              }
            }}
          >
            {createSource.isPending || busy ? 'Creating…' : 'Create source'}
          </Button>
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent title={`Sync from… "${database.data?.name ?? ''}"`} className="max-w-2xl">
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1">
        <p className="text-[13px] text-muted">
          A source is a scheduled sync — external items land as ordinary records, upserted by an external key.
        </p>
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default">
          {(sources.data ?? []).length === 0 && (
            <p className="px-4 py-6 text-[13px] text-muted">No sources yet — add one below.</p>
          )}
          {(sources.data ?? []).map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 border-b border-border-default px-3 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">{s.name}</p>
                <p className="mt-0.5 truncate text-[11px] text-faint">
                  {s.provider_source} · {describeRecurrence(s.recurrence, s.schedule)} ·{' '}
                  <span className={s.status === 'error' ? 'text-error' : undefined}>{STATUS_LABEL[s.status]}</span>
                  {s.last_sync_at ? ` · last synced ${fmt.dateTime(s.last_sync_at)}` : ' · never synced'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => syncNow.mutate(s.id)} disabled={syncNow.isPending}>
                  Sync now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRunsFor(s);
                    setStep('runs');
                  }}
                >
                  Runs
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: 'Delete this source?',
                        message: `"${s.name}" will stop syncing. Every record it already created stays exactly as-is.`,
                        confirmLabel: 'Delete',
                        danger: true,
                      }))
                    )
                      return;
                    removeSource.mutate(s.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 flex justify-between gap-2">
        <Button variant="secondary" onClick={onDone}>
          Close
        </Button>
        <Button onClick={() => setStep('new')}>+ New source</Button>
      </div>
    </DialogContent>
  );
}
