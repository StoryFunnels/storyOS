import type { ViewConfig } from './use-view-state';

/**
 * #964 — what changing a view's grouping field writes, in one pure place.
 *
 * Two rules live here because both are judgement calls that deserve a test:
 *
 * 1. A stale `group_by_granularity` must not survive a regroup away from a date field (#515 AC5:
 *    reproduced live, it resurfaced on a later regroup to a different date field).
 * 2. EMPTY GROUPS (Ievgen, 10-20): a board SHOWS empty columns, because an empty column is where you
 *    drop the first card; any other grouped view HIDES them, because an empty group there is noise.
 *    The default is written ONCE, when grouping first starts, and only when the view has never
 *    chosen: a view that already carries `hide_empty_groups` (either way) keeps its choice, and a
 *    later regroup never overrides it. The key is `hide_empty_groups`; #960 was closed because it
 *    already existed.
 *
 * Tables do not group today (only board and list read `group_by_field_id`), so the table half of
 * this default has no surface yet.
 */
export function groupingPatch(opts: {
  viewType: string;
  config: Pick<ViewConfig, 'group_by_field_id' | 'hide_empty_groups'>;
  /** '' = "None" (ungrouping, offered on views where grouping is optional). */
  fieldId: string;
  isDateField: boolean;
}): Partial<ViewConfig> {
  const { viewType, config, fieldId, isDateField } = opts;
  const patch: Partial<ViewConfig> = { group_by_field_id: fieldId || undefined };
  if (!isDateField) patch.group_by_granularity = undefined;
  const startingToGroup = !config.group_by_field_id && Boolean(fieldId);
  if (startingToGroup && viewType !== 'board' && config.hide_empty_groups === undefined) {
    patch.hide_empty_groups = true;
  }
  return patch;
}
