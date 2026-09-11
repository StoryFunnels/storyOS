'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { DESTRUCTIVE_TOAST_MS, pushUndo } from '@/lib/undo';

export interface SelectOption {
  id: string;
  label: string;
  color: string;
  /** #202: optional curated icon ref (`set:<name>` / `brand:<slug>`), null = none. */
  icon?: string | null;
}

export interface Field {
  id: string;
  apiName: string;
  displayName: string;
  type: string;
  config: Record<string, unknown>;
  isSystem: boolean;
  options?: SelectOption[];
  relation?: {
    id: string;
    cardinality: 'one_to_many' | 'many_to_many';
    side: 'a' | 'b';
    target_database_id: string;
    target_database_name: string | null;
    /** MN-299: the target database's palette color, for the relation chip's
     * cylinder marker. Always resolved server-side (never null in practice). */
    target_database_color?: string | null;
    inverse_field_id: string;
  };
}

export interface DatabaseDetail {
  id: string;
  /**
   * #400 — the DATABASE's own one-line purpose.
   *
   * Not to be confused with the two keys below, despite the shared prefix: those
   * place the RECORD description block (#310) on a record page. This is the
   * sentence that says what belongs in this table.
   */
  description?: string | null;
  /** #310 — RECORD description block placement (see useUpdateDescriptionPlacement). */
  descriptionHidden?: boolean;
  descriptionOrder?: number | null;
  name: string;
  icon: string | null;
  color: string | null;
  my_access: 'viewer' | 'commenter' | 'editor' | 'creator' | 'admin';
  fields: Field[];
  views: Array<{ id: string; name: string; type: string; config: Record<string, unknown> }>;
}

export interface RecordRow {
  id: string;
  /** Per-database sequential public id — the human handle in URLs (MN-087). */
  number: number | null;
  title: string;
  values: Record<string, unknown>;
  position: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface RecordsPage {
  data: RecordRow[];
  next_cursor: string | null;
  has_more: boolean;
}

export function useDatabase(ws: string, db: string) {
  return useQuery({
    queryKey: ['database', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}', {
        params: { path: { ws, db } },
      });
      if (error) throw error;
      return data as unknown as DatabaseDetail;
    },
    enabled: Boolean(ws && db),
  });
}

/**
 * Icon & color patch for the click-to-change database header (#251). Merges
 * the change straight into the `['database', ws, db]` cache so the header
 * updates without waiting on a refetch, and invalidates the sidebar's
 * `['databases', ws]` list so it reflects the same change immediately.
 */
/**
 * #310 — the record description's placement: hidden or not, and where it sits among
 * the body fields. Stored on the DATABASE (a schema decision, shared by everyone)
 * rather than per viewer. The description itself stays a versioned `documents` row —
 * this only moves the block, never the content.
 */
export function useUpdateDescriptionPlacement(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { description_hidden?: boolean; description_order?: number | null }) => {
      const { data, error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}', {
        params: { path: { ws, db } },
        body: patch as never,
      });
      if (error) throw error;
      return data as unknown as DatabaseDetail;
    },
    onSuccess: (data) => {
      qc.setQueryData(['database', ws, db], (prev: DatabaseDetail | undefined) =>
        prev
          ? {
              ...prev,
              descriptionHidden: (data as unknown as DatabaseDetail).descriptionHidden,
              descriptionOrder: (data as unknown as DatabaseDetail).descriptionOrder,
            }
          : prev,
      );
    },
  });
}

export function useUpdateDatabaseIcon(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { icon?: string | null; color?: string | null }) => {
      const { data, error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}', {
        params: { path: { ws, db } },
        body: patch,
      });
      if (error) throw error;
      return data as unknown as DatabaseDetail;
    },
    onSuccess: (data) => {
      qc.setQueryData(['database', ws, db], (prev: DatabaseDetail | undefined) =>
        prev ? { ...prev, icon: data.icon, color: data.color } : prev,
      );
      void qc.invalidateQueries({ queryKey: ['databases', ws] });
    },
  });
}

/**
 * Persist a drag-to-reorder of the canonical field order (#338). Writes each
 * moved field's new `position` (a schema op — `creator` access) and invalidates
 * the database detail so the table columns and the "Hide fields" panel — both
 * driven by `field.position` — refresh to the same order. Shared so those two
 * surfaces stay one canonical order rather than drifting apart.
 */
