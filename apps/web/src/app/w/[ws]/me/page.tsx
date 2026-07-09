'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { api } from '@/lib/api';
import { EntityIcon } from '@/components/ui/icon-picker';

interface MyWorkGroup {
  database: { id: string; name: string; icon: string | null; color: string | null };
  records: Array<{ id: string; title: string; updated_at: string }>;
}

/** My Work (MN-049): everything with my name on it, across databases. */
export default function MyWorkPage() {
  const { ws } = useParams<{ ws: string }>();
  const myWork = useQuery({
    queryKey: ['my-work', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/my-work', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { groups: MyWorkGroup[] };
    },
  });

  const groups = myWork.data?.groups ?? [];

  return (
    <div className="mx-auto max-w-2xl p-10">
      <h1 className="mb-1 text-xl font-semibold text-ink">My Work</h1>
      <p className="mb-8 text-sm text-muted">Every record where a person field points at you.</p>

      {myWork.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {!myWork.isLoading && groups.length === 0 && (
        <p className="rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-center text-[13px] text-muted">
          Nothing assigned to you yet. When someone sets you in a Person field, it shows up here.
        </p>
      )}

      {groups.map((group) => (
        <div key={group.database.id} className="mb-6">
          <Link
            href={`/w/${ws}/d/${group.database.id}`}
            className="mb-2 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wider text-faint hover:text-ink"
          >
            <EntityIcon
              icon={group.database.icon}
              color={group.database.color}
              fallback={<Database className="h-3.5 w-3.5" />}
            />
            {group.database.name}
            <span className="text-faint">{group.records.length}</span>
          </Link>
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">
            {group.records.map((record) => (
              <Link
                key={record.id}
                href={`/w/${ws}/d/${group.database.id}/r/${record.id}`}
                className="flex items-center justify-between border-b border-border-default px-4 py-2.5 last:border-b-0 hover:bg-hover"
              >
                <span className="truncate text-[13px] font-medium text-ink">
                  {record.title || 'Untitled'}
                </span>
                <span className="shrink-0 text-[11px] text-faint">
                  {new Date(record.updated_at).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
