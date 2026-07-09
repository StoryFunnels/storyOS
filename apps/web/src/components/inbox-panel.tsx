'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox as InboxIcon, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

interface NotificationRow {
  id: string;
  type: 'assigned' | 'mentioned' | 'commented';
  count: number;
  snippet: string | null;
  read_at: string | null;
  created_at: string;
  record: { id: string; title: string; database_id: string; database_name: string; deleted: boolean } | null;
  actor: { id: string; name: string; image: string | null } | null;
}

const VERBS: Record<NotificationRow['type'], string> = {
  assigned: 'assigned you',
  mentioned: 'mentioned you',
  commented: 'commented',
};

function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function useUnreadCount(ws: string) {
  return useQuery({
    queryKey: ['unread', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/notifications/unread-count', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return (data as unknown as { count: number }).count;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Inbox (MN-049): the sidebar row opens this right-side panel. */
export function InboxPanel({ ws, onClose }: { ws: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [unreadOnly] = useState(false);

  const list = useQuery({
    queryKey: ['notifications', ws, unreadOnly],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/notifications', {
        params: { path: { ws }, query: unreadOnly ? { unread_only: 'true' } : {} },
      } as never);
      if (error) throw error;
      return data as unknown as { data: NotificationRow[] };
    },
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notifications', ws] });
    void qc.invalidateQueries({ queryKey: ['unread', ws] });
  };

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      await api.POST('/api/v1/workspaces/{ws}/notifications/{id}/read', {
        params: { path: { ws, id } },
      } as never);
    },
    onSuccess: invalidate,
  });

  const markAll = useMutation({
    mutationFn: async () => {
      await api.POST('/api/v1/workspaces/{ws}/notifications/read-all', {
        params: { path: { ws } },
      } as never);
    },
    onSuccess: invalidate,
  });

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        className="absolute bottom-0 right-0 top-0 flex w-96 flex-col border-l border-border-default bg-card shadow-[-8px_0_24px_rgba(15,23,41,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-default px-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
            <InboxIcon className="h-4 w-4" /> Inbox
          </span>
          <span className="flex items-center gap-2">
            <button className="text-[12px] text-muted hover:text-ink" onClick={() => markAll.mutate()}>
              Mark all read
            </button>
            <button className="rounded p-1 text-muted hover:bg-hover" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {(list.data?.data ?? []).length === 0 && (
            <p className="p-6 text-center text-[13px] text-muted">You're all caught up 🎉</p>
          )}
          {(list.data?.data ?? []).map((n) => (
            <button
              key={n.id}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-border-default px-4 py-3 text-left hover:bg-hover',
                !n.read_at && 'bg-accent-soft/60',
              )}
              onClick={() => {
                markRead.mutate(n.id);
                if (n.record && !n.record.deleted) {
                  onClose();
                  router.push(`/w/${ws}/d/${n.record.database_id}/r/${n.record.id}`);
                }
              }}
            >
              {n.actor ? (
                <Avatar userId={n.actor.id} name={n.actor.name} image={n.actor.image} size={24} />
              ) : (
                <span className="h-6 w-6 rounded-full bg-hover" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">
                  <span className="font-medium">{n.actor?.name ?? 'Someone'}</span> {VERBS[n.type]}
                  {n.count > 1 ? ` · ${n.count}×` : ''}
                </span>
                <span
                  className={cn(
                    'block truncate text-[12px]',
                    n.record?.deleted ? 'text-faint line-through' : 'text-muted',
                  )}
                >
                  {n.record?.title || 'Untitled'} · {n.record?.database_name}
                </span>
                {n.snippet && <span className="block truncate text-[12px] text-faint">{n.snippet}</span>}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-[11px] text-faint">{relativeTime(n.created_at)}</span>
                {!n.read_at && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
