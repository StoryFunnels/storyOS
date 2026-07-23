'use client';

import { useState } from 'react';
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

interface SourceSummary {
  id: string;
  name: string;
  connection_id: string | null;
  provider_source: string;
  config: Record<string, unknown>;
  field_mapping: Record<string, string>;
  external_key_field_id: string;
  schedule: '15m' | 'hour' | 'day';
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

/**
 * #239 — the mapping catalog every YouTube provider emits, since none of them
 * implement `discover()` yet (v1 scope: known-ahead-of-time providers only).
 * MN-261/MN-262 add their own entries here when they register new providers.
 */
const PROVIDER_FIELD_CATALOG: Record<
  string,
  Array<{ key: string; label: string; suggestedType: string; isKey?: boolean }>
> = {
  'youtube.videos': [
    { key: 'video_id', label: 'Video ID', suggestedType: 'text', isKey: true },
    { key: 'title', label: 'Title', suggestedType: 'text' },
    { key: 'published_at', label: 'Published at', suggestedType: 'text' },
    { key: 'duration', label: 'Duration', suggestedType: 'text' },
    { key: 'privacy', label: 'Privacy', suggestedType: 'text' },
    { key: 'url', label: 'URL', suggestedType: 'url' },
  ],
  'youtube.comments': [
    { key: 'comment_id', label: 'Comment ID', suggestedType: 'text', isKey: true },
    { key: 'video_id', label: 'Video ID', suggestedType: 'text' },
    { key: 'author_name', label: 'Author', suggestedType: 'text' },
    { key: 'text', label: 'Text', suggestedType: 'text' },
    { key: 'like_count', label: 'Likes', suggestedType: 'number' },
    { key: 'published_at', label: 'Published at', suggestedType: 'text' },
    { key: 'is_reply', label: 'Is reply', suggestedType: 'checkbox' },
    { key: 'permalink', label: 'Permalink', suggestedType: 'url' },
  ],
  'youtube.metrics': [
    { key: 'snapshot_id', label: 'Snapshot ID', suggestedType: 'text', isKey: true },
    { key: 'video_id', label: 'Video ID', suggestedType: 'text' },
    { key: 'date', label: 'Date', suggestedType: 'text' },
    { key: 'views', label: 'Views', suggestedType: 'number' },
    { key: 'likes', label: 'Likes', suggestedType: 'number' },
    { key: 'comments', label: 'Comments', suggestedType: 'number' },
  ],
};

const SCHEDULE_LABEL: Record<string, string> = { '15m': 'Every 15 minutes', hour: 'Hourly', day: 'Daily' };
const STATUS_LABEL: Record<string, string> = { active: 'Active', paused: 'Paused', error: 'Error' };

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

  const [step, setStep] = useState<'list' | 'new' | 'runs'>('list');
  const [runsFor, setRunsFor] = useState<SourceSummary | null>(null);

  // --- new-source wizard state ---
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<'15m' | 'hour' | 'day'>('15m');
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
  const existingFields = (database.data?.fields ?? []).filter(
    (f) => !f.isSystem && !['title', 'lookup', 'button', 'relation', 'created_at', 'updated_at', 'created_by'].includes(f.type),
  );

  function applyCatalog(cat: Array<{ key: string; label: string; suggestedType: string; isKey?: boolean }>) {
    const initial = new Map<string, MappingDestination>();
    cat.forEach((c) => initial.set(c.key, { kind: 'new', type: c.suggestedType }));
    setMapping(initial);
    setKeyExternalKey(cat.find((c) => c.isKey)?.key ?? cat[0]?.key ?? '');
  }

  function resetWizard() {
    setName('');
    setProviderId('');
    setConnectionId('');
    setConfig({});
    setSchedule('15m');
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
      } else if (kind === 'array') parsed[key] = raw.split(',').map((v) => v.trim()).filter(Boolean);
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
          schedule,
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

  const canSubmit =
    Boolean(providerId) &&
    Boolean(connectionId) &&
    Boolean(keyExternalKey) &&
    (mapping.get(keyExternalKey)?.kind ?? 'skip') !== 'skip';

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
              {(providers.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {provider?.description && (
            <p className="rounded-[var(--radius-card)] border border-border-default bg-card px-3 py-2 text-[12px] text-muted">
              {provider.description}
            </p>
          )}

          {providerId && (
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
                  onChange={(e) => setConnectionId(e.target.value)}
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

          {providerId && (
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

          {providerId &&
            Object.entries(provider?.config_schema ?? {}).map(([key, spec]) => (
              <div key={key} className="flex flex-col gap-1.5">
                {spec.kind === 'boolean' ? (
                  <label className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={config[key] === 'true'}
                      onChange={(e) => setConfig((prev) => ({ ...prev, [key]: e.target.checked ? 'true' : 'false' }))}
                    />
                    {key}
                    {spec.description ? <span className="text-[11px] text-faint">— {spec.description}</span> : null}
                  </label>
                ) : (
                  <>
                    <Label htmlFor={`src-config-${key}`}>
                      {key}
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
                    ) : (
                      <Input
                        id={`src-config-${key}`}
                        type={spec.kind === 'number' ? 'number' : 'text'}
                        placeholder={spec.description ?? undefined}
                        value={config[key] ?? ''}
                        onChange={(e) => setConfig((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    )}
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

          {providerId && (
            <div className="flex flex-col gap-1.5">
              <Label>Schedule</Label>
              <select
                className="h-8 w-48 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as '15m' | 'hour' | 'day')}
              >
                {Object.entries(SCHEDULE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
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
                  {s.provider_source} · {SCHEDULE_LABEL[s.schedule] ?? s.schedule} ·{' '}
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
