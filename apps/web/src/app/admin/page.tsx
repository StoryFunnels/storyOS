'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';

/**
 * MN-104's first (and so far only) superadmin surface — this page is the read
 * side of /admin/overview, /admin/workspaces, and MN-194's new /admin/costs,
 * plus #300/MN-216c's cross-workspace Runs view (the one mutation this page
 * has: Cancel).
 *
 * There is no separate admin shell yet, so this one page covers all of it
 * rather than standing up a second, parallel admin surface.
 *
 * Access is enforced entirely server-side (PlatformAdminGuard, 403 for a
 * non-admin) — this page just renders whatever the API returns, including
 * the error state below.
 */

interface AdminOverview {
  totalWorkspaces: number;
  totalUsers: number;
  totalRecords: number;
  workspacesByPlan: Record<string, number>;
  estimatedMrrUsd: number;
}

interface WorkspaceCostRow {
  workspaceId: string;
  name: string;
  plan: string;
  billableSeats: number;
  revenueCents: number;
  hostedCallsCostCents: number;
  storageCostCents: number;
  emailCostCents: number;
  aiCostCents: number;
  aiCostIsPlaceholder: boolean;
  variableCostCents: number;
  marginCents: number;
  marginPercent: number | null;
  belowMarginFloor: boolean;
}

