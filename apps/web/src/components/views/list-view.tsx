'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { inferStateCategory, isFinishedStateCategory } from '@storyos/schemas';
import type { StateCategory } from '@storyos/schemas';
import { ArrowDown, ArrowUp, ChevronRight, Plus } from 'lucide-react';
import { recordHref, recordSegment } from '@/lib/records';
import { useOpenRecord } from '@/components/entity/split-panel-context';
import { cn } from '@/lib/utils';
import { FAB_CLEARANCE_PB } from '@/lib/fab-clearance';
import { CellDisplay, OPTION_COLORS, optionColor } from '../table-view/cells';
import { isPercentField } from '../table-view/cell-text';
import { splitCardFields } from './list-fields';
import { pickPrimarySort, sortableFields } from './sort-config';
import { isNumberColumnHidden } from '../table-view/number-column';
import { useAllPages, useDatabase, useMembers, useRecordMutations, useRecordsInfinite } from '../table-view/use-table-data';
import type { Field } from '../table-view/use-table-data';
import type { RecordRow } from '../table-view/use-table-data';
import { CardFieldChip, RecordNumberBadge } from './board-view';
import { EmptyState, databaseNoun } from './empty-state';
import { arrangeBoardColumns } from './board-columns';
import { canGroupListBy } from './groupable-fields';
import { groupCountLabel } from './paginated-count';
import type { FilterNode, ViewConfig } from './use-view-state';
import { queryBodyFromConfig } from './use-view-state';
import { useViewSearch } from './view-search';
import { ViewQueryError } from './query-error';
import { StateGlyph } from './state-glyph';

const NO_VALUE = '__none__';

/* #1115 — the row's fixed slots, shared by the header and every row so the columns line up:
   a trailing value that is a set of chips (labels, linked records) needs room for two or three,
   a figure or a name does not; a leading chip (priority, SF-123) is short; the title takes the rest. */
const slotWidth = (field: Field) => (field.type === 'relation' || field.type === 'multi_select' ? 'w-[200px]' : 'w-[104px]');
const LEAD_SLOT = 'w-16 shrink-0';
const TITLE_SLOT = 'min-w-[120px] flex-1';
const STATE_GLYPH_SIZE = 15;

/** List view (MN-091): compact rows, optionally grouped by a single-select field
 * with collapsible, counted headers. Denser than a table, lighter than a board. */