export function useReorderFields(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (moves: Array<{ fieldId: string; position: number }>) => {
      for (const m of moves) {
        const { error } = await api.PATCH('/api/v1/workspaces/{ws}/databases/{db}/fields/{field}', {
          params: { path: { ws, db, field: m.fieldId } },
          body: { position: m.position },
        });
        if (error) throw error;
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['database', ws, db] }),
    onError: () => toast.error('Could not reorder the fields'),
  });
}

export interface MailConnection {
  id: string;
  name: string;
  provider: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  scopes: string[];
}

/** MN-256: connections a send_email action can reference — Resend/SMTP,
 * ready (a `from:` scope entry means resolveScopes validated a configured
 * from-address; see connections/providers/{resend,smtp}.ts). */
export function useMailConnections(ws: string) {
  return useQuery({
    queryKey: ['connections', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/connections', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: MailConnection[] }).data.filter((c) =>
        ['resend', 'smtp'].includes(c.provider),
      );
    },
    enabled: Boolean(ws),
  });
}

export function useMembers(ws: string, enabled: boolean) {
  return useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as Array<{ user: { id: string; name: string; image: string | null } }>;
    },
    enabled,
    retry: false,
  });
}

// Exported for use-table-data.unit.test.ts, which pins the prefix separation
// this fix depends on — everything else in this file still only calls these
// as plain helpers.
export const recordsKey = (ws: string, db: string) => ['records', ws, db];
// #728 fix — a query key TanStack Query would happily prefix-match against
// recordsKey's own ['records', ws, db]. It used to (below), and every
// optimistic update in useRecordMutations paid for it: setQueriesData/
// getQueriesData match by PREFIX, so a plain-number count cache entry got
// run through updaters written for { pages: [...] }, threw on the first
// `.pages.map(...)`, and — because the throw happened inside onMutate,
// before mutationFn — silently aborted record edit/create/delete with no
// network request and no real error message. Its own key, not a shared one.
export const recordCountKey = (ws: string, db: string) => ['records-count', ws, db];

export function useRecordsInfinite(ws: string, db: string, queryBody?: Record<string, unknown>) {
  const body = queryBody ?? { limit: 100 };
  return useInfiniteQuery({
    queryKey: [...recordsKey(ws, db), body],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/query',
        {
          params: { path: { ws, db } },
          body: { ...body, ...(pageParam ? { cursor: pageParam } : {}) } as never,
        },
      );
      if (error) throw error;
      return data as unknown as RecordsPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // #306 — a space-level dashboard has no database until a tile names one, so
    // `db` can legitimately be empty. useDatabase already guards this way; this
    // one did not, and an empty id would POST to /databases//records/query.
    enabled: Boolean(ws && db),
  });
}

/**
 * #659 — the view's total row count, for the persistent "N records" indicator.
 * Server-computed via `/records/aggregate` (op: count) rather than counting
 * fetched pages — `useRecordsInfinite` only holds however many pages have been
 * scrolled into view so far, and the ADR-0016 rule against it ("counting must
 * not be done by fetching") applies just as much to a table's own row count as
 * to Tyron's. Scoped by the SAME filter the view's own query uses, so the
 * number always matches what the grid is actually showing.
 */
export function useRecordCount(ws: string, db: string, filter?: unknown) {
  return useQuery({
    queryKey: [...recordCountKey(ws, db), filter],
    queryFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records/aggregate', {
        params: { path: { ws, db } },
        body: { op: 'count', ...(filter ? { filter } : {}) } as never,
      });
      if (error) throw error;
      return (data as unknown as { value: number }).value;
    },
    enabled: Boolean(ws && db),
  });
}

/**
 * #728 fix — true only for the `{ pages: [...] }` shape every `setAll`
 * updater below assumes. `recordsKey` used to also match `useRecordCount`'s
 * cache entry (a plain number) via prefix, and the updaters threw on the
 * first `.pages` access; that collision is gone now that the count has its
 * own key (see `recordCountKey`), but this guard stays — a FUTURE query
 * sharing this same prefix then fails safe (the cache entry comes back
 * untouched) instead of silently reintroducing the exact same abort.
 */
export function isRecordsPageCache(data: unknown): data is { pages: RecordsPage[] } {
  return Boolean(data) && Array.isArray((data as { pages?: unknown }).pages);
}

