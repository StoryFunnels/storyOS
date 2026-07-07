'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

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
}

export interface DatabaseDetail {
  id: string;
  name: string;
  icon: string | null;
  fields: Field[];
  views: Array<{ id: string; name: string; type: string; config: Record<string, unknown> }>;
}

export interface RecordRow {
  id: string;
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
      return data as unknown as Array<{ user: { id: string; name: string } }>;
    },
    enabled,
    retry: false,
  });
}

const recordsKey = (ws: string, db: string) => ['records', ws, db];

export function useRecordsInfinite(ws: string, db: string) {
  return useInfiniteQuery({
    queryKey: recordsKey(ws, db),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/query',
        {
          params: { path: { ws, db } },
          body: { limit: 100, ...(pageParam ? { cursor: pageParam } : {}) },
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
      const previous = qc.getQueryData(key);
      qc.setQueryData(key, (old: { pages: RecordsPage[] } | undefined) => {
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
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
      toast.error('Could not save — value rejected');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
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
      qc.setQueryData(key, (old: { pages: RecordsPage[] } | undefined) => {
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
      qc.setQueryData(key, (old: { pages: RecordsPage[] } | undefined) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({ ...p, data: p.data.filter((r) => r.id !== rec) })),
            }
          : old,
      );
      toast.success('Moved to trash');
    },
  });

  return { updateRecord, createRecord, deleteRecord };
}
