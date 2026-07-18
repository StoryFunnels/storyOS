'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { DatabaseDetail } from '../table-view/use-table-data';
import { activeFilterNode, andFilterNodes, filterConditions } from './filter-config';
import type { FilterGroup, FilterNode } from './filter-config';
import type { NullsPlacement, SortSpec } from './sort-config';

export type { FilterCondition, FilterConnector, FilterGroup, FilterNode } from './filter-config';
export { andFilterNodes, buildFilterGroup, filterConditions, filterConnector, reorderConditions } from './filter-config';
export type { NullsPlacement, SortSpec } from './sort-config';
export { MAX_SORTS, directionLabel, nextSortField, reorderSorts } from './sort-config';

/** v1 UI filter model (MN-253): a flat And/Or list — the API allows nesting; the UI stays flat. */
export interface ViewConfig {
  filters?: FilterGroup;
  sorts: SortSpec[];
  /** Whole-sort control (MN-252): where empty/null sort values land. Undefined = 'last'. */
  sorts_nulls?: NullsPlacement;
  hidden_field_ids: string[];
  group_by_field_id?: string;
  /** Color rows/cards by a select field's option color (MN-102). */
  color_by_field_id?: string;
  card_field_ids: string[];
  /** Board card density (MN-089). */
  card_size?: 'small' | 'medium' | 'large';
  date_field_id?: string;
  /** Timeline (MN-092). */
  start_date_field_id?: string;
  end_date_field_id?: string;
  /** Form (MN-094, MN-101). */
  form?: {
    title?: string;
    description?: string;
    submit_text?: string;
    fields: Array<{ field_id: string; required?: boolean; label?: string; help?: string }>;
    public_token?: string;
    /** Who may open/submit the shared form. */
    access?: 'members' | 'link' | 'public';
    success_message?: string;
    redirect_url?: string;
  };
  column_widths: Record<string, number>;
}

export interface ViewSummary {
  id: string;
  name: string;
  type: 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'feed' | 'timeline' | 'form';
  config: ViewConfig;
  isDefault?: boolean;
  position?: number;
}

export const EMPTY_CONFIG: ViewConfig = {
  sorts: [],
  hidden_field_ids: [],
  card_field_ids: [],
  column_widths: {},
};

function normalize(config: Partial<ViewConfig> | undefined): ViewConfig {
  return {
    ...EMPTY_CONFIG,
    ...config,
    filters: filterConditions(config?.filters).length > 0 ? config?.filters : undefined,
  };
}

/**
 * Saved view config + local ad-hoc overrides (C11): tweaks don't touch the
 * shared view until "Save to view"; Reset discards.
 */
export function useViewState(
  ws: string,
  db: string,
  database: DatabaseDetail | undefined,
  viewId: string | null,
  readOnly = false,
) {
  const qc = useQueryClient();
  const views = useMemo<ViewSummary[]>(
    () => (database?.views ?? []).map((v) => ({ ...v, config: normalize(v.config as Partial<ViewConfig>) }) as ViewSummary),
    [database?.views],
  );
  // No explicit ?view= → open the database's default view (MN-241), else the first.
  const activeView =
    views.find((v) => v.id === viewId) ?? views.find((v) => v.isDefault) ?? views[0];

  const [draft, setDraft] = useState<ViewConfig | null>(null);
  useEffect(() => setDraft(null), [activeView?.id]);

  const config = draft ?? activeView?.config ?? EMPTY_CONFIG;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(activeView?.config);

  const patch = useCallback(
    (updates: Partial<ViewConfig>) => {
      setDraft((prev) => ({ ...(prev ?? activeView?.config ?? EMPTY_CONFIG), ...updates }));
    },
    [activeView?.config],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!activeView || !draft) return;
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
        params: { path: { ws, db, view: activeView.id } },
        body: { config: draft as never },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['database', ws, db] });
    },
    onError: () => toast.error('Could not save the view'),
  });

  // Auto-save (MN-152): persist config edits automatically, debounced — no manual
  // "Save to view". Coalesces rapid patches (e.g. a column-resize drag) into one PATCH.
  const saveMutate = save.mutate;
  useEffect(() => {
    if (readOnly || !activeView || draft === null) return;
    if (JSON.stringify(draft) === JSON.stringify(activeView.config)) return;
    const timer = setTimeout(() => saveMutate(), 600);
    return () => clearTimeout(timer);
  }, [draft, activeView, readOnly, saveMutate]);

  // #259: the current viewer's personal filter override, layered on top of
  // `config` at query time (queryBodyFromConfig) — kept OUT of `config`/`draft`
  // above so it never rides the auto-save PATCH into the shared view.
  const personalFilter = usePersonalFilter(ws, db, activeView?.id);

  return {
    views,
    activeView,
    config,
    dirty,
    patch,
    reset: () => setDraft(null),
    save: () => save.mutate(),
    personalFilter: personalFilter.data,
  };
}

