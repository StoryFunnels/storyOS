'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, ArchiveRestore, Check, ExternalLink, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ApprovalGate, ApprovalRowTag, ApprovalRuleTail, useApprovalList } from '@/components/approvals/use-approval-view';
import { PageHeading } from '@/components/page-heading';
import { CountBadge } from '@/components/sidebar-ai-section';
import { APPROVALS_LIST_LIMIT } from '@/lib/sidebar-ai';
import { INBOX_TABS, inboxSubtitle, inboxTabQuery, waitingApprovalLabel, type InboxTabKey } from '@/components/inbox-page-model';
import { notificationWho } from '@/components/approvals/caused-by';
import { WhoAvatar } from '@/components/approvals/who';
import { PostApprovalPreview } from '@/components/social/post-approval-preview';
import { Textarea } from '@/components/ui/textarea';
import { MyWorkEmailOffer } from '@/components/my-work/my-work-email-offer';
import { cn } from '@/lib/utils';
import { notificationVerb } from '@/components/notification-verbs';
import {
  INBOX_ROW_AVATAR_SIZE,
  INBOX_ROW_LINE,
  INBOX_ROW_PADDING,
  INBOX_ROW_TIME_CLASS,
  UnreadDot,
  isUnreadRow,
  notificationActorClass,
  notificationRowStateClass,
} from '@/components/notification-unread';
import {
  StagedActionView,
  useResolveRun,
  useResolveApproval,
  useStagedAction,
  useUnreadCount,
  type NotificationRow,
} from '@/components/inbox-panel';

