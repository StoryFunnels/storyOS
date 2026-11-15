'use client';

import { EmptyState } from '@/components/ui/empty-state';
import { useRecordCount } from '../table-view/use-table-data';
import { emptyViewCause, filterButtonState } from './filter-state';
import { queryBodyFromConfig } from './use-view-state';
import type { ViewConfig } from './use-view-state';
import type { FilterNode } from './filter-config';
import { useViewSearch } from './view-search';

/**
 * #965 — WHY a view is empty, from three server counts.
 *
 * "Nothing here yet. Add your first task" is true for a new database and a lie for one whose filter
 * hides all 40 records. This asks the server, never a page of loaded rows: the total, what the view's
 * own filter keeps, what the view's filter AND the personal filter keep, and what the view shows
 * (Find included). When nothing narrows the view only the total is asked (one count: is the database empty at all).
 */
export function useEmptyViewCause(
  ws: string,
  db: string,
  config: ViewConfig,
  personalFilter: FilterNode | undefined,
) {
  const search = useViewSearch(db);
  const hasViewFilter = filterButtonState(config.filters, undefined).applied > 0;
  const hasPersonal = filterButtonState(undefined, personalFilter).applied > 0;
  const hasSearch = Boolean(search);
  const narrowed = hasViewFilter || hasPersonal || hasSearch;

  const shownBody = queryBodyFromConfig(config, personalFilter, search);
  const viewBody = queryBodyFromConfig(config, undefined, undefined);
  const viewPersonalBody = queryBodyFromConfig(config, personalFilter, undefined);

  // Ticket #1291: the total is asked even when nothing narrows the view. An empty DATABASE needs the same answer, and it is how the
  // table, board and calendar (which draw nothing of their own for it) learn to show the empty state instead of a bare header row.
  const total = useRecordCount(ws, db, undefined, true);
  const shown = useRecordCount(ws, db, shownBody['filter'], narrowed, shownBody['q'] as string | undefined);
  const afterView = useRecordCount(ws, db, viewBody['filter'], narrowed && hasViewFilter);
  const afterViewPersonal = useRecordCount(ws, db, viewPersonalBody['filter'], narrowed && hasPersonal);

  if (!narrowed) {
    return { cause: total.data === 0 ? ('empty' as const) : null, total: total.data, search: undefined, hasViewFilter };
  }
  return {
    cause: emptyViewCause({
      total: total.data,
      shown: shown.data,
      afterView: hasViewFilter ? afterView.data : undefined,
      afterViewPersonal: hasPersonal ? afterViewPersonal.data : undefined,
      hasViewFilter,
      hasPersonal,
      hasSearch,
    }),
    total: total.data,
    search,
    hasViewFilter,
  };
}

/** The view body when a filter, the personal filter or Find has hidden every record. */
export function EmptyViewNotice({
  cause,
  total,
  search,
  hasViewFilter,
  onClearFilters,
  onClearPersonal,
  onClearSearch,
}: {
  cause: 'filters' | 'personal' | 'search';
  total: number | undefined;
  search: string | undefined;
  hasViewFilter: boolean;
  onClearFilters: () => void;
  onClearPersonal: () => void;
  onClearSearch: () => void;
}) {
  const all = total === undefined ? 'every record' : `all ${total} record${total === 1 ? '' : 's'}`;
  const copy =
    cause === 'filters'
      ? {
          title: `Filters hide ${all}`,
          body: 'Nothing here is deleted. It is only out of view.',
          action: 'Clear filters',
          run: onClearFilters,
        }
      : cause === 'personal'
        ? {
            title: `Your personal filter hides ${all}`,
            body: hasViewFilter
              ? "The view's own filter would show some. Your personal filter is only for you; teammates still see them."
              : 'Nothing here is deleted. Your personal filter is only for you; teammates still see them.',
            action: 'Clear my filter',
            run: onClearPersonal,
          }
        : {
            title: `No names match “${search ?? ''}”`,
            body: 'Nothing here is deleted. Find only narrows what you see.',
            action: 'Clear search',
            run: onClearSearch,
          };
  return (
    <EmptyState
      variant="filtered"
      data-testid="empty-view-notice"
      data-cause={cause}
      title={copy.title}
      body={copy.body}
      action={{ label: copy.action, onClick: copy.run, variant: 'secondary' }}
    />
  );
}