export function useRecordMutations(ws: string, db: string) {
  const qc = useQueryClient();
  const key = recordsKey(ws, db);
  const countKey = recordCountKey(ws, db);
  const setAll = (updater: (old: { pages: RecordsPage[] }) => unknown) =>
    qc.setQueriesData({ queryKey: key }, (old: unknown) =>
      isRecordsPageCache(old) ? updater(old) : old,
    );

  const updateRecord = useMutation({
    mutationFn: async ({ rec, values }: { rec: string; values: Record<string, unknown> }) => {
      const { data, error } = await api.PATCH(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}',
        { params: { path: { ws, db, rec } }, body: { values } },
      );
      if (error) throw error;
      return data as unknown as RecordRow;
    },
    onMutate: async ({ rec, values }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueriesData({ queryKey: key });
      setAll((old) => {
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            data: page.data.map((row) => {
              if (row.id !== rec) return row;
              const nextValues = { ...row.values };
              let nextTitle = row.title;
              for (const [k, v] of Object.entries(values)) {
                if (k === 'name') nextTitle = String(v ?? '');
                else if (v === null) delete nextValues[k];
                else nextValues[k] = v;
              }
              return { ...row, title: nextTitle, values: nextValues };
            }),
          })),
        };
      });
      return { previous };
    },
    onError: (err, _vars, context) => {
      for (const [k, v] of (context?.previous ?? []) as Array<[unknown, unknown]>) {
        qc.setQueryData(k as never, v as never);
      }
      // Surface what the API actually said — a rejected person now comes back
      // naming the candidates, which is useless if we swallow it (MN-119).
      toast.error(apiErrorMessage(err, 'Could not save — value rejected'));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      // The count is filter-scoped (table-view.tsx passes the view's own
      // filter to useRecordCount), and a field edit CAN change whether a
      // record matches that filter — moving it in or out of the view changes
      // the "N records" total, not just the row set. Used to refresh for
      // free through the same prefix collision this file fixes; needs its
      // own invalidation now that the count has its own key.
      void qc.invalidateQueries({ queryKey: countKey });
      void qc.invalidateQueries({ queryKey: ['record', ws, db] });
      void qc.invalidateQueries({ queryKey: ['activity', ws, db] });
      // #199 — My Work lists records from EVERY database, so an edit made anywhere
      // can change a row it is showing (a title, an assignee that moves the record
      // off the list, a field it renders as a chip). Before split screen you always
      // navigated away and back, and the refetch was incidental; now the queue and
      // the record are on screen together, so a stale row is visible the moment you
      // edit. Not scoped by `db` for that reason — the key is cross-database.
      void qc.invalidateQueries({ queryKey: ['my-work', ws] });
    },
  });

  const createRecord = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
        params: { path: { ws, db } },
        body: { values },
      });
      if (error) throw error;
      return data as unknown as RecordRow;
    },
    onSuccess: (created) => {
      setAll((old) => {
        if (old.pages.length === 0) return old;
        const pages = [...old.pages];
        const last = pages[pages.length - 1]!;
        pages[pages.length - 1] = { ...last, data: [...last.data, created] };
        return { ...old, pages };
      });
      // A new record changes the view's total — same count invalidation
      // `key` used to trigger incidentally via the prefix collision this
      // fixes; now explicit, since it no longer happens for free.
      void qc.invalidateQueries({ queryKey: countKey });
    },
    onError: () => toast.error('Could not create record'),
  });

  const deleteRecord = useMutation({
    mutationFn: async (rec: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}', {
        params: { path: { ws, db, rec } },
      });
      if (error) throw error;
    },
    onSuccess: (_data, rec) => {
      setAll((old) => ({
        ...old,
        pages: old.pages.map((p) => ({ ...p, data: p.data.filter((r) => r.id !== rec) })),
      }));
      // A deleted (or restored) record changes the view's total — see the
      // matching note in createRecord.
      void qc.invalidateQueries({ queryKey: countKey });
      // #265: one restore closure, used by BOTH the toast button and the
      // Cmd-Z stack, so the two routes can't drift into doing different things.
      const restore = async () => {
        const { error } = await api.POST(
          '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/restore',
          { params: { path: { ws, db, rec } } },
        );
        if (error) throw error;
        void qc.invalidateQueries({ queryKey: key });
        void qc.invalidateQueries({ queryKey: countKey });
      };
      pushUndo({ label: 'Restored from trash', run: restore });
      toast.success('Moved to trash', {
        // #265: a delete decision shouldn't expire as fast as "Copied". Cmd-Z
        // still works after this lapses — the toast is the hint, not the only route.
        duration: DESTRUCTIVE_TOAST_MS,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await restore();
            } catch {
              toast.error('Could not restore');
            }
          },
        },
      });
    },
  });

  return { updateRecord, createRecord, deleteRecord };
}