interface NotificationsPage {
  data: NotificationRow[];
  next_cursor: string | null;
}

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
  const [tab, setTab] = useState<InboxTabKey>('all');
  const { type, archived } = inboxTabQuery(tab);
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

  // Ticket #1279: the page's own two numbers, both real reads. The subtitle is the unread count; the Approvals tab's gold
  // number is the approval notifications whose approval is still waiting (a lower bound, said so, when either list is paged).
  const unreadCount = useUnreadCount(ws);
  const approvalRows = useQuery({
    queryKey: ['inbox', ws, 'approvals-waiting'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/notifications', {
        params: { path: { ws }, query: { type: 'action_approval_requested' } },
      } as never);
      if (error) throw error;
      return data as unknown as NotificationsPage;
    },
  });
  const pendingApprovals = useApprovalList(ws, 'pending');
  const approvalsLabel = waitingApprovalLabel({
    rows: approvalRows.data?.data,
    pendingIds: pendingApprovals.data ? new Set(pendingApprovals.data.map((a) => a.id)) : undefined,
    moreRows: Boolean(approvalRows.data?.next_cursor),
    pendingCapped: (pendingApprovals.data?.length ?? 0) >= APPROVALS_LIST_LIMIT,
  });

  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.data), [list.data]);
  // Desktop (md+) auto-previews rows[0] so the two-pane layout never shows an
  // empty right pane. Under md there is only one pane, so it must start on the
  // LIST — auto-previewing here would skip straight to a detail view the user
  // never tapped into. selectedId starts null and is only set by an explicit
  // tap, so "has the user tapped a row" and "what does desktop preview" are two
  // different questions answered from the same piece of state.
  const selected = rows.find((n) => n.id === selectedId) ?? rows[0] ?? null;
  const selectedWho = selected ? notificationWho(selected) : null;
  const mobileShowDetail = selectedId !== null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['inbox', ws] });
    void qc.invalidateQueries({ queryKey: ['notifications', ws] });
    void qc.invalidateQueries({ queryKey: ['unread', ws] });
  };

  const resolveRun = useResolveRun(ws, invalidate);
  const resolveApproval = useResolveApproval(ws, invalidate);
  // Shared draft for the reject-reason box — only one approval is previewed at a
  // time, so the agent-run gate (#115) and the automation-action gate (MN-255)
  // can share it.
  const [rejectReason, setRejectReason] = useState('');

  // #115/#114: for a live agent-approval row, pull its staged action + steps so
  // the preview shows the full proposal inline, not just the snippet.
  const isAgentApproval =
    selected?.type === 'approval_requested' && Boolean(selected.record) && !selected.record?.deleted;
  const staged = useStagedAction(ws, isAgentApproval ? selected?.record?.id : null, isAgentApproval);

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
      <div className="flex min-h-0 flex-1">
        {/* LIST — single-pane under md: hidden once a row's been tapped, so the
            detail view replaces it instead of squeezing beside it. Always shown
            at md+ where both panes fit. The title, the email offer and the tabs live in THIS pane, above the rows,
            as in the design reference (ticket #1279 items 3, 4, 6) — not in a full-width toolbar over both panes. */}
        <div
          className={cn(
            'w-full overflow-y-auto border-r border-border-default md:max-w-md md:shrink-0',
            mobileShowDetail && 'hidden md:block',
          )}
        >
          <PageHeading title="Inbox" subtitle={inboxSubtitle(unreadCount.data)} className="px-5 pb-3.5 pt-5" />
          {/* Ticket #1252: the one-time "email me my work" offer; renders nothing unless every condition is known and true.
              Above the tabs (ticket #1279 item 6), where the design reference puts it. */}
          <MyWorkEmailOffer ws={ws} />
          {/* Underlined tabs, 32px, a 2px ink underline on the selected one; scrolls instead of clipping on a narrow pane. */}
          <div role="tablist" aria-label="Notification type" className="mx-5 mb-2 flex gap-0.5 overflow-x-auto border-b border-border-default">
            {INBOX_TABS.map((t) => {
              const selectedTab = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab}
                  onClick={() => {
                    setTab(t.key);
                    setSelectedId(null);
                  }}
                  className={cn(
                    '-mb-px flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-label',
                    selectedTab ? 'border-ink font-semibold text-ink' : 'border-transparent text-muted hover:text-ink',
                  )}
                >
                  {t.label}
                  {t.key === 'action_approval_requested' && approvalsLabel && (
                    <CountBadge count={approvalsLabel} hint="approvals waiting for a decision" agent />
                  )}
                </button>
              );
            })}
          </div>
          {rows.length === 0 && !list.isLoading && (
            <p className="p-6 text-center text-body text-muted">
              {archived ? 'Nothing archived.' : "You're all caught up 🎉"}
            </p>
          )}
          {rows.map((n) => {
            const unread = isUnreadRow(n, { archivedView: archived });
            return (
            <button
              key={n.id}
              onClick={() => setSelectedId(n.id)}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-border-default text-left hover:bg-hover',
                INBOX_ROW_PADDING,
                notificationRowStateClass({ unread, selected: selected?.id === n.id }),
              )}
            >
              <WhoAvatar who={notificationWho(n)} size={INBOX_ROW_AVATAR_SIZE} />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-body text-ink', INBOX_ROW_LINE)}>
                  {/* Bare notifications (#263) have no actor — a person didn't do this, StoryOS did. An agent-caused approval (#1193) names the agent and run. */}
                  <span className={notificationActorClass(unread)}>{notificationWho(n).name}</span>{' '}
                  {notificationVerb(n.type)}
                  {n.type === 'action_approval_requested' && n.ref_id && <ApprovalRuleTail ws={ws} approvalId={n.ref_id} />}
                  {n.count > 1 ? ` · ${n.count}×` : ''}
                  {n.type === 'action_approval_requested' && n.ref_id && <ApprovalRowTag ws={ws} approvalId={n.ref_id} />}
                </span>
                {n.record ? (
                  <span
                    className={cn('block truncate text-label', INBOX_ROW_LINE, n.record.deleted ? 'text-faint line-through' : 'text-muted')}
                  >
                    {n.record.title || 'Untitled'} · {n.record.database_name}
                  </span>
                ) : (
                  n.snippet && <span className={cn('block truncate text-label text-muted', INBOX_ROW_LINE)}>{n.snippet}</span>
                )}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className={INBOX_ROW_TIME_CLASS}>{relativeTime(n.created_at)}</span>
                {unread && <UnreadDot />}
              </span>
            </button>
            );
          })}
          {list.hasNextPage && (
            <button
              onClick={() => list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              className="w-full py-3 text-center text-label text-muted hover:bg-hover disabled:opacity-50"
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
            <p className="text-body text-muted">Select a notification to preview it.</p>
          ) : (
            <div className="mx-auto max-w-2xl">
              <button
                onClick={() => setSelectedId(null)}
                className="mb-3 flex items-center gap-1 text-body text-muted hover:text-ink md:hidden"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-2">
                  {selectedWho!.kind !== 'other' && <WhoAvatar who={selectedWho!} size={32} />}
                  <div>
                    <p className="text-prose text-ink">
                      <span className="font-medium">{selectedWho!.name}</span>{' '}
                      {notificationVerb(selected.type)}
                      {selected.type === 'action_approval_requested' && selected.ref_id && <ApprovalRuleTail ws={ws} approvalId={selected.ref_id} />}
                    </p>
                    <p className="text-label text-faint">{relativeTime(selected.created_at)} ago</p>
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
                    <p className="text-body font-medium text-ink">{selected.record.title || 'Untitled'}</p>
                    <p className="text-label text-muted">{selected.record.database_name}</p>
                  </>
                )}
                {selected.snippet && (
                  <p
                    className={cn(
                      'text-body text-ink-secondary',
                      selected.record && 'mt-2 border-t border-border-default pt-2',
                    )}
                  >
                    {selected.snippet}
                  </p>
                )}
                {/* #826 — a post_social approval shows the final text, the account and the image, not a one-line snippet. */}
                {selected.type === 'action_approval_requested' && selected.ref_id && selected.record && !selected.record.deleted && (
                  <PostApprovalPreview
                    ws={ws}
                    approvalId={selected.ref_id}
                    db={selected.record.database_id}
                    rec={selected.record.id}
                  />
                )}
                {selected.record?.deleted && (
                  <p className="mt-2 text-label text-faint">This item has been deleted.</p>
                )}
              </div>

              {/* The killer mobile flow (mobile-responsive-plan.md): approve or
                  reject a gated agent action (#210, ADR-0010 §4). #115: the full
                  proposal (staged action + steps) renders inline, and Reject
                  carries an optional reason — the same shape as the
                  automation-action gate below. min-h-12 (48px) full-width
                  buttons — easy thumb targets, no squeezing at 375px. */}
              {selected.type === 'approval_requested' && selected.record && !selected.record.deleted && (
                <div className="mt-4 flex flex-col gap-2">
                  {staged.isLoading && (
                    <p className="text-label text-muted">Loading the proposed action…</p>
                  )}
                  {staged.data && <StagedActionView staged={staged.data} />}
                  <Textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason if rejecting (optional)"
                    rows={2}
                    size="default"
                    className="min-h-0 w-full bg-app px-2.5"
                  />
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={resolveRun.isPending}
                      onClick={() => {
                        resolveRun.mutate({
                          runId: selected.record!.id,
                          verdict: 'reject',
                          reason: rejectReason || undefined,
                        });
                        setRejectReason('');
                      }}
                      className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border-default text-prose font-medium text-ink-secondary hover:bg-hover disabled:opacity-50"
                    >
                      <X className="h-4 w-4" /> Reject
                    </button>
                    <button
                      type="button"
                      disabled={resolveRun.isPending}
                      onClick={() => resolveRun.mutate({ runId: selected.record!.id, verdict: 'approve' })}
                      className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-primary text-prose font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" /> Approve
                    </button>
                  </div>
                </div>
              )}

              {/* MN-255: the automation-action approval gate — own entity
                  (ref_id, not the notification's own record), Reject carries
                  an optional reason. Renders whenever there's still an
                  approval to decide (no record required — a webhook-
                  triggered gated action has none). */}
              {selected.type === 'action_approval_requested' && selected.ref_id && (
                <ApprovalGate ws={ws} approvalId={selected.ref_id}>
                <div className="mt-4 flex flex-col gap-2">
                  <Textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason if rejecting (optional)"
                    rows={2}
                    size="default"
                    className="min-h-0 w-full bg-app px-2.5"
                  />
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={resolveApproval.isPending}
                      onClick={() => {
                        resolveApproval.mutate({
                          approvalId: selected.ref_id!,
                          verdict: 'reject',
                          reason: rejectReason || undefined,
                        });
                        setRejectReason('');
                      }}
                      className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border-default text-prose font-medium text-ink-secondary hover:bg-hover disabled:opacity-50"
                    >
                      <X className="h-4 w-4" /> Reject
                    </button>
                    <button
                      type="button"
                      disabled={resolveApproval.isPending}
                      onClick={() => resolveApproval.mutate({ approvalId: selected.ref_id!, verdict: 'approve' })}
                      className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-primary text-prose font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" /> Approve
                    </button>
                  </div>
                </div>
                </ApprovalGate>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
