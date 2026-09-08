'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { TrashSection } from '@/components/entity/trash-list';

interface TrashedRecord {
  id: string;
  title: string;
  deleted_at: string;
}

interface TrashedView {
  id: string;
  name: string;
  type: string;
  deleted_at: string;
}

export default function TrashPage() {
  const { ws, db } = useParams<{ ws: string; db: string }>();
  const qc = useQueryClient();

  const trash = useQuery({
    queryKey: ['trash', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/trash',
        { params: { path: { ws, db } } },
      );
      if (error) throw error;
      return (data as unknown as { data: TrashedRecord[] }).data;
    },
  });

  const restore = useMutation({
    mutationFn: async (rec: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/restore',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Restored');
      void qc.invalidateQueries({ queryKey: ['trash', ws, db] });
    },
    onError: () => toast.error('Could not restore'),
  });

  // #618 — deleted views on this database, alongside the records trash
  // already above (a view restores at the same editor+ level records do —
  // see views.controller.ts's `listTrash`/`restore`, no admin gate here).
  const viewsTrash = useQuery({
    queryKey: ['trash-views', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/views/trash',
        { params: { path: { ws, db } } },
      );
      if (error) throw error;
      return data as unknown as TrashedView[];
    },
  });

  const restoreView = useMutation({
    mutationFn: async (view: string) => {
      const { error } = await api.POST(
        '/api/v1/workspaces/{ws}/databases/{db}/views/{view}/restore',
        { params: { path: { ws, db, view } } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Restored');
      void qc.invalidateQueries({ queryKey: ['trash-views', ws, db] });
    },
    onError: () => toast.error('Could not restore'),
  });

  const nothingAtAll = (trash.data ?? []).length === 0 && (viewsTrash.data ?? []).length === 0;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Trash</h1>
        <Link href={`/w/${ws}/d/${db}`} className="text-[13px] text-muted hover:text-ink">
          Back to database
        </Link>
      </div>
      {nothingAtAll ? (
        <p className="text-sm text-muted">Nothing here. Deleted records and views stay restorable for 30 days.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <TrashSection
            title="Records"
            items={trash.data ?? []}
            emptyText="No deleted records."
            label={(r) => r.title}
            onRestore={(r) => restore.mutate(r.id)}
            restoringId={restore.isPending ? restore.variables : undefined}
          />
          <TrashSection
            title="Views"
            items={viewsTrash.data ?? []}
            emptyText="No deleted views."
            label={(v) => v.name}
            meta={(v) => `(${v.type})`}
            onRestore={(v) => restoreView.mutate(v.id)}
            restoringId={restoreView.isPending ? restoreView.variables : undefined}
          />
        </div>
      )}
    </div>
  );
}
