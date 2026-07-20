'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox as InboxIcon, Maximize2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export type NotificationType =
  | 'assigned'
  | 'mentioned'
  | 'commented'
  | 'state_changed'
  // #263: bare — no record behind these, see NotificationRow.record being null.
  | 'trial_reminder_23'
  | 'trial_reminder_29';
export interface NotificationRow {
  id: string;
  type: NotificationType;
  count: number;
  snippet: string | null;
  read_at: string | null;
  created_at: string;
  record: { id: string; title: string; database_id: string; database_name: string; deleted: boolean } | null;
  actor: { id: string; name: string; image: string | null } | null;
}
interface NotificationsPage {
  data: NotificationRow[];
  next_cursor: string | null;
}

export const NOTIFICATION_VERBS: Record<NotificationType, string> = {
  assigned: 'assigned you',
  mentioned: 'mentioned you',
  commented: 'commented',
  state_changed: 'updated status on',
  trial_reminder_23: 'sent a trial reminder',
  trial_reminder_29: 'sent a final trial reminder',
};
const VERBS = NOTIFICATION_VERBS;

function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Bucket a timestamp into Today / Yesterday / Earlier for grouped headers. */
function bucket(iso: string): 'Today' | 'Yesterday' | 'Earlier' {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= startToday) return 'Today';
  if (t >= startToday - 86_400_000) return 'Yesterday';
  return 'Earlier';
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

/** Inbox (MN-049, #38): the sidebar row opens this right-side panel — All/Unread
 * filter, day-grouped rows, and cursor pagination. */
export function InboxPanel({ ws, onClose }: { ws: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['notifications', ws, unreadOnly],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = {};
      if (unreadOnly) query.unread_only = 'true';
      if (pageParam) query.cursor = pageParam;
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/notifications', {
        params: { path: { ws }, query },
      } as never);
      if (error) throw error;
      return data as unknown as NotificationsPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const rows = (list.data?.pages ?? []).flatMap((p) => p.data);

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

  let lastBucket: string | null = null;

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
            <button
              className="rounded p-1 text-muted hover:bg-hover"
              title="Open full inbox"
              onClick={() => {
                onClose();
                router.push(`/w/${ws}/inbox`);
              }}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button className="rounded p-1 text-muted hover:bg-hover" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </span>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-border-default px-3 py-2">
          {([['all', 'All'], ['unread', 'Unread']] as const).map(([key, label]) => {
            const active = (key === 'unread') === unreadOnly;
            return (
              <button
                key={key}
                onClick={() => setUnreadOnly(key === 'unread')}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                  active ? 'bg-active text-ink' : 'text-muted hover:bg-hover',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 && !list.isLoading && (
            <p className="p-6 text-center text-[13px] text-muted">
              {unreadOnly ? 'No unread notifications.' : "You're all caught up 🎉"}
            </p>
          )}
          {rows.map((n) => {
            const b = bucket(n.created_at);
            const header = b !== lastBucket ? b : null;
            lastBucket = b;
            return (
              <div key={n.id}>
                {header && (
                  <div className="bg-app px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-faint">
                    {header}
                  </div>
                )}
                <button
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
                      {/* Bare notifications (#263) have no actor — a person didn't do this, StoryOS did. */}
                      <span className="font-medium">{n.actor?.name ?? (n.record ? 'Someone' : 'StoryOS')}</span>{' '}
                      {VERBS[n.type]}
                      {n.count > 1 ? ` · ${n.count}×` : ''}
                    </span>
                    {n.record && (
                      <span
                        className={cn(
                          'block truncate text-[12px]',
                          n.record.deleted ? 'text-faint line-through' : 'text-muted',
                        )}
                      >
                        {n.record.title || 'Untitled'} · {n.record.database_name}
                      </span>
                    )}
                    {n.snippet && <span className="block truncate text-[12px] text-faint">{n.snippet}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[11px] text-faint">{relativeTime(n.created_at)}</span>
                    {!n.read_at && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
                  </span>
                </button>
              </div>
            );
          })}
          {list.hasNextPage && (
            <button
              onClick={() => list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              className="w-full py-3 text-center text-[12px] text-muted hover:bg-hover disabled:opacity-50"
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