interface AdminRunRow {
  id: string;
  number: number | null;
  title: string;
  workspaceId: string;
  workspaceName: string;
  agent: { id: string; title: string } | null;
  status: string | null;
  runClass: string | null;
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The only statuses AgentsService.adminCancelRun will actually flip — matches the API's own guard. */
const CANCELABLE_STATUSES = new Set(['Queued', 'Running', 'Waiting approval']);

/** MN-220 — the Community Marketplace moderation queue. */
interface PackSubmissionRow {
  id: string;
  slug: string;
  name: string;
  version: string;
  summary: string;
  vertical: string;
  license: string;
  attribution?: string;
  status: 'pending' | 'approved' | 'rejected';
  review_notes?: string;
  submitted_by: string;
  submitted_at: string;
}

interface PlanBlendedMargin {
  plan: string;
  workspaceCount: number;
  revenueCents: number;
  variableCostCents: number;
  allocatedFixedCostCents: number;
  totalCostCents: number;
  marginCents: number;
  marginPercent: number | null;
}

interface CostOverview {
  generatedAt: string;
  marginFloorPercent: number;
  fixedMonthlyInfraCostUsd: number;
  workspaces: WorkspaceCostRow[];
  byPlan: PlanBlendedMargin[];
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  business: 'Business',
  enterprise: 'Enterprise',
};

const PLAN_IDS = ['free', 'pro', 'business', 'enterprise'] as const;

/** #304 — the workspace picker for the Billing section (reuses the existing overview endpoint). */
interface AdminWorkspaceSummary {
  id: string;
  name: string;
  plan: string;
  billableSeats: number;
  includedSeats: number;
  recordCount: number;
  createdAt: string;
}

interface AdminEntitlementOverrideView {
  includedSeats: number | null;
  automationRunsPerMonth: number | null;
  maxWorkspaces: number | null;
  featureFlags: Record<string, boolean> | null;
  reason: string;
  expiresAt: string | null;
  createdBy: string;
  updatedAt: string;
}

interface AdminEntitlementOverrideEvent {
  id: string;
  actorUserId: string;
  action: 'set' | 'clear';
  snapshot: unknown;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
}

interface AdminWorkspaceBillingView {
  workspaceId: string;
  plan: string;
  status: string | null;
  stripeSubscriptionId: string | null;
  seats: number;
  currentPeriodEnd: string | null;
  override: AdminEntitlementOverrideView | null;
  auditTrail: AdminEntitlementOverrideEvent[];
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function pct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

/** Client-side CSV of the per-workspace rows — the "feed this back into MN-167" export the ticket asks for; no server endpoint needed for a table this size. */
function downloadCsv(rows: WorkspaceCostRow[]) {
  const header = [
    'workspace',
    'plan',
    'billable_seats',
    'revenue_usd',
    'hosted_calls_usd',
    'storage_usd',
    'email_usd',
    'ai_usd_estimated',
    'variable_cost_usd',
    'margin_usd',
    'margin_percent',
    'below_margin_floor',
  ];
  const lines = rows.map((r) =>
    [
      r.name.replace(/,/g, ' '),
      r.plan,
      r.billableSeats,
      (r.revenueCents / 100).toFixed(2),
      (r.hostedCallsCostCents / 100).toFixed(2),
      (r.storageCostCents / 100).toFixed(2),
      (r.emailCostCents / 100).toFixed(2),
      (r.aiCostCents / 100).toFixed(2),
      (r.variableCostCents / 100).toFixed(2),
      (r.marginCents / 100).toFixed(2),
      r.marginPercent === null ? '' : r.marginPercent.toFixed(1),
      r.belowMarginFloor,
    ].join(','),
  );
  const csv = [header.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `storyos-cost-margin-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminPage() {
  const qc = useQueryClient();
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  const overview = useQuery({
    queryKey: ['admin-overview'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/overview', {} as never);
      if (error) throw error;
      return data as unknown as AdminOverview;
    },
    retry: false,
  });

  const costs = useQuery({
    queryKey: ['admin-costs'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/costs', {} as never);
      if (error) throw error;
      return data as unknown as CostOverview;
    },
    retry: false,
  });

  const runs = useQuery({
    queryKey: ['admin-runs'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/runs', {} as never);
      if (error) throw error;
      return data as unknown as AdminRunRow[];
    },
    retry: false,
  });

  const cancelRun = useMutation({
    mutationFn: async (row: AdminRunRow) => {
      setCancelingId(row.id);
      await api.POST(`/api/v1/admin/runs/${row.workspaceId}/${row.id}/cancel` as never, {} as never);
    },
    onSettled: () => {
      setCancelingId(null);
      void qc.invalidateQueries({ queryKey: ['admin-runs'] });
    },
  });

  const packSubmissions = useQuery({
    queryKey: ['admin-pack-submissions'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/packs/submissions', {} as never);
      if (error) throw error;
      return data as unknown as PackSubmissionRow[];
    },
    retry: false,
  });

  const reviewSubmission = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject'; notes?: string }) => {
      const { error } = await api.POST(`/api/v1/admin/packs/submissions/${input.id}/review` as never, {
        body: { action: input.action, notes: input.notes },
      } as never);
      if (error) throw error;
    },
    onSuccess: (_data, input) => {
      toast.success(input.action === 'approve' ? 'Published' : 'Rejected');
      void qc.invalidateQueries({ queryKey: ['admin-pack-submissions'] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Review failed')),
  });

  if (overview.isLoading || costs.isLoading) {
    return <div className="p-8 text-[13px] text-muted">Loading…</div>;
  }

  if (overview.isError || costs.isError) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="mb-2 text-lg font-semibold text-ink">Admin</h1>
        <p className="text-[13px] text-muted">
          Platform admin access required. If you believe this is a mistake, ask an existing platform
          admin to grant you access.
        </p>
      </div>
    );
  }

  const o = overview.data!;
  const c = costs.data!;
  const flagged = c.workspaces.filter((w) => w.belowMarginFloor);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Admin</h1>
      <p className="mb-6 text-[13px] text-muted">Instance overview, plus MN-194 cost &amp; margin.</p>

      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Workspaces" value={String(o.totalWorkspaces)} />
        <Stat label="Users" value={String(o.totalUsers)} />
        <Stat label="Records" value={o.totalRecords.toLocaleString()} />
        <Stat label="Est. MRR" value={usd(o.estimatedMrrUsd * 100)} />
      </section>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">Cost &amp; Margin</h2>
          <span className="text-[12px] text-faint">
            Margin floor: {c.marginFloorPercent}% · Fixed infra: {usd(c.fixedMonthlyInfraCostUsd * 100)}/mo
            (allocated below)
          </span>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Hosted calls, storage, and email are measured from real usage counters. AI cost is
          <strong className="text-ink"> estimated — pending MN-214r&apos;s real managed-AI runtime</strong>;
          today it is $0 for every workspace because no managed run has executed yet.
        </p>

        {flagged.length > 0 && (
          <div className="mb-3 rounded-[var(--radius-control)] border border-warning/40 bg-warning/10 p-3 text-[13px] text-ink">
            {flagged.length} paying workspace{flagged.length === 1 ? '' : 's'} below the {c.marginFloorPercent}%
            margin floor — see flagged rows below.
          </div>
        )}

        <h3 className="mb-1 mt-4 text-[13px] font-medium text-ink-secondary">Blended margin by plan</h3>
        <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border-default">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-hover text-ink-secondary">
              <tr>
                <Th>Plan</Th>
                <Th>Workspaces</Th>
                <Th>Revenue</Th>
                <Th>Variable cost</Th>
                <Th>Allocated fixed</Th>
                <Th>Total cost</Th>
                <Th>Margin</Th>
                <Th>Margin %</Th>
              </tr>
            </thead>
            <tbody>
              {c.byPlan.map((p) => (
                <tr key={p.plan} className="border-t border-border-default">
                  <Td>{PLAN_LABEL[p.plan] ?? p.plan}</Td>
                  <Td>{p.workspaceCount}</Td>
                  <Td>{usd(p.revenueCents)}</Td>
                  <Td>{usd(p.variableCostCents)}</Td>
                  <Td>{usd(p.allocatedFixedCostCents)}</Td>
                  <Td>{usd(p.totalCostCents)}</Td>
                  <Td className={p.marginCents < 0 ? 'text-error' : undefined}>{usd(p.marginCents)}</Td>
                  <Td>{pct(p.marginPercent)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mb-1 mt-6 flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium text-ink-secondary">Per-workspace</h3>
          <button
            type="button"
            onClick={() => downloadCsv(c.workspaces)}
            className="rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover"
          >
            Download CSV
          </button>
        </div>
        <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border-default">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-hover text-ink-secondary">
              <tr>
                <Th>Workspace</Th>
                <Th>Plan</Th>
                <Th>Revenue</Th>
                <Th>Hosted calls</Th>
                <Th>Storage</Th>
                <Th>Email</Th>
                <Th>AI (est.)</Th>
                <Th>Margin</Th>
                <Th>Margin %</Th>
                <Th>Flag</Th>
              </tr>
            </thead>
            <tbody>
              {c.workspaces.map((w) => (
                <tr key={w.workspaceId} className="border-t border-border-default">
                  <Td>{w.name}</Td>
                  <Td>{PLAN_LABEL[w.plan] ?? w.plan}</Td>
                  <Td>{usd(w.revenueCents)}</Td>
                  <Td>{usd(w.hostedCallsCostCents)}</Td>
                  <Td>{usd(w.storageCostCents)}</Td>
                  <Td>{usd(w.emailCostCents)}</Td>
                  <Td>{usd(w.aiCostCents)}</Td>
                  <Td className={w.marginCents < 0 ? 'text-error' : undefined}>{usd(w.marginCents)}</Td>
                  <Td>{pct(w.marginPercent)}</Td>
                  <Td>
                    {w.belowMarginFloor && (
                      <span className="rounded-full bg-error/10 px-2 py-0.5 text-[11px] font-medium text-error">
                        Below floor
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">Runs</h2>
          <span className="text-[12px] text-faint">#300/MN-216c — every workspace, read-only + kill-switch</span>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Agent runs across every workspace. Cancel is a status flip only — it never touches what the
          run has already applied.
        </p>

        {runs.isLoading && <p className="text-[13px] text-muted">Loading…</p>}
        {runs.isError && <p className="text-[13px] text-muted">Could not load runs.</p>}
        {runs.data && (
          <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border-default">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-hover text-ink-secondary">
                <tr>
                  <Th>Workspace</Th>
                  <Th>Agent</Th>
                  <Th>Run</Th>
                  <Th>Status</Th>
                  <Th>Run class</Th>
                  <Th>Trigger</Th>
                  <Th>Started</Th>
                  <Th>Finished</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {runs.data.length === 0 && (
                  <tr>
                    <Td className="text-faint">No runs on this instance yet.</Td>
                  </tr>
                )}
                {runs.data.map((r) => {
                  const cancelable = r.status !== null && CANCELABLE_STATUSES.has(r.status);
                  return (
                    <tr key={r.id} className="border-t border-border-default">
                      <Td>{r.workspaceName}</Td>
                      <Td>{r.agent?.title ?? '—'}</Td>
                      <Td>{r.title}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td>{r.runClass ?? '—'}</Td>
                      <Td>{r.trigger ?? '—'}</Td>
                      <Td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</Td>
                      <Td>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}</Td>
                      <Td>
                        {cancelable && (
                          <button
                            type="button"
                            disabled={cancelRun.isPending && cancelingId === r.id}
                            onClick={() => cancelRun.mutate(r)}
                            className="rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover disabled:opacity-50"
                          >
                            {cancelRun.isPending && cancelingId === r.id ? 'Canceling…' : 'Cancel'}
                          </button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink">Pack Marketplace</h2>
          <span className="text-[12px] text-faint">MN-220 — submissions awaiting (or having had) review</span>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          v1 is curated: nothing here is listed on the marketplace until approved.
        </p>

        {packSubmissions.isLoading && <p className="text-[13px] text-muted">Loading…</p>}
        {packSubmissions.isError && <p className="text-[13px] text-muted">Could not load submissions.</p>}
        {packSubmissions.data && (
          <div className="flex flex-col gap-2">
            {packSubmissions.data.length === 0 && (
              <p className="text-[13px] text-faint">No submissions yet.</p>
            )}
            {packSubmissions.data.map((s) => (
              <div key={s.id} className="rounded-[var(--radius-control)] border border-border-default bg-card p-3">
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-medium text-ink">
                    {s.name} v{s.version} <span className="text-faint">({s.slug})</span>
                  </p>
                  <SubmissionStatusBadge status={s.status} />
                </div>
                <p className="mt-0.5 text-[12px] text-muted">{s.summary}</p>
                <p className="mt-1 text-[12px] text-faint">
                  {s.vertical} · {s.license}
                  {s.attribution ? ` · by ${s.attribution}` : ''} · submitted{' '}
                  {new Date(s.submitted_at).toLocaleDateString()}
                </p>
                {s.review_notes && (
                  <p className="mt-1 text-[12px] text-ink-secondary">&ldquo;{s.review_notes}&rdquo;</p>
                )}
                {s.status === 'pending' && (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={reviewSubmission.isPending}
                      onClick={() => reviewSubmission.mutate({ id: s.id, action: 'approve' })}
                      className="rounded-[var(--radius-control)] bg-success/10 px-2 py-1 text-[12px] font-medium text-success hover:bg-success/20 disabled:opacity-50"
                    >
                      Approve &amp; publish
                    </button>
                    <button
                      type="button"
                      disabled={reviewSubmission.isPending}
                      onClick={() => {
                        const notes = window.prompt('Reason for rejecting (shown to the author):') ?? undefined;
                        reviewSubmission.mutate({ id: s.id, action: 'reject', notes });
                      }}
                      className="rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <BillingSection />
    </div>
  );
}

/**
 * #304 — the plan/entitlement-override admin surface admin.controller.ts's
 * own doc comment deferred as its own careful pass. Split out of AdminPage
 * for its own local state (the workspace picker + two forms) rather than
 * crowding the top-level component with it.
 */
function BillingSection() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [plan, setPlan] = useState<(typeof PLAN_IDS)[number]>('enterprise');
  const [planReason, setPlanReason] = useState('');
  const [planExpiresAt, setPlanExpiresAt] = useState('');
  const [includedSeats, setIncludedSeats] = useState('');
  const [automationRunsPerMonth, setAutomationRunsPerMonth] = useState('');
  const [maxWorkspaces, setMaxWorkspaces] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideExpiresAt, setOverrideExpiresAt] = useState('');

  const workspaces = useQuery({
    queryKey: ['admin-workspaces'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/admin/workspaces', {} as never);
      if (error) throw error;
      return data as unknown as AdminWorkspaceSummary[];
    },
    retry: false,
  });

  const activeWorkspaceId = workspaceId || workspaces.data?.[0]?.id || '';

  const billing = useQuery({
    queryKey: ['admin-workspace-billing', activeWorkspaceId],
    queryFn: async () => {
      const { data, error } = await api.GET(
        `/api/v1/admin/workspaces/${activeWorkspaceId}/billing` as never,
        {} as never,
      );
      if (error) throw error;
      return data as unknown as AdminWorkspaceBillingView;
    },
    enabled: activeWorkspaceId.length > 0,
    retry: false,
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['admin-workspace-billing', activeWorkspaceId] });
    void qc.invalidateQueries({ queryKey: ['admin-workspaces'] });
  }

  const setPlanMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(`/api/v1/admin/workspaces/${activeWorkspaceId}/plan` as never, {
        body: {
          plan,
          reason: planReason,
          expires_at: planExpiresAt ? new Date(planExpiresAt).toISOString() : undefined,
        },
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Plan set to ${PLAN_LABEL[plan] ?? plan}`);
      setPlanReason('');
      setPlanExpiresAt('');
      invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Plan change failed')),
  });

