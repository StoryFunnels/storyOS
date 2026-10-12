'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useMembers } from '@/components/table-view/use-table-data';
import { approvalView, decidedSummary, type ApprovalRow, type ApprovalView } from './approval-state';

/**
 * One request per list, shared by every row on screen (keys are workspace-scoped, not row-scoped).
 * Keys start with `approvals` so `useResolveApproval` can refresh them all after a decision.
 */
function useApprovalList(ws: string, status: 'pending' | 'all') {
  return useQuery({
    queryKey: ['approvals', ws, status],
    enabled: Boolean(ws),
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/approvals', {
        params: { path: { ws }, query: status === 'pending' ? { status: 'pending' } : {} },
      } as never);
      if (error) throw error;
      return data as unknown as ApprovalRow[];
    },
  });
}

/**
 * The state of one approval. If the lists cannot be READ, the controls are offered (the server stays
 * the authority and refuses an invalid decision with a reason): a failed read must not take away
 * someone's ability to approve. An absent answer is not a "decided" answer.
 */
export function useApprovalView(ws: string, approvalId: string | null | undefined): ApprovalView {
  const pending = useApprovalList(ws, 'pending');
  const all = useApprovalList(ws, 'all');
  if (!approvalId) return { kind: 'loading' };
  if (pending.isError || all.isError) return { kind: 'pending' };
  return approvalView({ id: approvalId, pending: pending.data, all: all.data });
}

/** The decided state, shown where the Approve/Reject buttons would be. */
export function DecidedApproval({ ws, view }: { ws: string; view: Extract<ApprovalView, { kind: 'decided' }> }) {
  const members = useMembers(ws, true);
  const nameOf = (id: string) => members.data?.find((m) => m.user.id === id)?.user.name;
  const Icon = view.status === 'approved' ? Check : view.status === 'rejected' ? X : null;
  return (
    <p
      role="status"
      data-testid="approval-decided"
      className="mt-2 flex items-center gap-1.5 rounded-[var(--radius-control)] border border-border-default bg-hover px-2.5 py-2 text-label font-medium text-ink-secondary"
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      {decidedSummary(view, nameOf, (iso) => new Date(iso).toLocaleDateString(), members.isSuccess)}
    </p>
  );
}

/**
 * Live controls only while the approval is actually waiting. Decided → the decided state. Still
 * loading → nothing (a control that appears and then vanishes is its own defect).
 */
export function ApprovalGate({ ws, approvalId, children }: { ws: string; approvalId: string; children: ReactNode }) {
  const view = useApprovalView(ws, approvalId);
  if (view.kind === 'pending') return <>{children}</>;
  if (view.kind === 'decided') return <DecidedApproval ws={ws} view={view} />;
  return null;
}

/** A short "Approved" / "Rejected" tag for a list row, so a decided approval does not look like it is still waiting. */
export function ApprovalRowTag({ ws, approvalId }: { ws: string; approvalId: string }) {
  const view = useApprovalView(ws, approvalId);
  if (view.kind !== 'decided') return null;
  const text = view.status === 'approved' ? 'Approved' : view.status === 'rejected' ? 'Rejected' : view.status === 'expired' ? 'Expired' : 'Decided';
  return (
    <span data-testid="approval-row-tag" className="ml-1.5 inline-flex h-4 items-center rounded-[var(--radius-chip)] bg-hover px-1.5 text-micro font-medium text-ink-secondary">
      {text}
    </span>
  );
}
