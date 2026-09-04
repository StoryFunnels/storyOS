'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Lock, Plus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { SidebarRow } from '@/components/sidebar-row';
import { SidebarRowMenu } from '@/components/sidebar-row-menu';

interface PersonalDoc {
  id: string;
  title: string;
  icon: string | null;
}

/**
 * #292/#520 — get-or-create the caller's personal space. The endpoint is
 * idempotent (a unique index on (workspace_id, owner_user_id) WHERE personal
 * backs it), so calling it as a plain query on every sidebar mount is safe —
 * there is no separate "does my personal space exist" check to make first.
 */
export function usePersonalSpace(ws: string) {
  return useQuery({
    queryKey: ['personal-space', ws],
    queryFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/personal', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { id: string; name: string };
    },
    // The row's id/shape never changes once created for this user+workspace.
    staleTime: Infinity,
  });
}

/**
 * #292 — a dedicated Personal section, separate from the shared Spaces tree
 * (docs/architecture/personal-space.md: it "isn't just another space in the
 * list" — it can't be shared, moved, or deleted like one). v1 holds documents
 * only from here; personal VIEWS (#520's other endpoint) need a per-database
 * picker this section doesn't have a home for yet and, more importantly, no
 * workspace-wide "list my personal views" endpoint exists to show them once
 * created — see the follow-up ticket filed alongside this PR. Building the
 * create action without the list would mean creating something the user can
 * never find again from here, which is worse than not offering it yet.
 */
export function PersonalSection({ ws }: { ws: string }) {
  const personal = usePersonalSpace(ws);
  const spaceId = personal.data?.id;
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();

  const docsKey = ['space-docs', ws, spaceId] as const;
  const docs = useQuery({
    queryKey: docsKey,
    enabled: Boolean(spaceId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId! } },
      } as never);
      if (error) throw error;
      return (data as unknown as { data: PersonalDoc[] }).data;
    },
  });

  const createDoc = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/spaces/{space}/documents', {
        params: { path: { ws, space: spaceId! } },
        body: { title: 'Untitled' } as never,
      } as never);
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: docsKey });
      router.push(`/w/${ws}/doc/${d.id}`);
    },
    onError: () => toast.error('Could not create document'),
  });

  const deleteDoc = useMutation({
    mutationFn: async (docId: string) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc: docId } },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: docsKey }),
    onError: () => toast.error('Could not delete document'),
  });

  const items = docs.data ?? [];
  const canCreate = Boolean(spaceId) && !createDoc.isPending;

  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Personal</span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => createDoc.mutate()}
            disabled={!canCreate}
            title="New document"
            className="rounded p-0.5 text-faint hover:bg-hover hover:text-muted disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {/*
        #292 / docs/architecture/personal-space.md §1 — "say so at the point of
        use", verbatim. The ADR calls a wording drift here a support incident,
        so this sentence must change in the same PR as the ADR if it ever needs
        to change at all, not independently.
      */}
      <p className="mb-1.5 flex items-start gap-1 px-2 text-[11px] leading-snug text-faint">
        <Lock className="mt-0.5 h-3 w-3 shrink-0" />
        <span>Only you can see this. If your account is removed, this content is deleted with it.</span>
      </p>
      {items.length === 0 ? (
        <div className="px-2 pb-1">
          <p className="mb-1.5 text-[12px] text-muted">Nothing here yet — draft a doc only you can see.</p>
          <button
            type="button"
            onClick={() => createDoc.mutate()}
            disabled={!canCreate}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> New document
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((doc) => (
            <SidebarRow key={doc.id} depth={1}>
              <Link href={`/w/${ws}/doc/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-2 text-ink-secondary">
                <FileText className="h-3.5 w-3.5 shrink-0 text-faint" />
                <span className="truncate">{doc.title || 'Untitled'}</span>
              </Link>
              <SidebarRowMenu
                label={doc.title || 'Untitled'}
                actions={[
                  {
                    label: 'Delete',
                    danger: true,
                    onSelect: async () => {
                      const ok = await confirm({
                        title: `Delete "${doc.title || 'Untitled'}"?`,
                        confirmLabel: 'Delete',
                        danger: true,
                      });
                      if (ok) deleteDoc.mutate(doc.id);
                    },
                  },
                ]}
              />
            </SidebarRow>
          ))}
        </div>
      )}
    </div>
  );
}
