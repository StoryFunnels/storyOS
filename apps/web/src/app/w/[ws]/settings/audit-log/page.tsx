'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { useDateFormat } from '@/lib/preferences';
import { useMembers } from '@/components/table-view/use-table-data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MenuSelect } from '@/components/ui/menu-select';
import { AdvancedSection, SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRefusal } from '@/components/settings/settings-chrome';
import { AUDIT_TYPE_FILTERS, describeStructuralEvent } from '@/lib/audit-events';
import { EMPTY_AUDIT_FILTERS, auditFilterSummary, resolveAuditFilters } from '@/lib/audit-filters';
import { canOpenAdminSettings } from '@/lib/settings-nav';

interface AuditLogEntry {
  kind: 'event' | 'field_change';
  id: string;
  record_id: string | null;
  /** Present on kind: 'event' only. */
  type?: string;
  /** Present on kind: 'field_change' only. */
  field?: string;
  actor_id: string | null;
  actor_name: string | null;
  source: string;
  payload?: unknown;
  old_value?: unknown;
  new_value?: unknown;
  created_at: string;
}

interface AuditLogPage {
  data: AuditLogEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The Settings pages' field label: the prototype's 12px semibold, one step under the field it labels (#974 design). */
const FIELD_LABEL = 'text-label font-semibold';

/**
 * #727 — the web half of #454's admin audit-log API, which had none. Mirrors
 * the endpoint's own filters (actor/entity/date range) and cursor pagination
 * exactly; no client-side re-derivation of "what happened" — this reads and
 * renders the server's merged event/field-change feed as-is.
 *
 * Ticket #1189 (Dara's #974 design): the log is the page; the filters are power controls and sit under a labelled "Filter"
 * disclosure (the shared Advanced), closed by default. The closed summary says how many are applied, so a short log is never a
 * mystery. Settings has no native selects or date inputs (ticket #1191), so the two choices are the product's own menu and the
 * dates are typed text (`lib/audit-filters.ts`).
 */
export default function AuditLogPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const role = (workspace.data as { role?: string } | undefined)?.role;
  const isAdmin = canOpenAdminSettings(role);
  const { dateTime } = useDateFormat();

  const [input, setInput] = useState(EMPTY_AUDIT_FILTERS);
  const set = (patch: Partial<typeof EMPTY_AUDIT_FILTERS>) => setInput((cur) => ({ ...cur, ...patch }));

  const members = useMembers(ws, isAdmin);

  const resolved = useMemo(() => resolveAuditFilters(input), [input]);
  const filters = resolved.query;

  const log = useInfiniteQuery({
    queryKey: ['audit-log', ws, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/audit-log', {
        params: { path: { ws }, query: { ...filters, ...(pageParam ? { cursor: pageParam } : {}) } } as never,
      } as never);
      if (error) throw error;
      return data as unknown as AuditLogPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: isAdmin,
  });

  const entries = (log.data?.pages ?? []).flatMap((p) => p.data);

  if (workspace.isLoading) return <p className="p-8 text-body text-muted">Loading…</p>;

  if (!isAdmin) {
    return (
      <SettingsRefusal title="Audit log">Only workspace admins can view the audit log.</SettingsRefusal>
    );
  }

  const actorOptions = [
    { value: '', label: 'Everyone' },
    ...(members.data ?? []).map((m) => ({ value: m.user.id, label: m.user.name })),
  ];
  const typeOptions = AUDIT_TYPE_FILTERS.map((f) => ({ value: f.value, label: f.label }));

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Audit log" lead="Who did what, people and agents, across the whole workspace" />

