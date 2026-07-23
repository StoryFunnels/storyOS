'use client';

import { useParams } from 'next/navigation';
import posthog from 'posthog-js';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** MN-107 plan catalogue, mirrored for display — prices are fixed and public. */
const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  business: 'Business',
  enterprise: 'Enterprise',
};
const PLAN_PRICE: Record<string, string> = {
  free: '$0',
  pro: '$29/mo',
  business: '$99/mo per workspace',
  enterprise: 'Custom',
};

interface BillingStatus {
  plan: 'free' | 'pro' | 'business' | 'enterprise';
  status: string | null;
  seats: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  enabled: boolean;
  usage: { automationRunsThisMonth: number; billableSeats: number };
  limits: { automationRunsPerMonth: number | null; includedSeats: number | null };
}

export default function BillingPage() {
  const { ws } = useParams<{ ws: string }>();

  const billing = useQuery({
    queryKey: ['billing-status', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/billing', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as BillingStatus;
    },
  });

  const checkout = useMutation({
    mutationFn: async (plan: 'pro' | 'business') => {
      posthog.capture('plan_upgrade_clicked', { plan });
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/billing/checkout', {
        params: { path: { ws } },
        body: { plan },
      } as never);
      if (error) throw error;
      return data as unknown as { url: string };
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: () => toast.error('Could not start checkout — is billing configured on this instance?'),
  });

  const portal = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/billing/portal', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { url: string };
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: () => toast.error('Could not open the billing portal'),
  });

  const startTrial = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/billing/trial', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      posthog.capture('trial_started');
      void billing.refetch();
    },
    onError: () => toast.error('Could not start the trial'),
  });

  if (billing.isLoading) return <div className="p-4 text-[13px] text-muted sm:p-8">Loading…</div>;
  if (!billing.data) return null;
  const b = billing.data;

  const trialDaysLeft = b.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86_400_000))
    : null;
  const isTrialing = b.status === 'trialing' && trialDaysLeft !== null;
  const neverStartedTrial = b.plan === 'free' && !b.trialEndsAt;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink">Billing</h1>
      <p className="mb-6 text-[13px] text-muted">Plan, usage, and payment for this workspace.</p>

      <div className="flex flex-col gap-8">
        {isTrialing && (
          <div className="rounded-[var(--radius-control)] border border-border-default bg-card p-4 text-[13px]">
            <p className="font-medium text-ink">
              {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left of your Pro trial
            </p>
            <p className="mt-1 text-muted">
              No card required. If it ends without upgrading, this workspace moves to Free —
              nothing is locked or deleted, and every feature stays reachable.
            </p>
          </div>
        )}

        <Section title="Plan" description="Your current plan and price.">
          <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-border-default bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-ink">{PLAN_LABEL[b.plan]}</p>
              <p className="text-[13px] text-muted">{PLAN_PRICE[b.plan]}</p>
              {b.currentPeriodEnd && (
                <p className="mt-1 text-[12px] text-faint">
                  {b.cancelAtPeriodEnd ? 'Cancels' : 'Renews'} {new Date(b.currentPeriodEnd).toLocaleDateString()}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {neverStartedTrial && (
                <Button variant="secondary" onClick={() => startTrial.mutate()} disabled={startTrial.isPending}>
                  Start 30-day Pro trial
                </Button>
              )}
              {b.plan !== 'pro' && b.plan !== 'business' && (
                <Button onClick={() => checkout.mutate('pro')} disabled={checkout.isPending}>
                  Upgrade to Pro
                </Button>
              )}
              {b.plan !== 'business' && (
                <Button onClick={() => checkout.mutate('business')} disabled={checkout.isPending}>
                  Upgrade to Business
                </Button>
              )}
              <Button variant="secondary" onClick={() => portal.mutate()} disabled={portal.isPending}>
                Manage billing
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Usage this month" description="StoryOS never limits records — this is scale, not capability.">
          <UsageRow
            label="Non-AI automation runs"
            used={b.usage.automationRunsThisMonth}
            limit={b.limits.automationRunsPerMonth}
          />
          <UsageRow
            label="Members"
            used={b.usage.billableSeats}
            limit={b.limits.includedSeats}
            suffix={
              b.limits.includedSeats !== null && b.usage.billableSeats >= b.limits.includedSeats
                ? '— next member adds $12/mo'
                : undefined
            }
          />
        </Section>

        <Section title="Your own AI" description="Connect your own Claude or ChatGPT over MCP.">
          <div className="rounded-[var(--radius-control)] border border-border-default bg-card p-4 text-[13px]">
            <p className="font-medium text-ink">Unlimited, and never metered</p>
            <p className="mt-1 text-muted">
              Runs driven by your own AI provider never count against any allowance on any plan and
              are never billed by StoryOS — on Free, Pro, or Business alike. Connect one under API
              tokens.
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border-default pb-8 last:border-b-0 last:pb-0">
      <h2 className="mb-1 text-sm font-medium text-ink">{title}</h2>
      {description && <p className="mb-3 text-[13px] text-muted">{description}</p>}
      {children}
    </section>
  );
}

/** `limit === null` means unlimited (self-host/enterprise) — no bar, just the count. */
function UsageRow({ label, used, limit, suffix }: { label: string; used: number; limit: number | null; suffix?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over80 = limit !== null && pct >= 80;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-ink-secondary">{label}</span>
        <span className={over80 ? 'font-medium text-warning' : 'text-muted'}>
          {used} {limit !== null ? `/ ${limit}` : '(unlimited)'} {suffix && <span className="text-faint">{suffix}</span>}
        </span>
      </div>
      {limit !== null && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hover">
          <div
            className={`h-full rounded-full ${over80 ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
