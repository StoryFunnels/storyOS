'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { andFilterNodes } from '../views/filter-config';
import type { Field, RecordRow } from './use-table-data';

/**
 * #233 — a database can be nested by ANY self-referential one-to-many
 * relation's single ("Parent") side, not just a field literally named
 * "Parent" — #344's ruling allows more than one self-relation on a database
 * (e.g. a Parent tree AND a separate Blocked-by pair simultaneously), so
 * eligibility is structural, never name-matched. This is the exact same
 * "single side of a one-to-many relation" test `boardGroupError`
 * (views.service.ts) already uses for board grouping — a record can have at
 * MOST one value here, which is what makes "nest under this" well-defined.
 */
export function isHierarchyField(field: Field, databaseId: string): boolean {
  return (
    field.type === 'relation' &&
    field.relation?.cardinality === 'one_to_many' &&
    field.relation?.side === 'a' &&
    field.relation?.target_database_id === databaseId
  );
}

const expandedKey = (viewId: string) => `storyos:hierarchy-expanded:${viewId}`;

/**
 * Per-row expand/collapse state. Persisted in `sessionStorage` rather than
 * the view's own config — #233's AC asks for state to persist "across the
 * session", not across viewers or devices, and which rows are open is a
 * per-viewer reading position, not shared view configuration (the same
 * distinction the view/personal-filter split already draws elsewhere).
 * Keyed by VIEW rather than database: two views over the same nested
 * database may reasonably have different rows expanded.
 */
export function useHierarchyExpansion(viewId: string | undefined) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!viewId || typeof window === 'undefined') {
      setExpanded(new Set());
      return;
    }
    try {
      const raw = window.sessionStorage.getItem(expandedKey(viewId));
      setExpanded(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch {
      setExpanded(new Set());
    }
  }, [viewId]);

  const persist = useCallback(
    (next: Set<string>) => {
      setExpanded(next);
      if (!viewId || typeof window === 'undefined') return;
      try {
        window.sessionStorage.setItem(expandedKey(viewId), JSON.stringify([...next]));
      } catch {
        /* storage full or blocked (private mode) — expansion just won't
         * survive a reload; the toggle itself still works for this render. */
      }
    },
    [viewId],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
    },
    [expanded, persist],
  );

  /**
   * Expands every id CURRENTLY KNOWN to have children (the caller passes the
   * ids it has already confirmed via child-count checks). This is
   * deliberately not "expand the whole tree, however deep": a lazily-loaded
   * tree has no bound on depth until you look, and eagerly walking it to
   * find out is exactly the eager-fetch #233's AC rules out. Expanding
   * reveals each newly-visible row's own count, so a second Expand-all opens
   * one further level — same "reveal what you already know" contract as the
   * per-row caret, just applied in bulk.
   */
  const expandAll = useCallback((ids: string[]) => persist(new Set([...expanded, ...ids])), [expanded, persist]);
  const collapseAll = useCallback(() => persist(new Set()), [persist]);

  return { expanded, toggle, expandAll, collapseAll };
}

interface RecordsPageLike {
  data: RecordRow[];
  has_more: boolean;
}

export interface HierarchyChildData {
  rows: RecordRow[];
  hasMore: boolean;
  isLoading: boolean;
}

/**
 * One page (up to the API's own 200-row ceiling) of a parent's children —
 * fetched only for parents the caller has actually expanded, scoped by the
 * SAME view filter/sort every other row in this view respects (#233's AC).
 * Not its own infinite scroll: a "N more" affordance the caller renders when
 * `hasMore` is true is honest about a very wide sibling group rather than
 * silently truncating it, the same "declare the gap" posture the rest of
 * this codebase takes (e.g. dashboard exports, the audit-pack ticket).
 */
