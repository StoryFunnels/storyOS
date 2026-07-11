'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus } from 'lucide-react';
import { recordHref } from '@/lib/records';
import { cn } from '@/lib/utils';
import { OPTION_COLORS } from '../table-view/cells';
import { useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import type { RecordRow } from '../table-view/use-table-data';
import { CardFieldChip } from './board-view';
import type { ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';

const NO_VALUE = '__none__';

/** List view (MN-091): compact rows, optionally grouped by a single-select field
 * with collapsible, counted headers. Denser than a table, lighter than a board. */
export function ListView({
  ws,
  db,
  config,
  readOnly,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  const { createRecord } = useRecordMutations(ws, db);
  const queryBody = useMemo(() => queryBodyFromConfig(config), [config]);
  const records = useRecordsInfinite(ws, db, queryBody);

  const memberQuery = useMembers(ws, !readOnly);
  const memberNames = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.name])),
    [memberQuery.data],
  );
  const memberImages = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.image])),
    [memberQuery.data],
  );

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  const groupField = database.data?.fields.find((f) => f.id === config.group_by_field_id && f.type === 'select');
  const cardFields = useMemo(
    () =>
      (database.data?.fields ?? []).filter(
        (f) => config.card_field_ids.includes(f.id) && f.id !== groupField?.id,
      ),
    [database.data, config.card_field_ids, groupField?.id],
  );

  const groups = useMemo(() => {
    if (!groupField) return [{ id: NO_VALUE, label: '', color: '', rows }];
    const buckets = new Map<string, RecordRow[]>();
    for (const o of groupField.options ?? []) buckets.set(o.id, []);
    buckets.set(NO_VALUE, []);
    for (const row of rows) {
      const v = (row.values[groupField.apiName] as string | undefined) ?? NO_VALUE;
      (buckets.get(v) ?? buckets.get(NO_VALUE)!).push(row);
    }
    return [
      ...(groupField.options ?? []).map((o) => ({
        id: o.id,
        label: o.label,
        color: OPTION_COLORS[o.color] ?? OPTION_COLORS.gray!,
        rows: buckets.get(o.id)!,
      })),
      { id: NO_VALUE, label: 'No value', color: OPTION_COLORS.gray!, rows: buckets.get(NO_VALUE)! },
    ].filter((g) => g.rows.length > 0 || g.id !== NO_VALUE);
  }, [groupField, rows]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const addIn = (groupId: string) =>
    createRecord.mutate(
      { name: 'Untitled', ...(groupField && groupId !== NO_VALUE ? { [groupField.apiName]: groupId } : {}) },
      { onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`) },
    );

  if (rows.length === 0) return <p className="p-6 text-sm text-faint">No records yet.</p>;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl px-4 py-3">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          return (
            <div key={group.id} className="mb-3">
              {groupField && (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <button className="rounded p-0.5 text-faint hover:bg-hover hover:text-ink" onClick={() => toggle(group.id)}>
                    <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                  </button>
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: group.color }} />
                  <span className="text-[12px] font-medium text-ink">{group.label}</span>
                  <span className="text-[11px] text-faint">{group.rows.length}</span>
                </div>
              )}
              {!isCollapsed && (
                <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
                  {group.rows.map((row) => (
                    <div
                      key={row.id}
                      onClick={() => router.push(recordHref(ws, db, row))}
                      className="flex cursor-pointer items-center gap-3 border-b border-border-default px-3 py-2 last:border-b-0 hover:bg-hover"
                    >
                      {row.number !== null && <span className="w-8 shrink-0 text-[11px] tabular-nums text-faint">{row.number}</span>}
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{row.title || 'Untitled'}</span>
                      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                        {cardFields.map((field) => {
                          const value = row.values[field.apiName];
                          if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
                          return (
                            <CardFieldChip key={field.id} field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
                          );
                        })}
                      </span>
                    </div>
                  ))}
                  {!readOnly && (
                    <button
                      onClick={() => addIn(group.id)}
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] text-muted hover:bg-hover hover:text-ink"
                    >
                      <Plus className="h-3.5 w-3.5" /> New
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {records.hasNextPage && (
          <button
            className="rounded px-2 py-1 text-[13px] text-info hover:bg-hover"
            onClick={() => void records.fetchNextPage()}
            disabled={records.isFetchingNextPage}
          >
            {records.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
