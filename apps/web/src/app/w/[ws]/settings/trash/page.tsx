'use client';

import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/queries';
import { canOpenAdminSettings } from '@/lib/settings-nav';
import { TrashSection } from '@/components/entity/trash-list';
import { SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRefusal } from '@/components/settings/settings-chrome';
import { EmptyState } from '@/components/ui/empty-state';

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
  const isAdmin = canOpenAdminSettings(role);

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

  if (workspace.isLoading) return <p className="p-8 text-body text-muted">Loading…</p>;

  if (!isAdmin) {
    return (
      <SettingsRefusal title="Trash">
        Only workspace admins can restore a deleted space or database. Deleted records and
        views inside a database you can still open are in that database's own trash.
      </SettingsRefusal>
    );
  }

  // Unloaded is not empty: a confident "Nothing in the trash" before the lists arrive would be wrong for a moment.
  if (spacesTrash.isLoading || databasesTrash.isLoading) return <p className="p-8 text-body text-muted">Loading…</p>;

  const nothingAtAll =(spacesTrash.data ?? []).length === 0 && (databasesTrash.data ?? []).length === 0;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Trash" lead="Deleted spaces and databases, kept for 30 days" />
      <SettingsPageBody>
        {nothingAtAll ? (
          <SettingsBox>
            <EmptyState variant="list" title="Nothing in the trash. Deleted spaces and databases stay restorable for 30 days." />
          </SettingsBox>
        ) : (
          <>
            <TrashSection
              chrome="settings"
              title="Spaces"
              items={spacesTrash.data ?? []}
              emptyText="No deleted spaces."
              label={(s) => s.name}
              onRestore={(s) => restoreSpace.mutate(s.id)}
              restoringId={restoreSpace.isPending ? restoreSpace.variables : undefined}
            />
            <TrashSection
              chrome="settings"
              title="Databases"
              items={databasesTrash.data ?? []}
              emptyText="No deleted databases."
              label={(d) => d.name}
              onRestore={(d) => restoreDatabase.mutate(d.id)}
              restoringId={restoreDatabase.isPending ? restoreDatabase.variables : undefined}
            />
          </>
        )}
        <p className="text-label text-muted">
          Deleted records and views live in each database&apos;s own Trash: open the database and look for it there instead.
        </p>
      </SettingsPageBody>
    </div>
  );
}