export function useHierarchyChildren(
  ws: string,
  db: string,
  hierarchyField: Field | undefined,
  expandedIds: string[],
  baseFilter: unknown,
  sorts: unknown[],
): Map<string, HierarchyChildData> {
  const apiName = hierarchyField?.apiName;
  const queries = useQueries({
    queries: expandedIds.map((parentId) => ({
      queryKey: ['hierarchy-children', ws, db, apiName, parentId, baseFilter, sorts],
      queryFn: async (): Promise<RecordsPageLike> => {
        const filter = andFilterNodes(baseFilter, { field: apiName, op: 'has', value: [parentId] });
        const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
          params: { path: { ws, db } },
          body: { filter, sorts, limit: 200 } as never,
        });
        if (error) throw error;
        return data as unknown as RecordsPageLike;
      },
      enabled: Boolean(ws && db && apiName),
    })),
  });

  return useMemo(() => {
    const map = new Map<string, HierarchyChildData>();
    expandedIds.forEach((id, i) => {
      const q = queries[i];
      map.set(id, {
        rows: q?.data?.data ?? [],
        hasMore: q?.data?.has_more ?? false,
        isLoading: q?.isLoading ?? false,
      });
    });
    return map;
  }, [expandedIds, queries]);
}

/**
 * "Does this row have children" for the expand caret — one `/records/aggregate`
 * (op: count) call per row needing an answer, the same server-computed-count
 * primitive `useRecordCount` already uses rather than inferring from a page
 * of fetched data. Batched via `useQueries`; the caller decides which ids
 * actually need asking (visible rows only — see table-view.tsx), so this
 * never runs against the whole database at once.
 */
export function useHierarchyChildCounts(
  ws: string,
  db: string,
  hierarchyField: Field | undefined,
  ids: string[],
  baseFilter: unknown,
): Map<string, number> {
  const apiName = hierarchyField?.apiName;
  const queries = useQueries({
    queries: ids.map((parentId) => ({
      queryKey: ['hierarchy-child-count', ws, db, apiName, parentId, baseFilter],
      queryFn: async (): Promise<number> => {
        const filter = andFilterNodes(baseFilter, { field: apiName, op: 'has', value: [parentId] });
        const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/aggregate', {
          params: { path: { ws, db } },
          body: { op: 'count', filter } as never,
        });
        if (error) throw error;
        return (data as unknown as { value: number }).value;
      },
      enabled: Boolean(ws && db && apiName),
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const map = new Map<string, number>();
    ids.forEach((id, i) => map.set(id, queries[i]?.data ?? 0));
    return map;
  }, [ids, queries]);
}

export interface HierarchyRow {
  row: RecordRow;
  depth: number;
  isExpanded: boolean;
  /** Rows still loading their FIRST page of children — the caller renders a
   * lightweight "Loading…" child row rather than a bare, momentarily-empty
   * expansion (which would read as "no children" for one render). */
  childrenLoading: boolean;
  hasMoreChildren: boolean;
}

/**
 * Interleaves each expanded parent's currently-loaded children directly
 * after it, indenting by depth — the structural half of #233. Deliberately
 * takes NO opinion on which rows have a caret (that needs child-count data
 * this function isn't given); `table-view.tsx` computes counts for exactly
 * the rows this returns and merges them in, so a count query never runs for
 * a row that isn't actually visible.
 */
export function flattenHierarchy(
  rootRows: RecordRow[],
  childrenByParent: Map<string, HierarchyChildData>,
  expanded: Set<string>,
): HierarchyRow[] {
  const out: HierarchyRow[] = [];
  function walk(row: RecordRow, depth: number) {
    const isExpanded = expanded.has(row.id);
    const child = isExpanded ? childrenByParent.get(row.id) : undefined;
    out.push({
      row,
      depth,
      isExpanded,
      childrenLoading: isExpanded && (child?.isLoading ?? true),
      hasMoreChildren: Boolean(child?.hasMore),
    });
    if (isExpanded) {
      (child?.rows ?? []).forEach((childRow) => walk(childRow, depth + 1));
    }
  }
  rootRows.forEach((r) => walk(r, 0));
  return out;
}
