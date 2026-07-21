'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Inbox as InboxIcon, Maximize2, X } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

export type NotificationType =
  | 'assigned'
  | 'mentioned'
  | 'commented'
  | 'state_changed'
  // #210, ADR-0010 §4: a run staged a gated action and is waiting on its
  // owner — this IS the approval gate (see useResolveRun below).
  | 'approval_requested'
  // #263: bare — no record behind these, see NotificationRow.record being null.
  | 'trial_reminder_23'
  | 'trial_reminder_29'
  // MN-252: also bare — a connection has no record behind it either.
  | 'connection_error'
  // MN-189 follow-up (#265): also bare — an off-session auto-reload charge failed.
  | 'auto_reload_failed';
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
  approval_requested: 'needs your approval on',
  trial_reminder_23: 'sent a trial reminder',
  trial_reminder_29: 'sent a final trial reminder',
  connection_error: 'flagged a connection',
  auto_reload_failed: 'flagged an auto-reload failure',
};
const VERBS = NOTIFICATION_VERBS;

/**
 * The approval gate's Approve/Reject (#210, ADR-0010 §4), called from wherever
 * an `approval_requested` notification is rendered — the Inbox slide-over and
 * the full Inbox page. `runId` is the Run record's uuid (NotificationRow.record.id).
 */
export function useResolveRun(ws: string, onSettled: () => void) {
  return useMutation({
    mutationFn: async ({ runId, verdict }: { runId: string; verdict: 'approve' | 'reject' }) => {
      const { error } = await api.POST(`/api/v1/workspaces/{ws}/agents/runs/{run}/${verdict}` as never, {
        params: { path: { ws, run: runId } },
      } as never);
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.verdict === 'approve' ? 'Run approved' : 'Run rejected');
      onSettled();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not resolve — the run may already be settled')),
  });
}

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

  const resolveRun = useResolveRun(ws, invalidate);

  let lastBucket: string | null = null;

  // Portal to document.body: this panel is opened from the Sidebar, which since
  // MN-230b (#216) lives inside the off-canvas drawer wrapper — an element that
  // always carries `transition-transform`/`translate-x-*` classes (even at md+,
  // where translate-x-0 is still a real `transform` value). Any transform
  // establishes a containing block for `position: fixed` descendants, so
  // without the portal this `fixed inset-0` overlay was being sized/positioned
  // relative to the ~240px sidebar box instead of the viewport — clipped to a
  // sliver on mobile, and rendered mostly off-screen to the left on desktop.
  return createPortal(
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        // Fits a 375px viewport (was a hard-coded w-96/384px, wider than the
        // screen it needs to sit inside): full-bleed under md, fixed width above.
        className="absolute bottom-0 right-0 top-0 flex w-full flex-col border-l border-border-default bg-card shadow-[-8px_0_24px_rgba(15,23,41,0.08)] md:w-96"
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
                <div
                  // A plain div, not <button> — an approval_requested row nests
                  // real Approve/Reject <button>s in it, and a <button> can't
                  // contain a <button>. role/tabIndex/onKeyDown keep it operable
                  // the same way a button row would be.
                  role="button"
                  tabIndex={0}
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
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
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
                    {/* The killer mobile flow (mobile-responsive-plan.md): approve or
                        reject a gated agent action in one tap, right from the Inbox.
                        min-h-11 (44px) keeps both a comfortable thumb target. */}
                    {n.type === 'approval_requested' && n.record && !n.record.deleted && (
                      <span className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          disabled={resolveRun.isPending}
                          onClick={() => resolveRun.mutate({ runId: n.record!.id, verdict: 'reject' })}
                          className="min-h-[44px] flex-1 rounded-[var(--radius-control)] border border-border-default px-3 text-[13px] font-medium text-ink-secondary hover:bg-hover disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          disabled={resolveRun.isPending}
                          onClick={() => resolveRun.mutate({ runId: n.record!.id, verdict: 'approve' })}
                          className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-3 text-[13px] font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </button>
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[11px] text-faint">{relativeTime(n.created_at)}</span>
                    {!n.read_at && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
                  </span>
                </div>
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
    </div>,
    document.body,
  );
}
