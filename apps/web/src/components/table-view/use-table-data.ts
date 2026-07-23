'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';

export interface SelectOption {
  id: string;
  label: string;
  color: string;
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

const recordsKey = (ws: string, db: string) => ['records', ws, db];

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
  });
}

export function useRecordMutations(ws: string, db: string) {
  const qc = useQueryClient();
  const key = recordsKey(ws, db);
  const setAll = (updater: (old: { pages: RecordsPage[] } | undefined) => unknown) =>
    qc.setQueriesData({ queryKey: key }, updater as never);

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
      setAll((old: { pages: RecordsPage[] } | undefined) => {
        if (!old) return old;
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
      void qc.invalidateQueries({ queryKey: ['record', ws, db] });
      void qc.invalidateQueries({ queryKey: ['activity', ws, db] });
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
      setAll((old: { pages: RecordsPage[] } | undefined) => {
        if (!old || old.pages.length === 0) return old;
        const pages = [...old.pages];
        const last = pages[pages.length - 1]!;
        pages[pages.length - 1] = { ...last, data: [...last.data, created] };
        return { ...old, pages };
      });
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
      setAll((old: { pages: RecordsPage[] } | undefined) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({ ...p, data: p.data.filter((r) => r.id !== rec) })),
            }
          : old,
      );
      toast.success('Moved to trash', {
        action: {
          label: 'Undo',
          onClick: async () => {
            const { error } = await api.POST(
              '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/restore',
              { params: { path: { ws, db, rec } } },
            );
            if (error) toast.error('Could not restore');
            else void qc.invalidateQueries({ queryKey: key });
          },
        },
      });
    },
  });

  return { updateRecord, createRecord, deleteRecord };
}