      <SettingsPageBody>
        {log.isLoading ? (
          <p className="text-body text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <SettingsBox>
            <p className="px-3.5 py-3 text-body text-muted" data-testid="audit-empty">
              {resolved.applied > 0 ? 'Nothing matches these filters. Open Filter below to change them.' : 'Nothing in this range.'}
            </p>
          </SettingsBox>
        ) : (
          <SettingsBox>
            {entries.map((e) => {
              const structural = e.kind === 'event' ? describeStructuralEvent(e.type, e.payload) : null;
              return (
                <div
                  key={e.id}
                  data-testid="audit-row"
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border-default px-3.5 py-2 first:border-t-0"
                >
                  <span className="shrink-0 text-label text-muted sm:w-36">{dateTime(e.created_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-body text-ink sm:w-32 sm:flex-none sm:shrink-0">
                    {e.actor_name ?? '(unknown)'}
                  </span>
                  <span className="rounded-[var(--radius-chip)] bg-hover px-1.5 py-0.5 text-meta text-ink-secondary">{e.source}</span>
                  <span
                    className={`min-w-0 basis-full text-body text-ink-secondary sm:basis-0 sm:flex-1 ${structural ? 'break-words' : 'truncate'}`}
                  >
                    {structural ? (
                      <>
                        {structural.verb} the {structural.noun} <span className="font-medium text-ink">{structural.name}</span>
                        {structural.suffix}
                        {structural.detail && <span className="text-muted"> · {structural.detail}</span>}
                      </>
                    ) : e.kind === 'event' ? (
                      <>{e.record_id ? e.type : `${e.type} · no record`}</>
                    ) : (
                      <>
                        <span className="font-medium text-ink">{e.field}</span>
                        {' — '}
                        {renderValue(e.old_value)} → {renderValue(e.new_value)}
                      </>
                    )}
                  </span>
                  {/* The full id used to be the row's hover title. It is the value the "Record or object ID" filter takes, so it is written out. */}
                  {e.record_id && (
                    <span className="basis-full break-all font-mono text-meta text-muted" data-testid="audit-record-id">
                      record {e.record_id}
                    </span>
                  )}
                </div>
              );
            })}
          </SettingsBox>
        )}

        {log.hasNextPage && (
          <div>
            <Button variant="secondary" size="sm" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
              {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}

        <AdvancedSection title="Filter" summary={auditFilterSummary(resolved.applied)}>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 px-3.5 py-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Actor</span>
              <MenuSelect
                label="Actor"
                value={input.actor}
                onChange={(v) => set({ actor: v })}
                options={actorOptions}
                className="w-full max-w-none"
                contentClassName="w-64"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Type</span>
              <MenuSelect
                label="Type"
                value={input.type}
                onChange={(v) => set({ type: v })}
                options={typeOptions}
                className="w-full max-w-none"
                contentClassName="w-72"
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="audit-entity" className={FIELD_LABEL}>
                Record or object ID
              </Label>
              <Input
                id="audit-entity"
                size="sm"
                placeholder="One record, space, database or view…"
                value={input.entity}
                onChange={(e) => set({ entity: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audit-from" className={FIELD_LABEL}>
                From
              </Label>
              <Input
                id="audit-from"
                size="sm"
                placeholder="2026-10-27, jul 15, yesterday…"
                value={input.from}
                onChange={(e) => set({ from: e.target.value })}
                aria-invalid={resolved.invalid.includes('from') ? true : undefined}
                aria-describedby="audit-dates-hint"
                className={resolved.invalid.includes('from') ? 'border-error' : undefined}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audit-to" className={FIELD_LABEL}>
                To
              </Label>
              <Input
                id="audit-to"
                size="sm"
                placeholder="2026-10-27, jul 15, today…"
                value={input.to}
                onChange={(e) => set({ to: e.target.value })}
                aria-invalid={resolved.invalid.includes('to') ? true : undefined}
                aria-describedby="audit-dates-hint"
                className={resolved.invalid.includes('to') ? 'border-error' : undefined}
              />
            </div>
            <p id="audit-dates-hint" className={`text-label sm:col-span-2 ${resolved.invalid.length > 0 ? 'text-error' : 'text-muted'}`}>
              {resolved.invalid.length > 0
                ? 'That date is not understood yet, so it is not applied. Try 2026-10-27, 27.10.2026, jul 15, today or yesterday.'
                : 'Type a date as 2026-10-27, 27.10.2026, jul 15, today or yesterday. Leave a box empty for no limit.'}
            </p>
          </div>
        </AdvancedSection>
      </SettingsPageBody>
    </div>
  );
}
