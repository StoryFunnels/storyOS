'use client';

import { Check, Group } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Field } from '../table-view/use-table-data';
import { COLUMN_SORT_LABELS, type ColumnSort } from './board-columns';
import { boardGroupDisabledReason, listGroupDisabledReason } from './groupable-fields';
import { groupingPatch } from './view-grouping';
import type { ViewConfig } from './use-view-state';
import { chipClass } from './toolbar-chip';

/** The views that actually group. Tables do not (only board and list read `group_by_field_id`). */
export function viewGroups(viewType: string | undefined): viewType is 'board' | 'list' {
  return viewType === 'board' || viewType === 'list';
}

/** The label of the ungrouped bucket, matched to board-view.tsx's own copy so the switch names the
 * column the user is actually looking at (#428). */
export function noValueLabelFor(groupType: string | undefined): string {
  if (groupType === 'date') return 'No date';
  if (groupType === 'select' || groupType === 'workflow') return 'No value';
  return 'Unassigned';
}

/**
 * Whether the chip is drawn at all (#964): ALWAYS on a board, whose columns ARE the grouping; on a
 * list only while grouping is on, because an ungrouped list has nothing to configure here (the
 * way to START grouping a list is Display → Group by).
 */
export function showsGroupChip(viewType: string | undefined): boolean {
  // #1114 — a list offers Group beside Filter and Sort at all times: the control to START grouping
  // must not hide until grouping is on (#964 had it appear only while grouped).
  return viewType === 'board' || viewType === 'list';
}

const ROW =
  'flex w-full items-center justify-between gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 text-left text-label text-ink hover:bg-hover disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent';
const HEAD = 'block px-2 pb-0.5 pt-1.5 text-meta font-semibold uppercase tracking-wider text-muted';

/**
 * #964 — the Group chip and its panel. It replaces the old "Change grouping…" dialog (view-tab) and
 * the grouping toggles that lived inside the filter popover (#428), and puts all of them in the one
 * place grouping is configured:
 *
 * - the field list (None, where grouping is optional, plus every field with its disabled REASON,
 *   never silently omitted: #225/#267/#272),
 * - Column order as a TICKED LIST, not a segmented control, which wrapped to two lines (Ievgen's
 *   screenshot): a label that cannot fit means the control should be a list,
 * - Hide empty groups (`hide_empty_groups`),
 * - Hide the "no value" bucket when empty (`hide_empty_no_value_group`), named after the real
 *   bucket ("Unassigned", "No value", "No date") so it is obvious which column it hides,
 * - the column period, when a board is grouped by a date.
 */
export function GroupChip({
  viewType,
  fields,
  config,
  onPatch,
}: {
  viewType: 'board' | 'list';
  fields: Field[];
  config: ViewConfig;
  onPatch: (patch: Partial<ViewConfig>) => void;
}) {
  const groupField = fields.find((f) => f.id === config.group_by_field_id);
  const isDate = groupField?.type === 'date';
  const columnSort: ColumnSort = config.column_sort ?? 'natural';
  const reasonFor = viewType === 'board' ? boardGroupDisabledReason : listGroupDisabledReason;
  const noValueLabel = noValueLabelFor(groupField?.type);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Group"
          className={chipClass(Boolean(groupField))}
        >
          <Group className="h-3 w-3" />
          <span className="tb-group max-w-[12rem] truncate">{groupField ? `Group: ${groupField.displayName}` : 'Group'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-96 w-64 overflow-y-auto p-1">
        <span className={HEAD}>Group by</span>
        {viewType === 'list' && (
          <button
            type="button"
            className={ROW}
            onClick={() =>
              onPatch(groupingPatch({ viewType, config, fieldId: '', isDateField: false }))
            }
          >
            None {!config.group_by_field_id && <Check className="h-3.5 w-3.5 text-primary-text" />}
          </button>
        )}
        {/* Only the fields that can group this view, by name — a list of greyed-out
            rows each carrying a sentence of explanation was a wall, not a choice. */}
        {fields.filter((f) => reasonFor(f) === null).map((f) => {
          return (
            <button
              key={f.id}
              type="button"
              className={ROW}
              onClick={() =>
                onPatch(groupingPatch({ viewType, config, fieldId: f.id, isDateField: f.type === 'date' }))
              }
            >
              <span className="min-w-0 flex-1 truncate">{f.displayName}</span>
              {config.group_by_field_id === f.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary-text" />}
            </button>
          );
        })}

        {groupField && (
          <>
            {isDate && viewType === 'board' && (
              <>
                {/* #307 — the period per column, only when the columns come from data (a date), not options. */}
                <span className={cn(HEAD, 'mt-1 border-t border-border-default pt-2')}>Column period</span>
                {(['week', 'month', 'quarter', 'year'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={ROW}
                    onClick={() => onPatch({ group_by_granularity: p })}
                  >
                    <span className="capitalize">By {p}</span>
                    {(config.group_by_granularity ?? 'month') === p && <Check className="h-3.5 w-3.5 text-primary-text" />}
                  </button>
                ))}
              </>
            )}
            {/* #427 AC-3 — a date board's columns are chronological periods; any other order is
                meaningless there, so the control is not offered. */}
            {!isDate && (
              <>
                <span className={cn(HEAD, 'mt-1 border-t border-border-default pt-2')}>Column order</span>
                {(Object.keys(COLUMN_SORT_LABELS) as ColumnSort[]).map((k) => (
                  <button key={k} type="button" className={ROW} onClick={() => onPatch({ column_sort: k })}>
                    {COLUMN_SORT_LABELS[k]}
                    {columnSort === k && <Check className="h-3.5 w-3.5 text-primary-text" />}
                  </button>
                ))}
              </>
            )}
            <span className={cn(HEAD, 'mt-1 border-t border-border-default pt-2')}>Empty groups</span>
            <label className={ROW}>
              Hide empty groups
              <input
                type="checkbox"
                checked={Boolean(config.hide_empty_groups)}
                // A real boolean, never `undefined`: an explicit "show" must stay distinguishable from "never chosen",
                // or regrouping from None would re-apply the hide-empty default over the user's choice.
                onChange={(e) => onPatch({ hide_empty_groups: e.target.checked })}
              />
            </label>
            <label className={ROW}>
              Hide “{noValueLabel}” when empty
              <input
                type="checkbox"
                checked={Boolean(config.hide_empty_no_value_group)}
                onChange={(e) => onPatch({ hide_empty_no_value_group: e.target.checked || undefined })}
              />
            </label>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
