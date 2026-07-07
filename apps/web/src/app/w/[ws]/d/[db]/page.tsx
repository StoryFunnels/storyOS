'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Database home — the table view lands here with MN-016. */
export default function DatabasePage() {
  const { ws, db } = useParams<{ ws: string; db: string }>();

  const database = useQuery({
    queryKey: ['database', ws, db],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/{db}', {
        params: { path: { ws, db } },
      });
      if (error) throw error;
      return data as unknown as {
        name: string;
        fields: Array<{ id: string; displayName: string; type: string }>;
      };
    },
  });

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-ink">{database.data?.name ?? '…'}</h1>
      <p className="text-sm text-muted">
        {database.data
          ? `${database.data.fields.filter((f) => !['created_at', 'updated_at', 'created_by'].includes(f.type)).length} fields — the table view arrives with MN-016.`
          : 'Loading…'}
      </p>
    </div>
  );
}