export function useViewMutations(ws: string, db: string) {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['database', ws, db] });

  return {
    createView: useMutation({
      mutationFn: async (body: { name: string; type: 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'feed' | 'timeline' | 'form'; config: ViewConfig }) => {
        const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/views', {
          params: { path: { ws, db } },
          body: body as never,
        });
        if (error) throw error;
        return data as unknown as { id: string };
      },
      onSuccess: invalidate,
      onError: () => toast.error('Could not create the view'),
    }),
    renameView: useMutation({
      mutationFn: async ({ id, name }: { id: string; name: string }) => {
        const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
          params: { path: { ws, db, view: id } },
          body: { name },
        });
        if (error) throw error;
      },
      onSuccess: invalidate,
    }),
    deleteView: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
          params: { path: { ws, db, view: id } },
        });
        if (error) throw error;
      },
      onSuccess: invalidate,
      onError: () => toast.error('A database keeps at least one view'),
    }),
    duplicateView: useMutation({
      mutationFn: async (id: string) => {
        const { data, error } = await api.POST(
          '/api/v1/workspaces/{ws}/databases/{db}/views/{view}/duplicate',
          { params: { path: { ws, db, view: id } } },
        );
        if (error) throw error;
        return data as unknown as { id: string };
      },
      onSuccess: invalidate,
      onError: () => toast.error('Could not duplicate the view'),
    }),
    setDefaultView: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await api.POST(
          '/api/v1/workspaces/{ws}/databases/{db}/views/{view}/default',
          { params: { path: { ws, db, view: id } } },
        );
        if (error) throw error;
      },
      onSuccess: invalidate,
      onError: () => toast.error('Could not set the default view'),
    }),
    // Drag-to-reorder the view tabs → writes each moved view's position (MN-221).
    // The DB page renders views in position order, so persisting the new indexes
    // is enough for the order to stick after refetch.
    reorderViews: useMutation({
      mutationFn: async (moves: Array<{ id: string; position: number }>) => {
        for (const m of moves) {
          const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/views/{view}', {
            params: { path: { ws, db, view: m.id } },
            body: { position: m.position },
          });
          if (error) throw error;
        }
      },
      onSettled: invalidate,
      onError: () => toast.error('Could not reorder the views'),
    }),
  };
}

/**
 * The `sorts`/`nulls` slice of a /records/query body (MN-252) — shared by
 * queryBodyFromConfig and any view that builds the rest of its query body
 * itself (calendar-view.tsx composes its own date-window filter) but still
 * needs the same sort spec applied, per the "one spec everywhere" AC.
 * `nulls` only rides along when it diverges from the API's 'last' default,
 * to keep the wire payload minimal.
 */
export function sortsBodyFromConfig(config: ViewConfig): Record<string, unknown> {
  if (config.sorts.length === 0) return {};
  return config.sorts_nulls === 'first' ? { sorts: config.sorts, nulls: 'first' } : { sorts: config.sorts };
}

/**
 * Builds the /records/query body from a view config (the server stays dumb).
 * Disabled clauses (MN-253 UI) and their UI-only fields never reach the query.
 *
 * `personalFilter` (#259) ANDs on top when present — the same top-level-AND-wrap
 * nesting #258 and calendar-view.tsx's own date-window filter use — so a personal
 * override narrows the shared view's results, never replaces or widens them.
 */
export function queryBodyFromConfig(config: ViewConfig, personalFilter?: FilterNode): Record<string, unknown> {
  const body: Record<string, unknown> = { limit: 100 };
  const filter = andFilterNodes(activeFilterNode(config.filters), personalFilter);
  if (filter) body.filter = filter;
  Object.assign(body, sortsBodyFromConfig(config));
  return body;
}

/**
 * The current viewer's personal filter override for one view (#259) — a
 * SEPARATE resource from the view's own config (a distinct endpoint, a distinct
 * react-query cache entry), never touched by the view's own PATCH/auto-save.
 * `undefined` viewId (e.g. no view resolved yet) short-circuits to disabled
 * rather than firing a request with an empty path segment.
 */
export function usePersonalFilter(ws: string, db: string, viewId: string | undefined) {
  return useQuery({
    queryKey: ['personal-filter', ws, db, viewId],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/views/{view}/personal-filter',
        { params: { path: { ws, db, view: viewId! } } },
      );
      if (error) throw error;
      return (data as unknown as { filter: FilterNode | null }).filter ?? undefined;
    },
    enabled: Boolean(viewId),
  });
}

/** Sets (or replaces) the current viewer's personal filter override for one view. */
export function useSetPersonalFilter(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ viewId, filter }: { viewId: string; filter: FilterNode }) => {
      const { data, error } = await api.PUT(
        '/api/v1/workspaces/{ws}/databases/{db}/views/{view}/personal-filter',
        { params: { path: { ws, db, view: viewId } }, body: { filter: filter as never } },
      );
      if (error) throw error;
      return (data as unknown as { filter: FilterNode | null }).filter ?? undefined;
    },
    onSuccess: (filter, { viewId }) => qc.setQueryData(['personal-filter', ws, db, viewId], filter),
    onError: () => toast.error('Could not save your personal filter'),
  });
}

/** Clears the current viewer's personal filter override for one view. */
export function useClearPersonalFilter(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (viewId: string) => {
      const { error } = await api.DELETE(
        '/api/v1/workspaces/{ws}/databases/{db}/views/{view}/personal-filter',
        { params: { path: { ws, db, view: viewId } } },
      );
      if (error) throw error;
    },
    onSuccess: (_void, viewId) => qc.setQueryData(['personal-filter', ws, db, viewId], undefined),
    onError: () => toast.error('Could not clear your personal filter'),
  });
}