export function ListView({
  ws,
  db,
  config,
  readOnly,
  personalFilter,
  onPatch,
}: {
  ws: string;
  db: string;
  config: ViewConfig;
  readOnly: boolean;
  /** #259 — narrows this view's results for the current viewer only. */
  personalFilter?: FilterNode;
  /** Lets a column header sort the list (click = ascending, click again = descending). Absent = headers are labels. */
  onPatch?: (updates: Partial<ViewConfig>) => void;
}) {
  const database = useDatabase(ws, db);
  const router = useRouter();
  // #199 — the shared split/navigate decision, identical on every surface.
  const openRecord = useOpenRecord('swap');
  const { createRecord } = useRecordMutations(ws, db);
  const search = useViewSearch(db);
  // #1115 — a grouped list loads every page; the API's largest page halves the round trips.
  const queryBody = useMemo<Record<string, unknown>>(
    () => ({ ...queryBodyFromConfig(config, personalFilter, search), ...(config.group_by_field_id ? { limit: 200 } : {}) }),
    [config, personalFilter, search],
  );
  const records = useRecordsInfinite(ws, db, queryBody);
  useAllPages(records, Boolean(config.group_by_field_id));

  const memberQuery = useMembers(ws, !readOnly);
  const memberNames = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.name])),
    [memberQuery.data],
  );
  // #701 — the SAME decision table-view.tsx already makes via number-column.ts:
  // the permanent record number defaults to hidden (#659) and is opt-in via
  // Fields → Row gutter. This view was rendering `row.number` unconditionally
  // (no hidden-check at all), so the toggle had no effect here — the same
  // "one field, opposite defaults depending on which view type" defect #699's
  // AC1 fixed for `id`.
  const numberHidden = useMemo(() => {
    const real = (database.data?.fields ?? []).find((f) => f.apiName === 'number');
    return isNumberColumnHidden(config.hidden_field_ids, real?.id);
  }, [config.hidden_field_ids, database.data]);
  const memberImages = useMemo(
    () => new Map((memberQuery.data ?? []).map((m) => [m.user.id, m.user.image])),
    [memberQuery.data],
  );

  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((p) => p.data), [records.data]);
  // #272: the SAME predicate the New-view/Group-by picker uses (./groupable-fields),
  // so the renderer and the picker can never disagree about what a List can group by.
  const groupField = database.data?.fields.find(
    (f) => f.id === config.group_by_field_id && canGroupListBy(f),
  );
  const colorField = database.data?.fields.find((f) => f.id === config.color_by_field_id);
  // Preserve the saved card_field_ids order (MN-151), not schema order.
  const cardFields = useMemo(
    () =>
      config.card_field_ids
        .map((id) => (database.data?.fields ?? []).find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => !!f && f.id !== groupField?.id),
    [database.data, config.card_field_ids, groupField?.id],
  );

  const groups = useMemo(() => {
    if (!groupField) return [{ id: NO_VALUE, label: '', color: '', category: null, rows }];
    const buckets = new Map<string, RecordRow[]>();
    for (const o of groupField.options ?? []) buckets.set(o.id, []);
    buckets.set(NO_VALUE, []);
    for (const row of rows) {
      const v = (row.values[groupField.apiName] as string | undefined) ?? NO_VALUE;
      (buckets.get(v) ?? buckets.get(NO_VALUE)!).push(row);
    }
    const columns = [
      ...(groupField.options ?? []).map((o) => ({
        id: o.id,
        label: o.label,
        color: OPTION_COLORS[o.color] ?? OPTION_COLORS.gray!,
        category: o.category ?? null,
        rows: buckets.get(o.id)!,
      })),
      { id: NO_VALUE, label: 'No value', color: OPTION_COLORS.gray!, category: null, rows: buckets.get(NO_VALUE)! },
    ];
    /* #825 — the Groups controls in the toolbar (hide empty groups, hide the
       no-value group, column order) were offered for every GROUPED view,
       including this one, but this renderer never read them: a picker offering
       what its renderer ignores. They now run through the SAME function the
       board uses, so the two views cannot drift (field-surfaces.md). The list's
       own older rule — an EMPTY no-value group is never drawn — is kept. */
    return arrangeBoardColumns(
      columns,
      {
        column_sort: config.column_sort,
        hide_empty_groups: config.hide_empty_groups,
        hide_empty_no_value_group: config.hide_empty_no_value_group,
      },
      { groupType: groupField.type, hasMore: Boolean(records.hasNextPage) },
    ).filter((g) => g.rows.length > 0 || g.id !== NO_VALUE);
  }, [groupField, rows, config.column_sort, config.hide_empty_groups, config.hide_empty_no_value_group, records.hasNextPage]);

  // #1115 — the row's own state: the workflow field, or the first select whose options carry a
  // category. Its glyph sits before the title and colours the row's percent — grouped or not.
  const stateField = useMemo(() => {
    const all = database.data?.fields ?? [];
    return all.find((f) => f.type === 'workflow') ?? all.find((f) => f.type === 'select' && (f.options ?? []).some((o) => o.category));
  }, [database.data]);
  const stateById = useMemo(
    () => new Map((stateField?.options ?? []).map((o) => [o.id, { color: OPTION_COLORS[o.color] ?? OPTION_COLORS.gray!, category: o.category ?? null }])),
    [stateField],
  );
  const rowState = (row: RecordRow, fallback?: { color: string; category: StateCategory | null }) =>
    (stateField && stateById.get(String(row.values[stateField.apiName]))) || fallback;
  const { leading: leadingFields, trailing: trailingFields } = useMemo(() => splitCardFields(cardFields, stateField?.id), [cardFields, stateField?.id]);
  // A percent chip already draws the state glyph beside its figure; drawing it again before the title would be the same state twice in one row.
  const percentField = trailingFields.find(isPercentField);
  const titleField = database.data?.fields.find((f) => f.type === 'title');
  const sortableApi = useMemo(() => new Set(sortableFields(database.data?.fields ?? []).map((f) => f.apiName)), [database.data]);
  const primarySort = config.sorts?.[0];
  // #1115 — a header click is the whole order, as in a spreadsheet: it does not stack on earlier keys (those live in the Sort panel's "Then by").
  const sortBy = (apiName: string) => onPatch?.({ sorts: pickPrimarySort(config.sorts ?? [], apiName, { flipIfSame: true }) });
  const headerCell = (apiName: string | undefined, label: string, className: string) => {
    const canSort = Boolean(onPatch && apiName && sortableApi.has(apiName));
    const active = Boolean(apiName && primarySort?.field === apiName);
    const Arrow = primarySort?.direction === 'desc' ? ArrowDown : ArrowUp;
    if (!canSort) return <span className={className}>{label}</span>;
    return (
      <button
        type="button"
        onClick={() => sortBy(apiName!)}
        className={cn(className, 'group/h inline-flex items-center gap-1 rounded hover:text-ink', active && 'text-ink')}
        title={active ? (primarySort?.direction === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending') : `Sort by ${label}`}
      >
        {label}
        <Arrow className={cn('h-3 w-3 shrink-0', active ? 'opacity-100' : 'opacity-0 group-hover/h:opacity-60')} />
      </button>
    );
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // #1115 — a finished group (done, canceled — by the option's category, whatever its label says,
  // the rule My Work reads) starts collapsed: the list is for what is still moving. Once per
  // grouping; a change of the group field re-arms it, so the next grouping starts folded too.
  const collapsedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!groupField || groups.length === 0 || collapsedFor.current === groupField.id) return;
    collapsedFor.current = groupField.id;
    const finished = groups.filter((g) => g.id !== NO_VALUE && isFinishedStateCategory(g.category ?? inferStateCategory(g.label))).map((g) => g.id);
    setCollapsed(new Set(finished));
  }, [groupField, groups]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addIn = (groupId: string) =>
    createRecord.mutate(
      { name: 'Untitled', ...(groupField && groupId !== NO_VALUE ? { [groupField.apiName]: groupId } : {}) },
      { onSuccess: (created) => router.push(`/w/${ws}/d/${db}/r/${created.id}`) },
    );

  if (rows.length === 0)
    return (
      <EmptyState
        noun={databaseNoun(database.data?.name)}
        onAdd={readOnly ? undefined : () => addIn(NO_VALUE)}
        description={database.data?.description}
      />
    );

  // #346 — a rejected query must never render as an empty view. Placed after every
  // hook so the early return cannot change hook order.
  if (records.isError) return <ViewQueryError error={records.error} onRetry={() => void records.refetch()} />;
  return (
    <div className="h-full overflow-auto">
      {/* #1120 — FAB_CLEARANCE_PB: on a phone the last row (and the "New" row) scrolls clear of the floating + button. */}
      <div className={cn('px-4 pt-2', FAB_CLEARANCE_PB)}>
        {cardFields.length > 0 && (
          /* #1115 — a header names the slots: the same fixed widths as every row below,
             so "Issues" sits over the issue counts, not somewhere near them. A
             sortable column's header sorts the list; the arrow shows the direction. */
          <div className="flex items-center gap-2.5 px-3 pb-1.5 pt-1 text-body text-faint">
            {colorField && <span className="h-2 w-2 shrink-0" />}
            {!numberHidden && <span className="w-8 shrink-0" />}
            {leadingFields.map((field) => (
              <span key={field.id} className={cn(LEAD_SLOT, 'truncate')}>
                {headerCell(field.apiName, field.displayName, 'truncate text-left')}
              </span>
            ))}
            {stateField && !percentField && <span className="shrink-0" style={{ width: STATE_GLYPH_SIZE }} />}
            {headerCell(titleField?.apiName, 'Name', cn(TITLE_SLOT, 'text-left'))}
            {trailingFields.length > 0 && (
              <span className="flex shrink-0 flex-nowrap items-center gap-1">
                {trailingFields.map((field) => (
                  <span key={field.id} className={cn(slotWidth(field), 'flex shrink-0 justify-end truncate')}>
                    {headerCell(field.apiName, field.displayName, 'truncate text-right')}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          const groupStatus = groupField ? { color: group.color, category: group.category } : undefined;
          return (
            <div key={group.id} className="mb-3">
              {groupField && (
                <div className="flex items-center gap-2 rounded-[var(--radius-card)] bg-hover px-2 py-1.5">
                  <button className="rounded p-0.5 text-faint hover:bg-card hover:text-ink" onClick={() => toggle(group.id)}>
                    <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                  </button>
                  {group.category ? (
                    <StateGlyph category={group.category} color={group.color} size={STATE_GLYPH_SIZE} />
                  ) : (
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.color }} />
                  )}
                  <span className="text-title font-medium text-ink">{group.label}</span>
                  {/* #755 — while more pages remain unloaded (records.hasNextPage),
                      this group's row count is only a lower bound: Will Not Do read
                      4 and held 63 on storyos/issues (740 records, page size 100).
                      Same shared rule list-view.tsx and board-view.tsx both read. */}
                  <span className="text-body text-faint">
                    {groupCountLabel(group.rows.length, Boolean(records.hasNextPage))}
                  </span>
                  <span className="flex-1" />
                  {!readOnly && (
                    <button
                      onClick={() => addIn(group.id)}
                      aria-label={`New in ${group.label}`}
                      className="rounded p-0.5 text-faint hover:bg-card hover:text-ink"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              {!isCollapsed && (
                <div>
                  {group.rows.map((row, i) => {
                    const dot = colorField ? optionColor(colorField, row.values[colorField.apiName]) : null;
                    const status = rowState(row, groupStatus);
                    return (
                    <div
                      key={row.id}
                      onClick={(e) =>
                        openRecord(
                          { db, rec: recordSegment(row), title: row.title, number: row.number },
                          e,
                          () => router.push(recordHref(ws, db, row)),
                        )
                      }
                      /* #1115 — the hover tint is a band of the same shape and extent as the group header; the
                         separator sits inside it, inset, so no line runs under a rounded corner. */
                      className="cursor-pointer rounded-[var(--radius-card)] hover:bg-hover-soft"
                    >
                    <div className={cn('mx-2 flex h-11 items-center gap-2.5 px-1', i < group.rows.length - 1 && 'border-b border-border-default')}>
                      {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />}
                      {row.number !== null && !numberHidden && <RecordNumberBadge number={row.number} className="w-8 shrink-0 text-body" />}
                      {/* #1115 — fixed slots, so the glyph and the title start on the same x in every row. */}
                      {leadingFields.map((field) => {
                        const value = row.values[field.apiName];
                        const empty = value === undefined || value === null || value === '';
                        return (
                          <span key={field.id} className={cn(LEAD_SLOT, 'flex items-center overflow-hidden')}>
                            {!empty &&
                              (field.type === 'text' ? (
                                <span className="truncate text-body tabular-nums text-muted">{String(value)}</span>
                              ) : (
                                <CellDisplay field={field} value={value} memberNames={memberNames} memberImages={memberImages} />
                              ))}
                          </span>
                        );
                      })}
                      {status && stateField && !percentField && <StateGlyph category={status.category} color={status.color} size={STATE_GLYPH_SIZE} />}
                      {/* #787 (List artifact L3) — a floor the fields cannot push through.
                          The title is the reason a list exists; before this, an unbounded
                          shrink-0 chip row could squeeze it to near-nothing. */}
                      <span className={cn(TITLE_SLOT, 'truncate text-title text-ink')}>{row.title || 'Untitled'}</span>
                      {/* #787 (List artifact L2) — FIXED slots, not a wrapping row: each
                          configured field gets the same width in the same order on every
                          row, and an empty value leaves its slot empty rather than
                          collapsing it. That's what makes the column scannable; before
                          this, empty values were skipped entirely, so which field landed
                          in which visual position drifted row to row. */}
                      {trailingFields.length > 0 && (
                        <span className="flex shrink-0 flex-nowrap items-center gap-1">
                          {trailingFields.map((field) => {
                            const value = row.values[field.apiName];
                            const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
                            return (
                              <span key={field.id} className={cn('flex shrink-0 justify-end overflow-hidden', slotWidth(field))}>
                                {!empty && (
                                  <CardFieldChip
                                    field={field}
                                    value={value}
                                    memberNames={memberNames}
                                    memberImages={memberImages}
                                    status={status}
                                  />
                                )}
                              </span>
                            );
                          })}
                        </span>
                      )}
                    </div>
                    </div>
                    );
                  })}
                  {!groupField && !readOnly && (
                    <button
                      onClick={() => addIn(group.id)}
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-label text-muted hover:bg-hover hover:text-ink"
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
            className="rounded px-2 py-1 text-body text-info hover:bg-hover"
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
