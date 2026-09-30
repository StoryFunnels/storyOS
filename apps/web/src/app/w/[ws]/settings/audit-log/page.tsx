'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { useDateFormat } from '@/lib/preferences';
import { useMembers } from '@/components/table-view/use-table-data';

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

/**
 * #727 — the web half of #454's admin audit-log API, which had none. Mirrors
 * the endpoint's own filters (actor/entity/date range) and cursor pagination
 * exactly; no client-side re-derivation of "what happened" — this reads and
 * renders the server's merged event/field-change feed as-is.
 */
export default function AuditLogPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const role = (workspace.data as { role?: string } | undefined)?.role;
  const isAdmin = role === 'admin';
  const { dateTime } = useDateFormat();

  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const members = useMembers(ws, isAdmin);

  const filters = useMemo(
    () => ({
      ...(actor ? { actor } : {}),
      ...(entity ? { entity } : {}),
      ...(from ? { from: new Date(from).toISOString() } : {}),
      ...(to ? { to: new Date(to).toISOString() } : {}),
    }),
    [actor, entity, from, to],
  );

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
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <h1 className="mb-1 text-lg font-semibold text-ink">Audit log</h1>
        <p className="text-body text-muted">Only workspace admins can view the audit log.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Audit log</h1>
      <p className="mb-2 text-body text-muted">
        Who changed or deleted what, and when — across the whole workspace.
      </p>
      {/* #454's own stated gap (its service doc comment): deleting a database,
          view, or space isn't captured here yet, only record-level activity. */}
      <p className="mb-6 text-label text-faint">
        This does not yet capture who deleted a database, view, or space — only record creation,
        edits, and deletion.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-label text-ink-secondary">
          Actor
          <select
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-body text-ink"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          >
            <option value="">Everyone</option>
            {(members.data ?? []).map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-secondary">
          Record ID
          <input
            className="h-8 w-64 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-body text-ink"
            placeholder="Filter to one record…"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-secondary">
          From
          <input
            type="date"
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-body text-ink"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-secondary">
          To
          <input
            type="date"
            className="h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-body text-ink"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>

      {log.isLoading ? (
        <p className="text-body text-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-body text-muted">Nothing in this range.</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default">
          {entries.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 border-b border-border-default px-3 py-2 last:border-b-0"
            >
              <span className="w-36 shrink-0 text-label text-faint">{dateTime(e.created_at)}</span>
              <span className="w-32 shrink-0 truncate text-body text-ink">
                {e.actor_name ?? '(unknown)'}
              </span>
              <span className="rounded bg-hover px-1.5 py-0.5 text-meta text-faint">{e.source}</span>
              <span className="min-w-0 flex-1 truncate text-body text-ink-secondary" title={e.record_id ?? undefined}>
                {e.kind === 'event' ? (
                  <>
                    {e.type} · record {e.record_id ? e.record_id.slice(0, 8) : '—'}
                  </>
                ) : (
                  <>
                    <span className="font-medium text-ink">{e.field}</span>
                    {' — '}
                    {renderValue(e.old_value)} → {renderValue(e.new_value)}
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {log.hasNextPage && (
        <button
          className="mt-3 rounded px-2 py-1 text-body text-info hover:bg-hover"
          onClick={() => void log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
