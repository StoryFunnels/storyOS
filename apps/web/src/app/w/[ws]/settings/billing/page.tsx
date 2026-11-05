'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import posthog from 'posthog-js';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsRow } from '@/components/settings/settings-chrome';
import { useDateFormat } from '@/lib/preferences';
import { settingsPageHref } from '@/lib/settings-nav';
import {
  BILLING_COPY,
  BILLING_UNAVAILABLE,
  OWN_AI_COPY,
  UPGRADE_LABEL,
  canStartTrial,
  upgradeTargets,
  type BillingPlan,
} from '@/lib/billing-view';

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
  plan: BillingPlan;
  status: string | null;
  seats: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  enabled: boolean;
  usage: { automationRunsThisMonth: number; billableSeats: number };
  limits: { automationRunsPerMonth: number | null; includedSeats: number | null };
}

/**
 * Plan & billing. What is offered and said per plan and per deployment is decided in `lib/billing-view.ts` (ticket #1186), which has
 * the tests: an upgrade only to a plan above yours (Enterprise sees none), the "Your own AI" card pointing at Connect your AI, and
 * self-hosting wording only in the self-managed state.
 */
export default function BillingPage() {
  const fmt = useDateFormat();
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

  if (billing.isLoading) return <div className="p-4 text-body text-muted sm:p-8">Loading…</div>;
  if (!billing.data) return null;
  const b = billing.data;

  // #490 — `enabled` reflects whether Stripe is configured on this instance at
  // all (billing.controller.ts's own comment). The settings nav already hides
  // this link when it's false (layout.tsx), so anyone here arrived by direct
  // navigation — a bookmark, a shared link. Matches referrals/page.tsx's
  // identical pattern for the identical reason, per Otto's ruling on this
  // ticket: an explicit unavailable state, not a 404 or a page that pretends
  // this feature doesn't exist. The CTAs below never render at all in
  // this branch — not disabled, absent — so there is no enabled-looking
  // control that cannot work.
  if (!b.enabled) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <SettingsPageHeader title="Plan & billing" />
        <p className="text-body text-muted">{BILLING_UNAVAILABLE}</p>
      </div>
    );
  }

  const trialDaysLeft = b.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86_400_000))
    : null;
  const isTrialing = b.status === 'trialing' && trialDaysLeft !== null;
  const upgrades = upgradeTargets(b.plan);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader title="Plan & billing" lead={BILLING_COPY.lead} />

      <SettingsPageBody>
        {isTrialing && (
          <div className="rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3 text-body">
            <p className="font-medium text-ink">
              {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left of your Pro trial
            </p>
            <p className="mt-1 text-muted">{BILLING_COPY.trial}</p>
          </div>
        )}

        <SettingsBox title="Your plan">
          <SettingsRow
            title={PLAN_LABEL[b.plan]}
            description={
              <>
                {PLAN_PRICE[b.plan]}
                {b.currentPeriodEnd && ` · ${b.cancelAtPeriodEnd ? 'Cancels' : 'Renews'} ${fmt.date(b.currentPeriodEnd)}`}
              </>
            }
          >
            {canStartTrial(b.plan, b.trialEndsAt) && (
              <Button variant="secondary" size="sm" onClick={() => startTrial.mutate()} disabled={startTrial.isPending}>
                Start 30-day Pro trial
              </Button>
            )}
            {upgrades.map((target) => (
              <Button key={target} size="sm" onClick={() => checkout.mutate(target)} disabled={checkout.isPending}>
                {UPGRADE_LABEL[target]}
              </Button>
            ))}
            <Button variant="secondary" size="sm" onClick={() => portal.mutate()} disabled={portal.isPending}>
              Manage billing
            </Button>
          </SettingsRow>
        </SettingsBox>

        <SettingsBox title="Usage this month" aside={BILLING_COPY.usageDescription}>
          <div className="flex flex-col gap-3 px-3.5 py-3">
            <UsageRow
              label="Non-AI automation runs"
              used={b.usage.automationRunsThisMonth}
              limit={b.limits.automationRunsPerMonth}
            />
            <UsageRow
              label="Billable seats"
              used={b.usage.billableSeats}
              limit={b.limits.includedSeats}
              suffix={
                b.limits.includedSeats !== null && b.usage.billableSeats >= b.limits.includedSeats
                  ? '— next seat adds $12/mo'
                  : undefined
              }
              caption={
                <>
                  {BILLING_COPY.seatsBefore}{' '}
                  <Link href={settingsPageHref(ws, 'members')} className="underline hover:text-ink">
                    {BILLING_COPY.seatsLink}
                  </Link>{' '}
                  {BILLING_COPY.seatsAfter}
                </>
              }
            />
          </div>
        </SettingsBox>

        <SettingsBox title={OWN_AI_COPY.title} aside={OWN_AI_COPY.description}>
          <SettingsRow
            title={OWN_AI_COPY.headline}
            description={
              <>
                {OWN_AI_COPY.body} {OWN_AI_COPY.setUpPrefix}{' '}
                <Link href={settingsPageHref(ws, 'connect-ai')} className="underline hover:text-ink">
                  {OWN_AI_COPY.linkLabel}
                </Link>
                .
              </>
            }
          />
        </SettingsBox>
      </SettingsPageBody>
    </div>
  );
}

/** `limit === null` means unlimited — no bar, just the count. */
function UsageRow({
  label,
  used,
  limit,
  suffix,
  caption,
}: {
  label: string;
  used: number;
  limit: number | null;
  suffix?: string;
  /** #489 — a correct-but-terse label still leaves "why is this lower than the members
   *  page" unanswered. Always visible, not a hover-only tooltip, since the reading that
   *  sends someone to support is the one where they never thought to hover. */
  caption?: React.ReactNode;
}) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over80 = limit !== null && pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between text-body">
        <span className="text-ink-secondary">{label}</span>
        <span className={over80 ? 'font-medium text-warning-text' : 'text-muted'}>
          {used} {limit !== null ? `/ ${limit}` : '(unlimited)'} {suffix && <span className="text-muted">{suffix}</span>}
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
      {caption && <p className="mt-1 text-label text-muted">{caption}</p>}
    </div>
  );
}