  const setOverrideMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST(
        `/api/v1/admin/workspaces/${activeWorkspaceId}/entitlement-overrides` as never,
        {
          body: {
            includedSeats: includedSeats ? Number(includedSeats) : undefined,
            automationRunsPerMonth: automationRunsPerMonth ? Number(automationRunsPerMonth) : undefined,
            maxWorkspaces: maxWorkspaces ? Number(maxWorkspaces) : undefined,
            reason: overrideReason,
            expires_at: overrideExpiresAt ? new Date(overrideExpiresAt).toISOString() : undefined,
          },
        } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Entitlement override saved');
      setIncludedSeats('');
      setAutomationRunsPerMonth('');
      setMaxWorkspaces('');
      setOverrideReason('');
      setOverrideExpiresAt('');
      invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Override change failed')),
  });

  const clearOverrideMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await api.DELETE(
        `/api/v1/admin/workspaces/${activeWorkspaceId}/entitlement-overrides` as never,
        { body: { reason } } as never,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Override cleared');
      invalidate();
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Clear failed')),
  });

  const b = billing.data;

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-ink">Billing</h2>
        <span className="text-[12px] text-faint">
          #304 — comp/Enterprise grants; never touches live Stripe
        </span>
      </div>
      <p className="mb-3 text-[13px] text-muted">
        Sets this workspace&apos;s plan and entitlement overrides directly in StoryOS&apos;s own tables —
        no Stripe subscription is ever created, changed, or canceled here. Every change requires a reason
        and is recorded below.
      </p>

      <div className="mb-4">
        <label className="mb-1 block text-[12px] text-ink-secondary" htmlFor="billing-workspace">
          Workspace
        </label>
        {workspaces.isLoading && <p className="text-[13px] text-muted">Loading workspaces…</p>}
        {workspaces.isError && <p className="text-[13px] text-muted">Could not load workspaces.</p>}
        {workspaces.data && (
          <select
            id="billing-workspace"
            value={activeWorkspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="h-9 w-full max-w-md rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-[13px] text-ink"
          >
            {workspaces.data.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} — {PLAN_LABEL[w.plan] ?? w.plan}
              </option>
            ))}
          </select>
        )}
      </div>

      {billing.isLoading && activeWorkspaceId && <p className="text-[13px] text-muted">Loading billing…</p>}
      {billing.isError && <p className="text-[13px] text-muted">Could not load billing for this workspace.</p>}

      {b && (
        <>
          <div className="mb-4 rounded-[var(--radius-control)] border border-border-default bg-card p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span>
                Plan: <strong className="text-ink">{PLAN_LABEL[b.plan] ?? b.plan}</strong>
              </span>
              <span className="text-faint">
                Stripe: {b.stripeSubscriptionId ? b.stripeSubscriptionId : 'none (not Stripe-backed)'}
              </span>
              {b.currentPeriodEnd && (
                <span className="text-faint">Until {new Date(b.currentPeriodEnd).toLocaleDateString()}</span>
              )}
            </div>
            {b.override ? (
              <div className="mt-2 border-t border-border-default pt-2 text-[13px]">
                <p className="font-medium text-ink">Active entitlement override</p>
                <p className="mt-0.5 text-[12px] text-muted">
                  {b.override.includedSeats !== null && <>Seats: {b.override.includedSeats} · </>}
                  {b.override.automationRunsPerMonth !== null && (
                    <>Automation runs/mo: {b.override.automationRunsPerMonth} · </>
                  )}
                  {b.override.maxWorkspaces !== null && <>Max workspaces: {b.override.maxWorkspaces} · </>}
                  {b.override.expiresAt
                    ? `expires ${new Date(b.override.expiresAt).toLocaleDateString()}`
                    : 'never expires'}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-secondary">
                  &ldquo;{b.override.reason}&rdquo; — {b.override.createdBy}
                </p>
                <button
                  type="button"
                  disabled={clearOverrideMutation.isPending}
                  onClick={async () => {
                    const reason = window.prompt('Reason for clearing this override (required):');
                    if (!reason?.trim()) return;
                    if (
                      !(await confirm({
                        title: 'Clear entitlement override?',
                        message: `${b.override ? PLAN_LABEL[b.plan] ?? b.plan : ''} plan defaults apply immediately once cleared.`,
                        confirmLabel: 'Clear override',
                        danger: true,
                      }))
                    )
                      return;
                    clearOverrideMutation.mutate(reason.trim());
                  }}
                  className="mt-2 rounded-[var(--radius-control)] border border-border-default px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover disabled:opacity-50"
                >
                  {clearOverrideMutation.isPending ? 'Clearing…' : 'Clear override'}
                </button>
              </div>
            ) : (
              <p className="mt-2 border-t border-border-default pt-2 text-[12px] text-faint">
                No entitlement override — plan defaults apply.
              </p>
            )}
          </div>

          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            <form
              className="rounded-[var(--radius-control)] border border-border-default bg-card p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!planReason.trim()) return;
                if (
                  !(await confirm({
                    title: `Set plan to ${PLAN_LABEL[plan] ?? plan}?`,
                    message: `${b.override ? 'This workspace has an active override, which is unaffected by a plan change.' : ''} This bypasses Stripe entirely.`,
                    confirmLabel: 'Set plan',
                  }))
                )
                  return;
                setPlanMutation.mutate();
              }}
            >
              <p className="mb-2 text-[13px] font-medium text-ink">Change plan</p>
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value as (typeof PLAN_IDS)[number])}
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              >
                {PLAN_IDS.map((p) => (
                  <option key={p} value={p}>
                    {PLAN_LABEL[p]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required
                placeholder="Reason (required, audited)"
                value={planReason}
                onChange={(e) => setPlanReason(e.target.value)}
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
              />
              <input
                type="date"
                value={planExpiresAt}
                onChange={(e) => setPlanExpiresAt(e.target.value)}
                title="Expires (optional — record-keeping only, not auto-enforced)"
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              />
              <button
                type="submit"
                disabled={setPlanMutation.isPending || !planReason.trim()}
                className="rounded-[var(--radius-control)] bg-primary px-2 py-1 text-[12px] font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50"
              >
                {setPlanMutation.isPending ? 'Setting…' : 'Set plan'}
              </button>
            </form>

            <form
              className="rounded-[var(--radius-control)] border border-border-default bg-card p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!overrideReason.trim()) return;
                if (
                  !(await confirm({
                    title: 'Set entitlement override?',
                    message: 'Only the fields you fill in are changed; the rest keep whatever is already set.',
                    confirmLabel: 'Save override',
                  }))
                )
                  return;
                setOverrideMutation.mutate();
              }}
            >
              <p className="mb-2 text-[13px] font-medium text-ink">Entitlement override</p>
              <input
                type="number"
                min={1}
                placeholder="Included seats"
                value={includedSeats}
                onChange={(e) => setIncludedSeats(e.target.value)}
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
              />
              <input
                type="number"
                min={1}
                placeholder="Automation runs / month"
                value={automationRunsPerMonth}
                onChange={(e) => setAutomationRunsPerMonth(e.target.value)}
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
              />
              <input
                type="number"
                min={1}
                placeholder="Max workspaces"
                value={maxWorkspaces}
                onChange={(e) => setMaxWorkspaces(e.target.value)}
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
              />
              <input
                type="text"
                required
                placeholder="Reason (required, audited)"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink placeholder:text-faint"
              />
              <input
                type="date"
                value={overrideExpiresAt}
                onChange={(e) => setOverrideExpiresAt(e.target.value)}
                title="Expires (optional — lazily enforced on read, never auto-swept)"
                className="mb-2 h-8 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
              />
              <button
                type="submit"
                disabled={setOverrideMutation.isPending || !overrideReason.trim()}
                className="rounded-[var(--radius-control)] bg-primary px-2 py-1 text-[12px] font-medium text-[var(--text-on-dark)] hover:bg-primary-hover disabled:opacity-50"
              >
                {setOverrideMutation.isPending ? 'Saving…' : 'Save override'}
              </button>
            </form>
          </div>

          <h3 className="mb-1 mt-4 text-[13px] font-medium text-ink-secondary">Audit trail</h3>
          <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border-default">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-hover text-ink-secondary">
                <tr>
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Reason</Th>
                </tr>
              </thead>
              <tbody>
                {b.auditTrail.length === 0 && (
                  <tr>
                    <Td className="text-faint">No changes recorded for this workspace yet.</Td>
                  </tr>
                )}
                {b.auditTrail.map((e) => (
                  <tr key={e.id} className="border-t border-border-default">
                    <Td>{new Date(e.createdAt).toLocaleString()}</Td>
                    <Td>{e.actorUserId}</Td>
                    <Td>{e.action}</Td>
                    <Td>{e.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SubmissionStatusBadge({ status }: { status: PackSubmissionRow['status'] }) {
  const tone =
    status === 'approved'
      ? 'bg-success/10 text-success'
      : status === 'rejected'
        ? 'bg-error/10 text-error'
        : 'bg-warning/10 text-warning';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-faint">—</span>;
  const tone =
    status === 'Failed'
      ? 'bg-error/10 text-error'
      : status === 'Succeeded'
        ? 'bg-success/10 text-success'
        : status === 'Canceled'
          ? 'bg-hover text-ink-secondary'
          : 'bg-warning/10 text-warning';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-border-default bg-card p-3">
      <p className="text-[12px] text-faint">{label}</p>
      <p className="text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 text-ink ${className ?? ''}`}>{children}</td>;
}
