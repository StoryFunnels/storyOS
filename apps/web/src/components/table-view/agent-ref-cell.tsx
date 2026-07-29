'use client';

import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useDatabases, useSpaces } from '@/lib/queries';
import {
  AGENT_DATABASE_REF_FIELDS,
  resolveDatabaseId,
  resolveDatabaseIds,
  resolveFieldLabel,
  resolveOptionLabel,
  type RefField,
} from '@/lib/database-labels';
import type { DatabaseDetail, Field } from './use-table-data';

/**
 * #317 (residual): the agent-config text fields (`target_databases`,
 * `database`, `state_field`, `state_option`) store bare entity UUIDs. The #183
 * fix only rewrote the record side-panel's `target_databases`; every other
 * generic surface (table cells, other panels) still showed raw ids. This is the
 * one shared, read-only resolver those surfaces route through: it turns the ids
 * into human labels — "Space / Database" for database refs, field name for
 * `state_field`, option label for `state_option` — and, crucially, never falls
 * back to a bare UUID. A deleted/inaccessible target renders an explicit
 * "Unavailable" chip instead.
 *
 * Overlaps UX #148 (stop leaking ids/slugs generally); this covers the
 * agent-config portion only.
 */

/** One resolved reference as a chip; `missing` styles it as an error. */
function RefChip({ label, missing }: { label: string; missing: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center truncate rounded border px-1.5 py-0.5 text-[12px]',
        missing
          ? 'border-error/40 bg-error/5 text-error'
          : 'border-border-default bg-hover text-ink',
      )}
      title={
        missing
          ? 'This reference is unavailable — the target may have been deleted or is not accessible.'
          : label
      }
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Muted placeholder while the resolving queries are in flight. */
function RefLoading() {
  return <span className="text-[13px] text-faint">…</span>;
}

/**
 * Every field (with its options) across the workspace, so a bare `state_field`
 * or `state_option` id can be resolved without needing the sibling `database`
 * value the generic cell can't reach. Field/option ids are globally unique
 * UUIDs, so a flat search is unambiguous. Keyed to match `useDatabase` so the
 * per-database schema fetches share its cache; only fires when actually
 * rendering a field/option ref (`enabled`).
 */
function useWorkspaceFields(ws: string, enabled: boolean): { fields: RefField[]; loading: boolean } {
  const databases = useDatabases(ws, enabled);
  const ids = (databases.data ?? []).map((d) => d.id);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['database', ws, id],
      queryFn: async () => {
        const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}', {
          params: { path: { ws, db: id } },
        });
        if (error) throw error;
        return data as unknown as DatabaseDetail;
      },
      enabled: enabled && Boolean(ws && id),
    })),
  });
  const fields = results.flatMap((r) => (r.data?.fields ?? []) as unknown as RefField[]);
  const loading =
    (enabled && databases.isLoading) || results.some((r) => r.isLoading && r.fetchStatus !== 'idle');
  return { fields, loading };
}

/**
 * Read-only display for an agent-config entity-id field. Callers gate on
 * `isAgentConfigRefValue(field.apiName, value)` so only genuine id payloads
 * reach here (a user's own text field named "database" holding non-UUID text
 * is never rewritten).
 */
export function AgentRefCell({ field, value, ws }: { field: Field; value: unknown; ws?: string }) {
  const enabled = Boolean(ws);
  const isDbRef = AGENT_DATABASE_REF_FIELDS.has(field.apiName);

  const databases = useDatabases(ws ?? '', enabled && isDbRef);
  const spaces = useSpaces(ws ?? '', enabled && isDbRef);
  const workspace = useWorkspaceFields(ws ?? '', enabled && !isDbRef);

  if (isDbRef) {
    const dbList = databases.data ?? [];
    const spaceList = spaces.data ?? [];
    if (enabled && (databases.isLoading || spaces.isLoading)) return <RefLoading />;

    if (field.apiName === 'target_databases') {
      const targets = resolveDatabaseIds(value, dbList, spaceList);
      if (targets.length === 0) return <span className="text-faint"> </span>;
      return (
        <span className="flex flex-wrap gap-1 overflow-hidden">
          {targets.map((t) => (
            <RefChip key={t.id} label={t.label} missing={t.missing} />
          ))}
        </span>
      );
    }
    // Single database id (`database`).
    const resolved = resolveDatabaseId(String(value), dbList, spaceList);
    return <RefChip label={resolved.label} missing={resolved.missing} />;
  }

  // Field / option ref (`state_field`, `state_option`).
  if (workspace.loading) return <RefLoading />;
  const resolved =
    field.apiName === 'state_field'
      ? resolveFieldLabel(String(value), workspace.fields)
      : resolveOptionLabel(String(value), workspace.fields);
  return <RefChip label={resolved.label} missing={resolved.missing} />;
}
