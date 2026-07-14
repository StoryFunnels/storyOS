'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/preferences';
import { Button } from '@/components/ui/button';

interface TrashedRecord {
  id: string;
  title: string;
  deleted_at: string;
}

export default function TrashPage() {
  const { ws, db } = useParams<{ ws: string; db: string }>();
  const qc = useQueryClient();
  const fmt = useDateFormat();

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
  });

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Trash</h1>
        <Link href={`/w/${ws}/d/${db}`} className="text-[13px] text-muted hover:text-ink">
          Back to database
        </Link>
      </div>
      {(trash.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">Nothing here. Deleted records stay restorable for 30 days.</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
          {(trash.data ?? []).map((record) => (
            <div
              key={record.id}
              className="flex items-center justify-between border-b border-border-default px-4 py-3 last:border-b-0"
            >
              <div>
                <p className="text-sm text-ink">{record.title || 'Untitled'}</p>
                <p className="text-[13px] text-muted">
                  Deleted {fmt.dateTime(record.deleted_at)}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => restore.mutate(record.id)}>
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
