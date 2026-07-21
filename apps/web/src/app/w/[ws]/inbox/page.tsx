'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, ArchiveRestore, Check, ExternalLink, Inbox as InboxIcon, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  NOTIFICATION_VERBS,
  useResolveRun,
  type NotificationRow,
  type NotificationType,
} from '@/components/inbox-panel';

interface NotificationsPage {
  data: NotificationRow[];
  next_cursor: string | null;
}

const TYPE_TABS: Array<{ key: NotificationType | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'mentioned', label: 'Mentions' },
  { key: 'commented', label: 'Comments' },
  { key: 'state_changed', label: 'Status' },
];

function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Full-page Inbox (MN-073): a two-pane triage surface — list on the left with a
 * type filter and an Archived view, a preview of the selected notification on the
 * right, so you read without navigating away. Archive moves an item out of the list.
 */
export default function InboxPage() {
  const { ws } = useParams<{ ws: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [type, setType] = useState<NotificationType | 'all'>('all');
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['inbox', ws, type, archived],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: Record<string, string> = {};
      if (type !== 'all') query.type = type;
      if (archived) query.archived = 'true';
      if (pageParam) query.cursor = pageParam;
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/notifications', {
        params: { path: { ws }, query },
      } as never);
      if (error) throw error;
      return data as unknown as NotificationsPage;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.data), [list.data]);
  // Desktop (md+) auto-previews rows[0] so the two-pane layout never shows an
  // empty right pane. Under md there is only one pane, so it must start on the
  // LIST — auto-previewing here would skip straight to a detail view the user
  // never tapped into. selectedId starts null and is only set by an explicit
  // tap, so "has the user tapped a row" and "what does desktop preview" are two
  // different questions answered from the same piece of state.
  const selected = rows.find((n) => n.id === selectedId) ?? rows[0] ?? null;
  const mobileShowDetail = selectedId !== null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['inbox', ws] });
    void qc.invalidateQueries({ queryKey: ['notifications', ws] });
    void qc.invalidateQueries({ queryKey: ['unread', ws] });
  };

  const resolveRun = useResolveRun(ws, invalidate);

  const setArchivedMut = useMutation({
    mutationFn: async ({ id, archive }: { id: string; archive: boolean }) => {
      await api.POST(`/api/v1/workspaces/{ws}/notifications/{id}/${archive ? 'archive' : 'unarchive'}` as never, {
        params: { path: { ws, id } },
      } as never);
    },
    onSuccess: invalidate,
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      await api.POST('/api/v1/workspaces/{ws}/notifications/{id}/read', {
        params: { path: { ws, id } },
      } as never);
    },
    onSuccess: invalidate,
  });

  const openRecord = (n: NotificationRow) => {
    if (n.record && !n.record.deleted) {
      markRead.mutate(n.id);
      router.push(`/w/${ws}/d/${n.record.database_id}/r/${n.record.id}`);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-default px-4">
        <InboxIcon className="h-4 w-4 shrink-0 text-muted" />
        <h1 className="shrink-0 text-sm font-semibold text-ink">Inbox</h1>
        {/* Same fix as the view-tab bar (MN-230b): scrolls instead of clipping
            under a narrow viewport — min-w-0 lets it actually shrink so
            overflow-x-auto kicks in rather than pushing the header wide. */}
        <div className="ml-4 flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {TYPE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setType(t.key)}
              className={cn(
                'shrink-0 rounded px-2.5 py-1 text-[12px] font-medium',
                type === t.key ? 'bg-active text-ink' : 'text-muted hover:bg-hover',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setArchived((v) => !v)}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-medium',
            archived ? 'bg-active text-ink' : 'text-muted hover:bg-hover',
          )}
        >
          <Archive className="h-3.5 w-3.5" /> {archived ? 'Archived' : 'Show archived'}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* LIST — single-pane under md: hidden once a row's been tapped, so the
            detail view replaces it instead of squeezing beside it. Always shown
            at md+ where both panes fit. */}
        <div
          className={cn(
            'w-full overflow-y-auto border-r border-border-default md:max-w-md md:shrink-0',
            mobileShowDetail && 'hidden md:block',
          )}
        >
          {rows.length === 0 && !list.isLoading && (
            <p className="p-6 text-center text-[13px] text-muted">
              {archived ? 'Nothing archived.' : "You're all caught up 🎉"}
            </p>
          )}
          {rows.map((n) => (
            <button
              key={n.id}
              onClick={() => setSelectedId(n.id)}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-border-default px-4 py-3 text-left hover:bg-hover',
                selected?.id === n.id && 'bg-active',
                !n.read_at && !archived && 'bg-accent-soft/50',
              )}
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
                  {NOTIFICATION_VERBS[n.type]}
                  {n.count > 1 ? ` · ${n.count}×` : ''}
                </span>
                {n.record ? (
                  <span
                    className={cn('block truncate text-[12px]', n.record.deleted ? 'text-faint line-through' : 'text-muted')}
                  >
                    {n.record.title || 'Untitled'} · {n.record.database_name}
                  </span>
                ) : (
                  n.snippet && <span className="block truncate text-[12px] text-muted">{n.snippet}</span>
                )}
              </span>
              <span className="text-[11px] text-faint">{relativeTime(n.created_at)}</span>
            </button>
          ))}
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

        {/* PREVIEW — single-pane under md: hidden until a row's been tapped
            (mirrors the list above), full-bleed replacement rather than a
            squeezed side panel. Always shown at md+. */}
        <div
          className={cn(
            'min-w-0 flex-1 overflow-y-auto p-4 sm:p-6',
            !mobileShowDetail && 'hidden md:block',
          )}
        >
          {!selected ? (
            <p className="text-[13px] text-muted">Select a notification to preview it.</p>
          ) : (
            <div className="mx-auto max-w-2xl">
              <button
                onClick={() => setSelectedId(null)}
                className="mb-3 flex items-center gap-1 text-[13px] text-muted hover:text-ink md:hidden"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-2">
                  {selected.actor && (
                    <Avatar userId={selected.actor.id} name={selected.actor.name} image={selected.actor.image} size={32} />
                  )}
                  <div>
                    <p className="text-[14px] text-ink">
                      <span className="font-medium">
                        {selected.actor?.name ?? (selected.record ? 'Someone' : 'StoryOS')}
                      </span>{' '}
                      {NOTIFICATION_VERBS[selected.type]}
                    </p>
                    <p className="text-[12px] text-faint">{relativeTime(selected.created_at)} ago</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setArchivedMut.mutate({ id: selected.id, archive: !archived })
                    }
                  >
                    {archived ? <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> : <Archive className="mr-1 h-3.5 w-3.5" />}
                    {archived ? 'Restore' : 'Archive'}
                  </Button>
                  {selected.record && !selected.record.deleted && (
                    <Button size="sm" onClick={() => openRecord(selected)}>
                      <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open
                    </Button>
                  )}
                </div>
              </div>

              <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
                {selected.record && (
                  <>
                    <p className="text-[13px] font-medium text-ink">{selected.record.title || 'Untitled'}</p>
                    <p className="text-[12px] text-muted">{selected.record.database_name}</p>
                  </>
                )}
                {selected.snippet && (
                  <p
                    className={cn(
                      'text-[13px] text-ink-secondary',
                      selected.record && 'mt-2 border-t border-border-default pt-2',
                    )}
                  >
                    {selected.snippet}
                  </p>
                )}
                {selected.record?.deleted && (
                  <p className="mt-2 text-[12px] text-faint">This record has been deleted.</p>
                )}
              </div>

              {/* The killer mobile flow (mobile-responsive-plan.md): one tap to
                  approve or reject a gated agent action (#210, ADR-0010 §4).
                  min-h-12 (48px) full-width buttons — easy thumb targets, no
                  squeezing at 375px. */}
              {selected.type === 'approval_requested' && selected.record && !selected.record.deleted && (
                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    disabled={resolveRun.isPending}
                    onClick={() => resolveRun.mutate({ runId: selected.record!.id, verdict: 'reject' })}
                    className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border-default text-[14px] font-medium text-ink-secondary hover:bg-hover disabled:opacity-50"
                  >
                    <X className="h-4 w-4" /> Reject
                  </button>
                  <button
                    type="button"
                    disabled={resolveRun.isPending}
                    onClick={() => resolveRun.mutate({ runId: selected.record!.id, verdict: 'approve' })}
                    className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-primary text-[14px] font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50"
                  >
                    <Check className="h-4 w-4" /> Approve
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
