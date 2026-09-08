'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { TrashSection } from '@/components/entity/trash-list';

interface TrashedSpace {
  id: string;
  name: string;
  deleted_at: string;
}

interface TrashedDatabase {
  id: string;
  name: string;
  space_id: string;
  deleted_at: string;
}

/**
 * #618 — the workspace half of #37's trash: deleted SPACES and DATABASES.
 * Both list/restore endpoints are `@MinRole('admin')` (databases.controller.ts,
 * workspaces.controller.ts) — unlike the per-database records/views trash
 * (`d/[db]/trash`, editor+), so this page is admin-only and lives in Settings
 * rather than under a database route: a deleted database or space has no
 * database of its own left to hang a page off.
 */
export default function WorkspaceTrashPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();
  const workspace = useWorkspace(ws);
  const role = (workspace.data as { role?: string } | undefined)?.role;
  const isAdmin = role === 'admin';

  const spacesTrash = useQuery({
    queryKey: ['trash-spaces', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/trash', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as TrashedSpace[];
    },
    enabled: isAdmin,
  });

  const restoreSpace = useMutation({
    mutationFn: async (space: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/restore', {
        params: { path: { ws, space } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Restored');
      void qc.invalidateQueries({ queryKey: ['trash-spaces', ws] });
      void qc.invalidateQueries({ queryKey: ['spaces', ws] });
      // #618 — restoring a space cascades server-side onto every database
      // deleted WITH it (restore_space's own doc: "along with every database
      // ... that was deleted WITH it"). Verified live: after restoring a
      // space, its 4 databases were already back on reload, but this list
      // still showed them as trashed until a hard refresh — the missing
      // invalidation, not a backend bug.
      void qc.invalidateQueries({ queryKey: ['trash-databases', ws] });
      void qc.invalidateQueries({ queryKey: ['databases', ws] });
    },
    onError: () => toast.error('Could not restore'),
  });

  const databasesTrash = useQuery({
    queryKey: ['trash-databases', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/databases/trash', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as TrashedDatabase[];
    },
    enabled: isAdmin,
  });

  const restoreDatabase = useMutation({
    mutationFn: async (db: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{ws}/databases/{db}/restore', {
        params: { path: { ws, db } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Restored');
      void qc.invalidateQueries({ queryKey: ['trash-databases', ws] });
      void qc.invalidateQueries({ queryKey: ['databases', ws] });
    },
    onError: () => toast.error('Could not restore'),
  });

  if (workspace.isLoading) return <p className="p-8 text-[13px] text-muted">Loading…</p>;

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <h1 className="mb-1 text-lg font-semibold text-ink">Trash</h1>
        <p className="text-[13px] text-muted">
          Only workspace admins can restore a deleted space or database. Deleted records and
          views inside a database you can still open are in that database's own trash.
        </p>
      </div>
    );
  }

  const nothingAtAll = (spacesTrash.data ?? []).length === 0 && (databasesTrash.data ?? []).length === 0;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Trash</h1>
      <p className="mb-6 text-[13px] text-muted">
        Deleted spaces and databases for the whole workspace. Deleted records and views live in
        each database's own Trash — open the database and look for it there instead.
      </p>
      {nothingAtAll ? (
        <p className="text-sm text-muted">Nothing here. Deleted spaces and databases stay restorable for 30 days.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <TrashSection
            title="Spaces"
            items={spacesTrash.data ?? []}
            emptyText="No deleted spaces."
            label={(s) => s.name}
            onRestore={(s) => restoreSpace.mutate(s.id)}
            restoringId={restoreSpace.isPending ? restoreSpace.variables : undefined}
          />
          <TrashSection
            title="Databases"
            items={databasesTrash.data ?? []}
            emptyText="No deleted databases."
            label={(d) => d.name}
            onRestore={(d) => restoreDatabase.mutate(d.id)}
            restoringId={restoreDatabase.isPending ? restoreDatabase.variables : undefined}
          />
        </div>
      )}
    </div>
  );
}
